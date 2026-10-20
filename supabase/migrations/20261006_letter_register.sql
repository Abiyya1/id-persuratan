-- Apply after schema.sql, before deploying the monthly-register application.
-- Additive migration: legacy undated documents remain readable and retain their IDs.
BEGIN;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS surat_number TEXT;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS letter_date DATE;
UPDATE public.documents SET surat_number = id::text WHERE surat_number IS NULL;
ALTER TABLE public.documents ALTER COLUMN surat_number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS documents_surat_number_idx ON public.documents(surat_number);
CREATE INDEX IF NOT EXISTS documents_letter_date_idx ON public.documents(letter_date);

CREATE TABLE IF NOT EXISTS public.satkers (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 name TEXT NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX IF NOT EXISTS satkers_name_lower_idx ON public.satkers(lower(name));
INSERT INTO public.satkers(name) SELECT 'Pusdatin' WHERE NOT EXISTS (SELECT 1 FROM public.satkers WHERE lower(name)='pusdatin');

CREATE TABLE IF NOT EXISTS public.register_state (
 id INT PRIMARY KEY CHECK(id=1),
 current_number INT NOT NULL DEFAULT 100,
 initialized BOOLEAN NOT NULL DEFAULT false,
 start_date DATE,
 closed_through DATE,
 year INT NOT NULL DEFAULT 2026 CHECK(year=2026)
);
INSERT INTO public.register_state(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.register_days (
 letter_date DATE PRIMARY KEY CHECK(letter_date BETWEEN DATE '2026-01-01' AND DATE '2026-12-31'),
 fixed_reservation BOOLEAN NOT NULL DEFAULT false,
 closed BOOLEAN NOT NULL DEFAULT false,
 revision BIGINT NOT NULL DEFAULT 1,
 synced_revision BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS public.letter_slots (
 number TEXT PRIMARY KEY CHECK(number ~ '^[1-9][0-9]*(\.([a-z]+|[1-9][0-9]*))?$'),
 letter_date DATE NOT NULL REFERENCES public.register_days(letter_date),
 base_number INT NOT NULL CHECK(base_number>0),
 suffix_index INT NOT NULL DEFAULT 0 CHECK(suffix_index>=0),
 occupied BOOLEAN NOT NULL DEFAULT false,
 document_id INT UNIQUE REFERENCES public.documents(id),
 "values" JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof("values")='array'),
 CHECK(document_id IS NULL OR occupied)
);
CREATE INDEX IF NOT EXISTS letter_slots_date_idx ON public.letter_slots(letter_date,base_number,suffix_index);
CREATE TABLE IF NOT EXISTS public.register_sync_lease (
 id INT PRIMARY KEY CHECK(id=1), owner UUID, expires_at TIMESTAMPTZ
);
INSERT INTO public.register_sync_lease(id) VALUES(1) ON CONFLICT DO NOTHING;
ALTER TABLE public.satkers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.register_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.register_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.letter_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.register_sync_lease ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.satkers, public.register_state, public.register_days, public.letter_slots, public.register_sync_lease TO service_role;

-- Internal helper; caller must hold the transaction-scoped allocator lock.
CREATE OR REPLACE FUNCTION public.reserve_letter_slots(p_date DATE,p_count INT)
RETURNS VOID LANGUAGE plpgsql SET search_path=public AS $$
DECLARE high_water INT;
BEGIN
 IF p_count<=0 THEN RETURN; END IF;
 IF p_count>10000 THEN RAISE EXCEPTION 'INVALID_INPUT: reservation too large'; END IF;
 SELECT current_number INTO high_water FROM register_state WHERE id=1 FOR UPDATE;
 INSERT INTO letter_slots(number,letter_date,base_number)
 SELECT (high_water+n)::text,p_date,high_water+n FROM generate_series(1,p_count) AS n;
 UPDATE register_state SET current_number=high_water+p_count WHERE id=1;
 UPDATE register_days SET revision=revision+1 WHERE letter_date=p_date;
END $$;

-- Close dates before p_today; WIB23:59 supplies tomorrow. Repeated/missed runs are safe.
CREATE OR REPLACE FUNCTION public.close_letter_days(p_today DATE DEFAULT (now() AT TIME ZONE 'Asia/Jakarta')::date)
RETURNS VOID LANGUAGE plpgsql SET search_path=public AS $$
DECLARE state register_state%ROWTYPE; day DATE; fixed BOOLEAN; unused INT; finish DATE;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 SELECT * INTO state FROM register_state WHERE id=1 FOR UPDATE;
 IF NOT state.initialized THEN RAISE EXCEPTION 'REGISTER_NOT_INITIALIZED'; END IF;
 finish := least(p_today-1, DATE '2026-12-31');
 day := greatest(coalesce(state.closed_through+1,state.start_date,p_today),DATE '2026-01-01');
 WHILE day<=finish LOOP
  INSERT INTO register_days(letter_date) VALUES(day) ON CONFLICT DO NOTHING;
  SELECT fixed_reservation INTO fixed FROM register_days WHERE letter_date=day;
  IF NOT fixed THEN
   SELECT count(*) INTO unused FROM letter_slots WHERE letter_date=day AND NOT occupied;
   IF unused<15 THEN
    IF EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>day) THEN
     RAISE EXCEPTION 'INVALID_INPUT: earlier day has no expandable range';
    END IF;
    PERFORM reserve_letter_slots(day,15-unused);
   END IF;
  END IF;
  UPDATE register_days SET closed=true, revision=revision+1 WHERE letter_date=day AND NOT closed;
  UPDATE register_state SET closed_through=day WHERE id=1;
  day := day+1;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.initialize_letter_register(p_rows JSONB,p_today DATE)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public AS $$
DECLARE item JSONB; number_text TEXT; day DATE; base INT; suffix INT; ch TEXT; old_state register_state%ROWTYPE; max_day DATE; min_day DATE; high_water INT;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 SELECT * INTO old_state FROM register_state WHERE id=1 FOR UPDATE;
 IF old_state.initialized THEN RETURN false; END IF;
 IF p_today NOT BETWEEN DATE '2026-01-01' AND DATE '2026-12-31' OR jsonb_typeof(p_rows)<>'array' THEN RAISE EXCEPTION 'INVALID_INPUT: 2026 bootstrap required'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  number_text := item->>'number'; day := (item->>'date')::date;
  IF number_text IS NULL OR number_text !~ '^[1-9][0-9]*(\.([a-z]+|[1-9][0-9]*))?$' OR day IS NULL OR day NOT BETWEEN DATE '2026-01-01' AND DATE '2026-12-31' OR jsonb_typeof(item->'values')<>'array' OR jsonb_typeof(item->'occupied')<>'boolean' THEN
   RAISE EXCEPTION 'INVALID_INPUT: malformed imported register row';
  END IF;
  base := split_part(number_text,'.',1)::int; suffix := 0;
  IF strpos(number_text,'.')>0 THEN
   IF split_part(number_text,'.',2) ~ '^[0-9]+$' THEN
    suffix := split_part(number_text,'.',2)::int;
   ELSE
    FOREACH ch IN ARRAY regexp_split_to_array(split_part(number_text,'.',2),'') LOOP
     suffix := suffix*26+ascii(ch)-96;
    END LOOP;
   END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM documents WHERE surat_number=number_text) THEN RAISE EXCEPTION 'INVALID_INPUT: imported number already belongs to an application document'; END IF;
  INSERT INTO register_days(letter_date,closed) VALUES(day,day<p_today) ON CONFLICT DO NOTHING;
  INSERT INTO letter_slots(number,letter_date,base_number,suffix_index,occupied,"values")
  VALUES(number_text,day,base,suffix,(item->>'occupied')::boolean,item->'values');
 END LOOP;
 -- Chronological ranges may have gaps, but never overlap or run backwards.
 IF EXISTS(SELECT 1 FROM letter_slots a JOIN letter_slots b ON a.letter_date<b.letter_date AND a.base_number>b.base_number) THEN
  RAISE EXCEPTION 'INVALID_INPUT: imported numbering goes backwards across dates';
 END IF;
 SELECT max(letter_date),min(letter_date),max(base_number) INTO max_day,min_day,high_water FROM letter_slots;
 SELECT greatest(coalesce(high_water,100),coalesce(max(split_part(surat_number,'.',1)::int),100)) INTO high_water FROM documents;
 UPDATE register_state SET initialized=true,current_number=high_water,start_date=coalesce(min_day,p_today),closed_through=coalesce(least(max_day,p_today-1),p_today-1) WHERE id=1;
 -- Imported future dates must already reserve each intervening date: never renumber existing letters.
 IF EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>=p_today) THEN
  IF EXISTS(SELECT 1 FROM generate_series(p_today::timestamp,max_day::timestamp,interval '1 day') d WHERE NOT EXISTS(SELECT 1 FROM register_days WHERE letter_date=d::date)) THEN
   RAISE EXCEPTION 'INVALID_INPUT: imported future ranges have missing intervening dates';
  END IF;
  UPDATE register_days SET fixed_reservation=true WHERE letter_date>=p_today AND letter_date<max_day;
 END IF;
 PERFORM close_letter_days(p_today);
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.create_registered_document(p_user_id UUID,p_date DATE,p_title TEXT,p_metadata JSONB,p_emergency BOOLEAN DEFAULT false,p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SET search_path=public AS $$
DECLARE today DATE := (now() AT TIME ZONE 'Asia/Jakarta')::date; state register_state%ROWTYPE; u users%ROWTYPE; slot letter_slots%ROWTYPE; day DATE; count_slots INT; base INT; next_suffix INT; suffix TEXT; n INT; doc documents%ROWTYPE; emergency_allocated BOOLEAN := false;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 SELECT * INTO u FROM users WHERE id=p_user_id;
 IF NOT FOUND OR u.status<>'approved' THEN RAISE EXCEPTION 'FORBIDDEN: approved account required'; END IF;
 IF p_emergency AND (u.role NOT IN ('admin','superadmin') OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 500) THEN RAISE EXCEPTION 'FORBIDDEN: administrator confirmation and reason required'; END IF;
 IF p_date IS NULL OR p_date NOT BETWEEN DATE '2026-01-01' AND DATE '2026-12-31' OR length(btrim(coalesce(p_title,''))) NOT BETWEEN 1 AND 300 OR jsonb_typeof(p_metadata)<>'object' OR coalesce(p_metadata->>'kdSurat','') !~ '^[0-9]{3}(\.[0-9]+){0,3}$' OR length(btrim(coalesce(p_metadata->>'tujuanSurat',''))) NOT BETWEEN 1 AND 500 OR coalesce(p_metadata->>'ket','') NOT IN ('CAT','SRIKANDI','EOFFICE','MANUAL') OR NOT EXISTS(SELECT 1 FROM satkers WHERE name=p_metadata->>'kdSatker') THEN
  RAISE EXCEPTION 'INVALID_INPUT: invalid letter fields or configured year';
 END IF;
 SELECT * INTO state FROM register_state WHERE id=1 FOR UPDATE;
 IF NOT state.initialized THEN RAISE EXCEPTION 'REGISTER_NOT_INITIALIZED'; END IF;
 PERFORM close_letter_days(today);
 IF p_date>today THEN
  day := today;
  WHILE day<p_date LOOP
   INSERT INTO register_days(letter_date) VALUES(day) ON CONFLICT DO NOTHING;
   IF NOT (SELECT closed FROM register_days WHERE letter_date=day) THEN
    SELECT count(*) INTO count_slots FROM letter_slots WHERE letter_date=day AND suffix_index=0;
    IF count_slots<45 THEN
     IF EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>day) THEN RAISE EXCEPTION 'INVALID_INPUT: reserved day cannot expand across a later range'; END IF;
     PERFORM reserve_letter_slots(day,45-count_slots);
    END IF;
    UPDATE register_days SET fixed_reservation=true,revision=revision+1 WHERE letter_date=day AND NOT fixed_reservation;
   END IF;
   day := day+1;
  END LOOP;
 END IF;
 INSERT INTO register_days(letter_date) SELECT p_date WHERE p_date>=today ON CONFLICT DO NOTHING;
 SELECT * INTO slot FROM letter_slots WHERE letter_date=p_date AND NOT occupied ORDER BY base_number,suffix_index LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN
  IF p_date>=today AND NOT EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>p_date) AND NOT coalesce((SELECT fixed_reservation OR closed FROM register_days WHERE letter_date=p_date),true) THEN
   PERFORM reserve_letter_slots(p_date,1);
   SELECT * INTO slot FROM letter_slots WHERE letter_date=p_date AND NOT occupied ORDER BY base_number,suffix_index LIMIT 1 FOR UPDATE;
  ELSE
   SELECT max(base_number) INTO base FROM letter_slots WHERE letter_date=p_date;
   IF base IS NULL THEN RAISE EXCEPTION 'DAY_MISSING: no historical range for this date'; END IF;
   IF NOT p_emergency THEN RAISE EXCEPTION 'DAY_FULL: no unused numbers on this date'; END IF;
   SELECT coalesce(max(suffix_index),0)+1 INTO next_suffix FROM letter_slots WHERE letter_date=p_date AND base_number=base AND number ~ '\.[a-z]+$';
   n := next_suffix; suffix := '';
   WHILE n>0 LOOP suffix := chr(97+(n-1)%26)||suffix; n := (n-1)/26; END LOOP;
   INSERT INTO letter_slots(number,letter_date,base_number,suffix_index) VALUES(base::text||'.'||suffix,p_date,base,next_suffix) RETURNING * INTO slot;
   emergency_allocated := true;
  END IF;
 END IF;
 INSERT INTO documents(id,surat_number,letter_date,title,metadata,created_by,sync_status)
 VALUES(get_next_document_id(),slot.number,p_date,btrim(p_title),p_metadata,p_user_id,'pending') RETURNING * INTO doc;
 UPDATE letter_slots SET occupied=true,document_id=doc.id WHERE number=slot.number;
 UPDATE register_days SET revision=revision+1 WHERE letter_date=p_date;
 IF emergency_allocated THEN
  INSERT INTO audit_logs(user_id,action,target_id,details) VALUES(p_user_id,'EMERGENCY_ALLOCATION',doc.id::text,jsonb_build_object('surat_number',slot.number,'date',p_date,'reason',p_reason));
 END IF;
 RETURN to_jsonb(doc);
