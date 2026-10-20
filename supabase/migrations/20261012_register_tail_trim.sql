-- Apply after 20261011_document_sort.sql. No Sheets writes occur inside this migration.
BEGIN;
ALTER TABLE public.register_state ADD COLUMN allocation_floor INT NOT NULL DEFAULT 100;
UPDATE public.register_state SET allocation_floor=greatest(100,coalesce((SELECT max(split_part(surat_number,'.',1)::int) FROM public.documents WHERE letter_date IS NULL AND surat_number ~ '^[1-9][0-9]*(\.([a-z]+|[1-9][0-9]*))?$'),100)) WHERE id=1;
ALTER TABLE public.register_days ADD COLUMN tail_trimmed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.letter_slots ADD COLUMN retiring BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE public.document_deletion_receipts (
 document_id INT PRIMARY KEY,
 created_by UUID,
 requested_by UUID, 
 surat_number TEXT NOT NULL,
 letter_date DATE NOT NULL,
 tail_trim BOOLEAN NOT NULL DEFAULT false,
 completed BOOLEAN NOT NULL DEFAULT false
);
ALTER TABLE public.document_deletion_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_deletion_receipts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.document_deletion_receipts TO service_role;
-- Carry already queued deletions forward without pretending an absent slot was cleared.
-- Old audits did not retain document ownership; these receipts are admin-readable only.
INSERT INTO public.document_deletion_receipts(document_id,created_by,requested_by,surat_number,letter_date)
SELECT DISTINCT ON (s.number,s.letter_date) a.target_id::int,NULL,s.release_requested_by,s.number,s.letter_date
FROM public.audit_logs a JOIN public.letter_slots s ON s.number=a.details->>'surat_number' AND s.letter_date=(a.details->>'letter_date')::date
WHERE a.action='DELETE_DOC' AND a.target_id ~ '^[0-9]+$' AND s.release_pending
ORDER BY s.number,s.letter_date,a.id DESC;

