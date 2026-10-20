\set ON_ERROR_STOP on
DO $$ BEGIN
 IF to_regprocedure('public.delete_registered_document(uuid,integer)') IS NULL THEN
  RAISE EXCEPTION 'Safe deletion missing: deleting a letter must hold its number until Sheets acknowledgement';
 END IF;
END $$;
INSERT INTO users(id,username,password_hash,role,status) VALUES
 ('44444444-4444-4444-4444-444444444444','register_other','unused','user','approved'),
 ('55555555-5555-5555-5555-555555555555','register_super','unused','superadmin','approved');
DO $$
DECLARE
 ordinary UUID := '11111111-1111-1111-1111-111111111111';
 administrator UUID := '22222222-2222-2222-2222-222222222222';
 pending UUID := '33333333-3333-3333-3333-333333333333';
 other_user UUID := '44444444-4444-4444-4444-444444444444';
 super_user UUID := '55555555-5555-5555-5555-555555555555';
 owner_a UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 owner_b UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 doc documents%ROWTYPE;
 legacy_id INT;
 emergency_id INT;
 day register_days%ROWTYPE;
 before_revision BIGINT;
 before_high_water INT;
 after_delete_revision BIGINT;
 allocation_audits INT;
 result JSONB;
 slot letter_slots%ROWTYPE;
