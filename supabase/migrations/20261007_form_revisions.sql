BEGIN;

-- One validator serves allocation and direct content edits; synchronization-only updates bypass the content trigger.
CREATE OR REPLACE FUNCTION public.validate_registered_letter_fields(p_date DATE,p_title TEXT,p_metadata JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path=public AS $$
DECLARE destination TEXT := btrim(coalesce(p_metadata->>'tujuanSurat',''));
BEGIN
 IF p_date IS NULL OR p_date NOT BETWEEN DATE '2026-01-01' AND DATE '2026-12-31'
  OR length(btrim(coalesce(p_title,''))) NOT BETWEEN 1 AND 300
  OR jsonb_typeof(p_metadata) IS DISTINCT FROM 'object'
  OR jsonb_typeof(p_metadata->'kdSurat') IS DISTINCT FROM 'string'
  OR btrim(coalesce(p_metadata->>'kdSurat','')) !~ '^[0-9]{3}(\.[0-9]+){0,3}$'
  OR jsonb_typeof(p_metadata->'kdSatker') IS DISTINCT FROM 'string'
  OR length(btrim(coalesce(p_metadata->>'kdSatker',''))) NOT BETWEEN 1 AND 100
  OR NOT EXISTS(SELECT 1 FROM satkers WHERE name=btrim(p_metadata->>'kdSatker'))
  OR coalesce(jsonb_typeof(p_metadata->'tujuanSurat'),'null') NOT IN ('null','string')
  OR length(destination)>500
  OR jsonb_typeof(p_metadata->'ket') IS DISTINCT FROM 'string'
  OR btrim(coalesce(p_metadata->>'ket','')) NOT IN ('CAT','SRIKANDI','EOFFICE','MANUAL') THEN
  RAISE EXCEPTION 'INVALID_INPUT: invalid letter fields or configured year';
 END IF;
 IF p_date<>(now() AT TIME ZONE 'Asia/Jakarta')::date AND btrim(p_metadata->>'ket')<>'MANUAL' THEN
  RAISE EXCEPTION 'NON_TODAY_MANUAL_ONLY: dates other than today WIB require MANUAL';
 END IF;
 RETURN p_metadata || jsonb_build_object('kdSurat',btrim(p_metadata->>'kdSurat'),'kdSatker',btrim(p_metadata->>'kdSatker'),'tujuanSurat',destination,'ket',btrim(p_metadata->>'ket'));
END $$;

CREATE OR REPLACE FUNCTION public.guard_registered_letter_fields()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF NEW.letter_date IS NOT NULL THEN
  NEW.metadata := validate_registered_letter_fields(NEW.letter_date,NEW.title,NEW.metadata);
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS documents_registered_letter_fields ON public.documents;
CREATE TRIGGER documents_registered_letter_fields BEFORE INSERT OR UPDATE OF title,metadata ON public.documents
FOR EACH ROW EXECUTE FUNCTION public.guard_registered_letter_fields();

CREATE OR REPLACE FUNCTION public.create_registered_document(p_user_id UUID,p_date DATE,p_title TEXT,p_metadata JSONB,p_emergency BOOLEAN DEFAULT false,p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SET search_path=public AS $$
DECLARE today DATE := (now() AT TIME ZONE 'Asia/Jakarta')::date; state register_state%ROWTYPE; u users%ROWTYPE; slot letter_slots%ROWTYPE; day DATE; count_slots INT; base INT; next_suffix INT; suffix TEXT; n INT; doc documents%ROWTYPE; emergency_allocated BOOLEAN := false;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 SELECT * INTO u FROM users WHERE id=p_user_id;
 IF NOT FOUND OR u.status<>'approved' THEN RAISE EXCEPTION 'FORBIDDEN: approved account required'; END IF;
 IF p_emergency AND (u.role NOT IN ('admin','superadmin') OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 500) THEN RAISE EXCEPTION 'FORBIDDEN: administrator confirmation and reason required'; END IF;
 p_metadata := validate_registered_letter_fields(p_date,p_title,p_metadata);
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

REVOKE ALL ON FUNCTION public.validate_registered_letter_fields(DATE,TEXT,JSONB), public.guard_registered_letter_fields() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.validate_registered_letter_fields(DATE,TEXT,JSONB), public.guard_registered_letter_fields() TO service_role;
-- Re-project previously acknowledged months so existing number cells receive the new fills.
UPDATE public.register_days SET revision=revision+1;
NOTIFY pgrst,'reload schema';
COMMIT;