CREATE FUNCTION public.get_document_deletion_status(p_user_id UUID,p_document_id INT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actor users%ROWTYPE; receipt document_deletion_receipts%ROWTYPE;
BEGIN
 SELECT * INTO actor FROM users WHERE id=p_user_id FOR SHARE;
 IF NOT FOUND OR actor.status<>'approved' OR actor.role NOT IN ('user','admin','superadmin') THEN RAISE EXCEPTION 'FORBIDDEN: approved account required'; END IF;
 SELECT * INTO receipt FROM document_deletion_receipts WHERE document_id=p_document_id;
 IF NOT FOUND OR (actor.role='user' AND receipt.created_by IS DISTINCT FROM p_user_id) THEN RAISE EXCEPTION 'NOT_FOUND: deletion receipt not found'; END IF;
 RETURN jsonb_build_object('releasePending',NOT receipt.completed,'trimmed',receipt.tail_trim AND receipt.completed);
END $$;

CREATE OR REPLACE FUNCTION public.delete_registered_document(p_user_id UUID,p_document_id INT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actor users%ROWTYPE; doc documents%ROWTYPE; slot letter_slots%ROWTYPE; receipt document_deletion_receipts%ROWTYPE; ordinal JSONB; surviving_base INT; tail BOOLEAN;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 SELECT * INTO actor FROM users WHERE id=p_user_id FOR SHARE;
 IF NOT FOUND OR actor.status<>'approved' OR actor.role NOT IN ('user','admin','superadmin') THEN RAISE EXCEPTION 'FORBIDDEN: approved account required'; END IF;
 SELECT * INTO receipt FROM document_deletion_receipts WHERE document_id=p_document_id;
 IF FOUND THEN
  IF actor.role='user' AND receipt.created_by IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'NOT_FOUND: document not found'; END IF;
  RETURN jsonb_build_object('suratNumber',receipt.surat_number,'letterDate',receipt.letter_date,'releasePending',NOT receipt.completed,'trimmed',receipt.tail_trim AND receipt.completed);
 END IF;
 SELECT * INTO doc FROM documents WHERE id=p_document_id FOR UPDATE;
 IF NOT FOUND OR (actor.role='user' AND doc.created_by IS DISTINCT FROM p_user_id) THEN RAISE EXCEPTION 'NOT_FOUND: document not found'; END IF;
 IF doc.letter_date IS NULL THEN RAISE EXCEPTION 'LEGACY_READ_ONLY: undated documents cannot be deleted'; END IF;
 PERFORM 1 FROM register_state WHERE id=1 FOR UPDATE;
 PERFORM 1 FROM register_days WHERE letter_date=doc.letter_date FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'REGISTER_SLOT_MISMATCH: register day missing'; END IF;
 SELECT * INTO slot FROM letter_slots WHERE document_id=doc.id FOR UPDATE;
 IF NOT FOUND OR slot.number<>doc.surat_number OR slot.letter_date<>doc.letter_date OR NOT slot.occupied OR slot.release_pending OR slot.retiring THEN RAISE EXCEPTION 'REGISTER_SLOT_MISMATCH: matching occupied slot required'; END IF;
 ordinal := slot."values"->0;
 IF ordinal IS NULL OR ordinal='null'::jsonb OR ordinal='""'::jsonb THEN
  SELECT to_jsonb(count(*)+1) INTO ordinal FROM letter_slots WHERE letter_date=slot.letter_date AND NOT retiring AND (base_number,suffix_index,number)<(slot.base_number,slot.suffix_index,slot.number);
 END IF;
 UPDATE letter_slots SET document_id=NULL,occupied=true,release_pending=true,release_requested_by=p_user_id,
  "values"=jsonb_build_array(ordinal,'','/',slot.number,'/','','','',false,false,false,false) WHERE number=slot.number;
 DELETE FROM documents WHERE id=doc.id;
 SELECT greatest(coalesce((SELECT max(base_number) FROM letter_slots WHERE occupied AND NOT retiring AND number<>slot.number),0),coalesce((SELECT max(split_part(surat_number,'.',1)::int) FROM documents WHERE surat_number ~ '^[1-9][0-9]*(\.([a-z]+|[1-9][0-9]*))?$'),0)) INTO surviving_base;
 tail := surviving_base<=slot.base_number AND NOT EXISTS(SELECT 1 FROM letter_slots WHERE occupied AND NOT retiring AND number<>slot.number AND (base_number,suffix_index,number)>(slot.base_number,slot.suffix_index,slot.number));
 INSERT INTO document_deletion_receipts(document_id,created_by,requested_by,surat_number,letter_date,tail_trim) VALUES(doc.id,doc.created_by,p_user_id,doc.surat_number,doc.letter_date,tail);
 IF tail THEN
  UPDATE letter_slots SET retiring=true WHERE (NOT occupied AND base_number>surviving_base) OR number=slot.number;
  -- Retain empty days as dirty tombstones so all affected monthly projections get cleared.
  UPDATE register_days d SET tail_trimmed=true,revision=revision+1 WHERE EXISTS(SELECT 1 FROM letter_slots s WHERE s.letter_date=d.letter_date AND s.retiring);
 ELSE
  UPDATE register_days SET revision=revision+1 WHERE letter_date=doc.letter_date;
 END IF;
 INSERT INTO audit_logs(user_id,action,target_id,details) VALUES(p_user_id,'DELETE_DOC',doc.id::text,jsonb_build_object('surat_number',doc.surat_number,'letter_date',doc.letter_date,'tail_trim',tail));
 RETURN jsonb_build_object('suratNumber',doc.surat_number,'letterDate',doc.letter_date,'releasePending',true,'trimmed',false);
END $$;

CREATE OR REPLACE FUNCTION public.acknowledge_register_days(p_owner UUID,p_days JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE day RECORD; acknowledged INT := 0; high_water INT;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 PERFORM 1 FROM register_sync_lease WHERE id=1 AND owner=p_owner AND expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 FOR day IN SELECT d.letter_date FROM register_days d JOIN jsonb_to_recordset(p_days) x(letter_date date,revision bigint) ON d.letter_date=x.letter_date AND d.revision=x.revision ORDER BY d.letter_date FOR UPDATE OF d LOOP
  UPDATE register_days SET synced_revision=revision WHERE letter_date=day.letter_date;
  UPDATE document_deletion_receipts r SET completed=true WHERE NOT r.completed AND NOT r.tail_trim AND r.letter_date=day.letter_date AND EXISTS(SELECT 1 FROM letter_slots s WHERE s.number=r.surat_number AND s.release_pending AND NOT s.retiring AND s.document_id IS NULL);
  UPDATE letter_slots SET occupied=false,release_pending=false,release_requested_by=NULL WHERE letter_date=day.letter_date AND release_pending AND NOT retiring AND document_id IS NULL;
  acknowledged := acknowledged+1;
 END LOOP;
 IF EXISTS(SELECT 1 FROM letter_slots WHERE retiring) AND NOT EXISTS(SELECT 1 FROM register_days d JOIN letter_slots s USING(letter_date) WHERE s.retiring AND d.revision<>d.synced_revision) THEN
  -- All retiring days are confirmed under this writer lease; no new numbers were extended.
  DELETE FROM letter_slots WHERE retiring AND document_id IS NULL;
  SELECT greatest(allocation_floor,coalesce((SELECT max(base_number) FROM letter_slots),0),coalesce((SELECT max(split_part(surat_number,'.',1)::int) FROM documents WHERE surat_number ~ '^[1-9][0-9]*(\.([a-z]+|[1-9][0-9]*))?$'),0)) INTO high_water FROM register_state WHERE id=1 FOR UPDATE;
  UPDATE register_state SET current_number=high_water WHERE id=1;
  UPDATE document_deletion_receipts SET completed=true WHERE tail_trim AND NOT completed;
 END IF;
 RETURN acknowledged=jsonb_array_length(p_days);
END $$;

CREATE OR REPLACE FUNCTION public.reserve_letter_slots(p_date DATE,p_count INT)
RETURNS VOID LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE high_water INT;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 IF p_count<=0 THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM letter_slots WHERE retiring) THEN RAISE EXCEPTION 'REGISTER_TRIM_PENDING: Pengosongan nomor terakhir belum dikonfirmasi Google Sheets'; END IF;
 IF p_count>10000 THEN RAISE EXCEPTION 'INVALID_INPUT: reservation too large'; END IF;
 SELECT current_number INTO high_water FROM register_state WHERE id=1 FOR UPDATE;
 INSERT INTO letter_slots(number,letter_date,base_number)
 SELECT (high_water+n)::text,p_date,high_water+n FROM generate_series(1,p_count) AS n;
 UPDATE register_state SET current_number=high_water+p_count WHERE id=1;
 UPDATE register_days SET revision=revision+1 WHERE letter_date=p_date;
END $$;

CREATE OR REPLACE FUNCTION public.initialize_letter_register(p_rows JSONB,p_today DATE)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE item JSONB; number_text TEXT; day DATE; base INT; suffix INT; ch TEXT; old_state register_state%ROWTYPE; max_day DATE; min_day DATE; high_water INT;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 SELECT * INTO old_state FROM register_state WHERE id=1 FOR UPDATE;
 IF old_state.initialized THEN RETURN false; END IF;
 UPDATE register_state SET allocation_floor=greatest(100,old_state.current_number,coalesce((SELECT max(split_part(surat_number,'.',1)::int) FROM documents WHERE surat_number ~ '^[1-9][0-9]*(\.([a-z]+|[1-9][0-9]*))?$'),100)) WHERE id=1;
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

CREATE OR REPLACE FUNCTION public.apply_register_day_total(p_date DATE,p_total INT,p_custom BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE day register_days%ROWTYPE; ordinary_count INT;
BEGIN
 IF p_total IS NULL OR p_total NOT BETWEEN 1 AND 400 OR p_custom IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT: Jumlah nomor harian tidak valid'; END IF;
 SELECT * INTO STRICT day FROM register_days WHERE letter_date=p_date FOR UPDATE;
 SELECT count(*) INTO ordinary_count FROM letter_slots WHERE letter_date=p_date AND suffix_index=0;
 IF day.fixed_reservation OR day.closed THEN
  IF p_custom AND NOT day.tail_trimmed AND ordinary_count<>p_total THEN RAISE EXCEPTION 'REGISTER_CONFLICT: Rencana % nomor tanggal % tidak sesuai dengan rentang tetap % nomor',p_total,p_date,ordinary_count; END IF;
  RETURN;
 END IF;
 IF p_custom AND ordinary_count>p_total THEN RAISE EXCEPTION 'TARGET_TOO_SMALL: Rencana tanggal % lebih kecil dari % nomor yang sudah tersedia',p_date,ordinary_count; END IF;
 IF ordinary_count<p_total THEN
  IF EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>p_date) THEN RAISE EXCEPTION 'REGISTER_CONFLICT: Rentang tanggal % tidak dapat diperluas melewati rentang berikutnya',p_date; END IF;
  PERFORM reserve_letter_slots(p_date,p_total-ordinary_count);
 END IF;
 UPDATE register_days SET fixed_reservation=true,revision=revision+1 WHERE letter_date=p_date AND NOT fixed_reservation;
END $$;

CREATE OR REPLACE FUNCTION public.close_letter_days(p_today DATE DEFAULT (now() AT TIME ZONE 'Asia/Jakarta')::date)
RETURNS VOID LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE state register_state%ROWTYPE; settings register_settings%ROWTYPE; day DATE; frozen BOOLEAN; unused INT; finish DATE; target INT;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 SELECT * INTO state FROM register_state WHERE id=1 FOR UPDATE;
 IF NOT state.initialized THEN RAISE EXCEPTION 'REGISTER_NOT_INITIALIZED'; END IF;
 IF p_today IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT: Tanggal penutupan wajib diisi'; END IF;
 SELECT * INTO STRICT settings FROM register_settings WHERE id=1;
 -- Import may advance closed_through past a plan before this loop can see it.
 IF EXISTS(SELECT 1 FROM register_day_targets t WHERE t.letter_date<=state.closed_through
  AND NOT EXISTS(SELECT 1 FROM register_days d WHERE d.letter_date=t.letter_date AND d.tail_trimmed)
  AND t.total<>(SELECT count(*) FROM letter_slots s WHERE s.letter_date=t.letter_date AND s.suffix_index=0)) THEN
  RAISE EXCEPTION 'REGISTER_CONFLICT: Rencana tanggal yang sudah ditutup tidak sesuai dengan rentang impor. Hapus rencana yang bertentangan tanpa mengubah nomor';
 END IF;
 finish := least(p_today-1,DATE '2026-12-31');
 day := greatest(coalesce(state.closed_through+1,state.start_date,p_today),DATE '2026-01-01');
 WHILE day<=finish LOOP
  INSERT INTO register_days(letter_date) VALUES(day) ON CONFLICT DO NOTHING;
  SELECT total INTO target FROM register_day_targets WHERE letter_date=day;
  IF (SELECT tail_trimmed FROM register_days WHERE letter_date=day) THEN
   NULL; -- Trimmed ranges stay closed without resurrecting their old reservations.
  ELSIF target IS NOT NULL THEN
   PERFORM apply_register_day_total(day,target,true);
  ELSE
   SELECT fixed_reservation OR closed INTO frozen FROM register_days WHERE letter_date=day;
   IF NOT frozen THEN
    SELECT count(*) INTO unused FROM letter_slots WHERE letter_date=day AND NOT occupied;
    IF unused<settings.closing_unused_minimum THEN
     IF EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>day) THEN RAISE EXCEPTION 'REGISTER_CONFLICT: Rentang tanggal % tidak dapat diperluas melewati rentang berikutnya',day; END IF;
     PERFORM reserve_letter_slots(day,settings.closing_unused_minimum-unused);
    END IF;
   END IF;
  END IF;
  UPDATE register_days SET closed=true,revision=revision+1 WHERE letter_date=day AND NOT closed;
  UPDATE register_state SET closed_through=day WHERE id=1;
  day := day+1;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.create_registered_document(p_user_id UUID,p_date DATE,p_title TEXT,p_metadata JSONB,p_emergency BOOLEAN DEFAULT false,p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE today DATE := (now() AT TIME ZONE 'Asia/Jakarta')::date; state register_state%ROWTYPE; settings register_settings%ROWTYPE; u users%ROWTYPE; slot letter_slots%ROWTYPE; day DATE; target INT; base INT; next_suffix INT; suffix TEXT; n INT; doc documents%ROWTYPE; emergency_allocated BOOLEAN := false;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 SELECT * INTO u FROM users WHERE id=p_user_id FOR SHARE;
 IF NOT FOUND OR u.status<>'approved' THEN RAISE EXCEPTION 'FORBIDDEN: approved account required'; END IF;
 IF p_emergency AND (u.role NOT IN ('admin','superadmin') OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 500) THEN RAISE EXCEPTION 'FORBIDDEN: administrator confirmation and reason required'; END IF;
 p_metadata := validate_registered_letter_fields(p_date,p_title,p_metadata);
 SELECT * INTO state FROM register_state WHERE id=1 FOR UPDATE;
 IF NOT state.initialized THEN RAISE EXCEPTION 'REGISTER_NOT_INITIALIZED'; END IF;
 PERFORM close_letter_days(today);
 SELECT * INTO STRICT settings FROM register_settings WHERE id=1;
 IF p_date>today THEN
  day := today;
  WHILE day<p_date LOOP
   INSERT INTO register_days(letter_date) VALUES(day) ON CONFLICT DO NOTHING;
   SELECT total INTO target FROM register_day_targets WHERE letter_date=day;
   -- Explicit forward allocation realizes empty open days again, but never refills a surviving range.
   IF NOT EXISTS(SELECT 1 FROM letter_slots WHERE retiring)
    AND NOT EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>=day) THEN
    UPDATE register_days SET tail_trimmed=false,fixed_reservation=false
    WHERE letter_date=day AND tail_trimmed AND NOT closed;
   END IF;
   -- Shared helper never applies changed defaults to a fixed/closed range.
   IF NOT (SELECT tail_trimmed FROM register_days WHERE letter_date=day) THEN
    PERFORM apply_register_day_total(day,coalesce(target,settings.future_daily_total),target IS NOT NULL);
   END IF;
   day := day+1;
  END LOOP;
 END IF;
 INSERT INTO register_days(letter_date) SELECT p_date WHERE p_date>=today ON CONFLICT DO NOTHING;
 -- Explicit allocation may reactivate the selected open date and its saved plan.
 IF p_date>=today AND NOT EXISTS(SELECT 1 FROM letter_slots WHERE retiring)
  AND NOT EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>p_date) THEN
  UPDATE register_days SET tail_trimmed=false,fixed_reservation=false
  WHERE letter_date=p_date AND tail_trimmed AND NOT closed;
 END IF;
 SELECT total INTO target FROM register_day_targets WHERE letter_date=p_date;
 IF target IS NOT NULL AND EXISTS(SELECT 1 FROM register_days WHERE letter_date=p_date) THEN
  PERFORM apply_register_day_total(p_date,target,true);
 END IF;
 SELECT * INTO slot FROM letter_slots WHERE letter_date=p_date AND NOT occupied AND NOT retiring ORDER BY base_number,suffix_index LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN
  IF p_date>=today AND NOT EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>p_date) AND NOT coalesce((SELECT fixed_reservation OR closed FROM register_days WHERE letter_date=p_date),true) THEN
   PERFORM reserve_letter_slots(p_date,1);
   SELECT * INTO slot FROM letter_slots WHERE letter_date=p_date AND NOT occupied ORDER BY base_number,suffix_index LIMIT 1 FOR UPDATE;
  ELSE
   IF EXISTS(SELECT 1 FROM letter_slots WHERE retiring AND letter_date=p_date) THEN RAISE EXCEPTION 'REGISTER_TRIM_PENDING: Pengosongan nomor terakhir belum dikonfirmasi Google Sheets'; END IF;
   SELECT max(base_number) INTO base FROM letter_slots WHERE letter_date=p_date AND NOT retiring;
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
  INSERT INTO audit_logs(user_id,action,target_id,details) VALUES(p_user_id,'EMERGENCY_ALLOCATION',doc.id::TEXT,jsonb_build_object('surat_number',slot.number,'date',p_date,'reason',p_reason));
 END IF;
 RETURN to_jsonb(doc);