BEGIN
 SELECT * INTO STRICT doc FROM documents WHERE surat_number='998.1';
 SELECT revision INTO before_revision FROM register_days WHERE letter_date=doc.letter_date;
 SELECT current_number INTO before_high_water FROM register_state WHERE id=1;
 FOR actor IN 1..3 LOOP
  BEGIN
   PERFORM delete_registered_document(CASE actor WHEN 1 THEN other_user WHEN 2 THEN pending ELSE '99999999-9999-9999-9999-999999999999'::UUID END,doc.id);
   RAISE EXCEPTION 'Unauthorized deletion accepted';
  EXCEPTION WHEN raise_exception THEN
   IF SQLERRM NOT LIKE 'FORBIDDEN%' AND SQLERRM NOT LIKE 'NOT_FOUND%' THEN RAISE; END IF;
  END;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM documents WHERE id=doc.id) OR (SELECT revision FROM register_days WHERE letter_date=doc.letter_date)<>before_revision THEN
  RAISE EXCEPTION 'Rejected deletion changed document or register';
 END IF;
 INSERT INTO documents(id,surat_number,title,created_by) VALUES(get_next_document_id(),'900000','Legacy unchanged',ordinary) RETURNING id INTO legacy_id;
 BEGIN
  PERFORM delete_registered_document(administrator,legacy_id);
  RAISE EXCEPTION 'Legacy deletion accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'LEGACY_READ_ONLY%' THEN RAISE; END IF;
 END;
 IF NOT EXISTS(SELECT 1 FROM documents WHERE id=legacy_id) THEN RAISE EXCEPTION 'Legacy record was removed'; END IF;
 IF NOT acquire_register_sync(owner_a) THEN RAISE EXCEPTION 'Could not prepare an older in-flight writer'; END IF;
 PERFORM delete_registered_document(ordinary,doc.id);
 IF EXISTS(SELECT 1 FROM documents WHERE id=doc.id) THEN RAISE EXCEPTION 'Deleted contents remain in documents'; END IF;
 SELECT * INTO STRICT slot FROM letter_slots WHERE number=doc.surat_number;
 IF NOT slot.occupied OR NOT slot.release_pending OR slot.document_id IS NOT NULL OR slot.release_requested_by<>ordinary THEN
  RAISE EXCEPTION 'Number became available before source clearing';
 END IF;
 IF slot.letter_date<>doc.letter_date OR slot.base_number<>998 OR slot.suffix_index=0 THEN RAISE EXCEPTION 'Deletion changed number/date identity'; END IF;
 IF slot."values"->>1<>'' OR slot."values"->>3<>doc.surat_number OR slot."values"->>5<>'' OR slot."values"->>6<>'' OR slot."values"->>7<>'' OR slot."values"->8<>'false'::jsonb OR slot."values"->9<>'false'::jsonb OR slot."values"->10<>'false'::jsonb OR slot."values"->11<>'false'::jsonb THEN
  RAISE EXCEPTION 'Deleted letter fields or checkbox contents remain in projection';
 END IF;
 IF (SELECT current_number FROM register_state WHERE id=1)<>before_high_water THEN RAISE EXCEPTION 'Deletion rewound or consumed the counter'; END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_logs WHERE action='DELETE_DOC' AND target_id=doc.id::TEXT AND user_id=ordinary AND details->>'surat_number'=doc.surat_number AND NOT details ? 'before' AND NOT details ? 'metadata' AND NOT details ? 'title') THEN
  RAISE EXCEPTION 'Deletion audit missing or stores deleted contents';
 END IF;
 SELECT revision INTO after_delete_revision FROM register_days WHERE letter_date=doc.letter_date;
 IF after_delete_revision<=before_revision THEN RAISE EXCEPTION 'Deletion did not queue the empty projection'; END IF;
 BEGIN
  PERFORM create_registered_document(other_user,doc.letter_date,'Must not reuse held number','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"New","ket":"MANUAL"}');
  RAISE EXCEPTION 'Pending-clear number was reallocated';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'DAY_FULL%' THEN RAISE; END IF;
 END;
 IF acknowledge_register_days(owner_b,jsonb_build_array(jsonb_build_object('letter_date',doc.letter_date,'revision',after_delete_revision))) THEN RAISE EXCEPTION 'Wrong lease acknowledged deletion'; END IF;
 PERFORM acknowledge_register_days(owner_a,jsonb_build_array(jsonb_build_object('letter_date',doc.letter_date,'revision',before_revision)));
 IF NOT (SELECT occupied AND release_pending FROM letter_slots WHERE number=doc.surat_number) THEN RAISE EXCEPTION 'Older writer released a deleted number'; END IF;
 UPDATE register_days SET revision=revision+1 WHERE letter_date=doc.letter_date;
 PERFORM acknowledge_register_days(owner_a,jsonb_build_array(jsonb_build_object('letter_date',doc.letter_date,'revision',after_delete_revision)));
 IF NOT (SELECT occupied AND release_pending FROM letter_slots WHERE number=doc.surat_number) THEN RAISE EXCEPTION 'Stale revision released a deleted number'; END IF;
 SELECT * INTO day FROM register_days WHERE letter_date=doc.letter_date;
 IF NOT acknowledge_register_days(owner_a,jsonb_build_array(jsonb_build_object('letter_date',day.letter_date,'revision',day.revision))) THEN RAISE EXCEPTION 'Current clear projection not acknowledged'; END IF;
 IF EXISTS(SELECT 1 FROM letter_slots WHERE number=doc.surat_number AND (occupied OR release_pending OR release_requested_by IS NOT NULL)) THEN RAISE EXCEPTION 'Confirmed clear number was not released'; END IF;
 IF get_document_deletion_status(ordinary,doc.id)<>'{"releasePending":false,"trimmed":false}'::jsonb THEN RAISE EXCEPTION 'Middle deletion incorrectly reports tail trimming'; END IF;
 PERFORM release_register_sync(owner_a);
 result := create_registered_document(other_user,doc.letter_date,'New owner and content','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"New destination","ket":"MANUAL"}');
 IF result->>'surat_number'<>doc.surat_number OR result->>'letter_date'<>doc.letter_date::TEXT OR (result->>'id')::INT=doc.id OR result->>'created_by'<>other_user::TEXT OR result->>'title'<>'New owner and content' THEN
  RAISE EXCEPTION 'Released number reuse changed identity or resurrected deleted contents';
 END IF;
 IF (SELECT current_number FROM register_state WHERE id=1)<>before_high_water THEN RAISE EXCEPTION 'Reusing a deleted slot consumed the high-water counter'; END IF;
 PERFORM delete_registered_document(administrator,(result->>'id')::INT);
 IF NOT (SELECT release_pending FROM letter_slots WHERE number=doc.surat_number) THEN RAISE EXCEPTION 'Admin cannot delete another owner letter'; END IF;
 SELECT id INTO STRICT emergency_id FROM documents WHERE surat_number='1000.a';
 PERFORM delete_registered_document(super_user,emergency_id);
 SELECT * INTO day FROM register_days WHERE letter_date=(now() AT TIME ZONE 'Asia/Jakarta')::DATE-1;
 IF NOT acquire_register_sync(owner_b) THEN RAISE EXCEPTION 'Clear writer unavailable'; END IF;
 PERFORM acknowledge_register_days(owner_b,jsonb_build_array(jsonb_build_object('letter_date',day.letter_date,'revision',day.revision)));
 PERFORM release_register_sync(owner_b);
 SELECT count(*) INTO allocation_audits FROM audit_logs WHERE action='EMERGENCY_ALLOCATION';
 result := create_registered_document(other_user,day.letter_date,'Reuse cleared alpha suffix','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"New","ket":"MANUAL"}');
 IF result->>'surat_number'<>'1000.a' OR (SELECT count(*) FROM audit_logs WHERE action='EMERGENCY_ALLOCATION')<>allocation_audits THEN RAISE EXCEPTION 'Cleared emergency suffix cannot be reused normally'; END IF;
 RAISE NOTICE 'PASS own-only deletion, admin/superadmin foreign-owner deletion, legacy protection, field clearing, held numbers, wrong/stale writer isolation, exact-revision release, original-date numeric/alpha suffix reuse, counter stability';
END $$;

-- Supabase table grants must not let public keys bypass the scoped application API.
GRANT SELECT ON public.documents TO anon,authenticated;
SET ROLE anon;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.documents) THEN
  RAISE EXCEPTION 'Anonymous readers can still read letters outside the authorized API scope';
 END IF;
END $$;
RESET ROLE;
SET ROLE authenticated;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.documents) THEN
  RAISE EXCEPTION 'Unscoped Supabase authentication can still read private application letters';
 END IF;
END $$;
RESET ROLE;
