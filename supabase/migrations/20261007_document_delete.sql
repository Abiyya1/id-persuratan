-- Apply after 20261006_letter_register.sql. Deleted numbers stay held until Sheets clears them.
BEGIN;
ALTER TABLE public.letter_slots ADD COLUMN IF NOT EXISTS release_pending BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.letter_slots ADD COLUMN IF NOT EXISTS release_requested_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

-- Search now polls the freshly authorized API; public Realtime reads are obsolete.
DROP POLICY IF EXISTS documents_anon_select ON public.documents;
COMMENT ON TABLE public.documents IS 'Application letters. Access requires fresh approval and API role/ownership checks.';

CREATE OR REPLACE FUNCTION public.delete_registered_document(p_user_id UUID,p_document_id INT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=public AS $$
DECLARE
 actor users%ROWTYPE;
 doc documents%ROWTYPE;
 slot letter_slots%ROWTYPE;
 ordinal JSONB;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 SELECT * INTO actor FROM users WHERE id=p_user_id FOR SHARE;
 IF NOT FOUND OR actor.status<>'approved' OR actor.role NOT IN ('user','admin','superadmin') THEN
  RAISE EXCEPTION 'FORBIDDEN: approved account required';
 END IF;
 SELECT * INTO doc FROM documents WHERE id=p_document_id FOR UPDATE;
 IF NOT FOUND OR (actor.role='user' AND doc.created_by IS DISTINCT FROM p_user_id) THEN
  RAISE EXCEPTION 'NOT_FOUND: document not found';
 END IF;
 IF doc.letter_date IS NULL THEN RAISE EXCEPTION 'LEGACY_READ_ONLY: undated documents cannot be deleted'; END IF;
 PERFORM 1 FROM register_days WHERE letter_date=doc.letter_date FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'REGISTER_SLOT_MISMATCH: register day missing'; END IF;
 SELECT * INTO slot FROM letter_slots WHERE document_id=doc.id FOR UPDATE;
 IF NOT FOUND OR slot.number<>doc.surat_number OR slot.letter_date<>doc.letter_date OR NOT slot.occupied OR slot.release_pending THEN
  RAISE EXCEPTION 'REGISTER_SLOT_MISMATCH: matching occupied slot required';
 END IF;
 ordinal := slot."values"->0;
 IF ordinal IS NULL OR ordinal='null'::jsonb OR ordinal='""'::jsonb THEN
  SELECT to_jsonb(count(*)+1) INTO ordinal FROM letter_slots
  WHERE letter_date=slot.letter_date AND (base_number,suffix_index,number)<(slot.base_number,slot.suffix_index,slot.number);
 END IF;
 UPDATE letter_slots SET document_id=NULL,occupied=true,release_pending=true,release_requested_by=p_user_id,
  "values"=jsonb_build_array(ordinal,'','/',slot.number,'/','','','',false,false,false,false)
 WHERE number=slot.number;
 DELETE FROM documents WHERE id=doc.id;
 UPDATE register_days SET revision=revision+1 WHERE letter_date=doc.letter_date;
 INSERT INTO audit_logs(user_id,action,target_id,details)
 VALUES(p_user_id,'DELETE_DOC',doc.id::text,jsonb_build_object('surat_number',doc.surat_number,'letter_date',doc.letter_date));
 RETURN jsonb_build_object('suratNumber',doc.surat_number,'letterDate',doc.letter_date,'releasePending',true);
END $$;

CREATE OR REPLACE FUNCTION public.acknowledge_register_days(p_owner UUID,p_days JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=public AS $$
DECLARE
 day RECORD;
 acknowledged INT := 0;
BEGIN
 -- Same lock order as allocation/deletion: allocator, then lease, days and slots.
 PERFORM pg_advisory_xact_lock(6002026);
 PERFORM 1 FROM register_sync_lease WHERE id=1 AND owner=p_owner AND expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 FOR day IN
  SELECT d.letter_date FROM register_days d
  JOIN jsonb_to_recordset(p_days) x(letter_date date,revision bigint)
   ON d.letter_date=x.letter_date AND d.revision=x.revision
  ORDER BY d.letter_date FOR UPDATE OF d
 LOOP
  UPDATE register_days SET synced_revision=revision WHERE letter_date=day.letter_date;
  UPDATE letter_slots SET occupied=false,release_pending=false,release_requested_by=NULL
  WHERE letter_date=day.letter_date AND release_pending AND document_id IS NULL;
  acknowledged := acknowledged+1;
 END LOOP;
 -- A stale projection is not confirmed, even when other days were acknowledged.
 RETURN acknowledged=jsonb_array_length(p_days);
END $$;

REVOKE ALL ON FUNCTION public.delete_registered_document(UUID,INT),public.acknowledge_register_days(UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.delete_registered_document(UUID,INT),public.acknowledge_register_days(UUID,JSONB) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