END $$;

CREATE OR REPLACE FUNCTION public.get_register_month(p_month INT)
RETURNS JSONB STABLE LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE first_day DATE; next_month DATE;
BEGIN
 IF p_month NOT BETWEEN 1 AND 12 THEN RAISE EXCEPTION 'INVALID_INPUT: month'; END IF;
 first_day := make_date(2026,p_month,1); next_month := (first_day+interval '1 month')::date;
 RETURN jsonb_build_object(
  'days',coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY letter_date) FROM register_days d WHERE letter_date>=first_day AND letter_date<next_month),'[]'::jsonb),
  'slots',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY base_number,suffix_index,number) FROM letter_slots s WHERE NOT retiring AND letter_date>=first_day AND letter_date<next_month),'[]'::jsonb),
  'documents',coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d WHERE letter_date>=first_day AND letter_date<next_month),'[]'::jsonb)
 );
END $$;

REVOKE ALL ON FUNCTION public.get_document_deletion_status(UUID,INT),public.delete_registered_document(UUID,INT),public.acknowledge_register_days(UUID,JSONB),public.reserve_letter_slots(DATE,INT),public.initialize_letter_register(JSONB,DATE),public.apply_register_day_total(DATE,INT,BOOLEAN),public.close_letter_days(DATE),public.create_registered_document(UUID,DATE,TEXT,JSONB,BOOLEAN,TEXT),public.get_register_month(INT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_document_deletion_status(UUID,INT),public.delete_registered_document(UUID,INT),public.acknowledge_register_days(UUID,JSONB),public.reserve_letter_slots(DATE,INT),public.initialize_letter_register(JSONB,DATE),public.apply_register_day_total(DATE,INT,BOOLEAN),public.close_letter_days(DATE),public.create_registered_document(UUID,DATE,TEXT,JSONB,BOOLEAN,TEXT),public.get_register_month(INT) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