END $$;

-- Edits and retries must not mark a newer document version synced.
DROP FUNCTION IF EXISTS public.bump_sync_attempts_and_set_status(INT,TEXT,TEXT);
CREATE OR REPLACE FUNCTION public.bump_sync_attempts_and_set_status(p_document_id INT,p_status TEXT,p_error TEXT,p_expected_updated_at TIMESTAMPTZ DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SET search_path=public AS $$
DECLARE doc documents%ROWTYPE;
BEGIN
 UPDATE documents SET sync_attempts=sync_attempts+1,sync_status=p_status,last_sync_error=CASE WHEN p_status='synced' THEN NULL ELSE p_error END
 WHERE id=p_document_id AND (p_expected_updated_at IS NULL OR updated_at=p_expected_updated_at)
 RETURNING * INTO doc;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN to_jsonb(doc);
END $$;

CREATE OR REPLACE FUNCTION public.touch_letter_revision()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF NEW.letter_date IS NOT NULL AND (OLD.title IS DISTINCT FROM NEW.title OR OLD.metadata IS DISTINCT FROM NEW.metadata) THEN
  UPDATE register_days SET revision=revision+1 WHERE letter_date=NEW.letter_date;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS documents_letter_revision ON public.documents;
CREATE TRIGGER documents_letter_revision AFTER UPDATE ON public.documents FOR EACH ROW EXECUTE FUNCTION public.touch_letter_revision();

CREATE OR REPLACE FUNCTION public.acquire_register_sync(p_owner UUID,p_seconds INT DEFAULT 240)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF p_owner IS NULL THEN RETURN false; END IF;
 UPDATE register_sync_lease SET owner=p_owner,expires_at=clock_timestamp()+make_interval(secs=>least(greatest(p_seconds,30),240))
 WHERE id=1 AND (owner=p_owner OR expires_at IS NULL OR expires_at<=clock_timestamp());
 RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION public.renew_register_sync(p_owner UUID,p_seconds INT DEFAULT 240)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 UPDATE register_sync_lease SET expires_at=clock_timestamp()+make_interval(secs=>least(greatest(p_seconds,30),240))
 WHERE id=1 AND owner=p_owner AND expires_at>clock_timestamp();
 RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION public.release_register_sync(p_owner UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path=public AS $$
BEGIN UPDATE register_sync_lease SET owner=NULL,expires_at=NULL WHERE id=1 AND owner=p_owner; END $$;
CREATE OR REPLACE FUNCTION public.acknowledge_register_days(p_owner UUID,p_days JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 PERFORM 1 FROM register_sync_lease WHERE id=1 AND owner=p_owner AND expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE register_days d SET synced_revision=d.revision FROM jsonb_to_recordset(p_days) x(letter_date date,revision bigint) WHERE d.letter_date=x.letter_date AND d.revision=x.revision;
 RETURN true;
END $$;

-- A single SQL snapshot keeps versions, numbered slots and contents coherent.
CREATE OR REPLACE FUNCTION public.get_register_month(p_month INT)
RETURNS JSONB STABLE LANGUAGE plpgsql SET search_path=public AS $$
DECLARE first_day DATE; next_month DATE;
BEGIN
 IF p_month NOT BETWEEN 1 AND 12 THEN RAISE EXCEPTION 'INVALID_INPUT: month'; END IF;
 first_day := make_date(2026,p_month,1); next_month := (first_day+interval '1 month')::date;
 RETURN jsonb_build_object(
  'days',coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY letter_date) FROM register_days d WHERE letter_date>=first_day AND letter_date<next_month),'[]'::jsonb),
  'slots',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY base_number,suffix_index,number) FROM letter_slots s WHERE letter_date>=first_day AND letter_date<next_month),'[]'::jsonb),
  'documents',coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d WHERE letter_date>=first_day AND letter_date<next_month),'[]'::jsonb)
 );
END $$;
REVOKE ALL ON FUNCTION public.get_register_month(INT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_register_month(INT) TO service_role;

-- Mutations are never available through the public anon key.
REVOKE ALL ON FUNCTION public.reserve_letter_slots(DATE,INT), public.close_letter_days(DATE), public.initialize_letter_register(JSONB,DATE), public.create_registered_document(UUID,DATE,TEXT,JSONB,BOOLEAN,TEXT), public.bump_sync_attempts_and_set_status(INT,TEXT,TEXT,TIMESTAMPTZ), public.acquire_register_sync(UUID,INT), public.renew_register_sync(UUID,INT), public.release_register_sync(UUID), public.acknowledge_register_days(UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_letter_slots(DATE,INT), public.close_letter_days(DATE), public.initialize_letter_register(JSONB,DATE), public.create_registered_document(UUID,DATE,TEXT,JSONB,BOOLEAN,TEXT), public.bump_sync_attempts_and_set_status(INT,TEXT,TEXT,TIMESTAMPTZ), public.acquire_register_sync(UUID,INT), public.renew_register_sync(UUID,INT), public.release_register_sync(UUID), public.acknowledge_register_days(UUID,JSONB) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
