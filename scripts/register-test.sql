\set ON_ERROR_STOP on
DO $$ BEGIN
  IF to_regprocedure('public.create_registered_document(uuid,date,text,jsonb,boolean,text)') IS NULL THEN
    RAISE EXCEPTION 'Dated allocator missing: current counter cannot reserve ranges or allocate backdated slots';
  END IF;
END $$;
INSERT INTO users(id,username,password_hash,role,status) VALUES
 ('11111111-1111-1111-1111-111111111111','register_user','unused','user','approved'),
 ('22222222-2222-2222-2222-222222222222','register_admin','unused','admin','approved'),
 ('33333333-3333-3333-3333-333333333333','register_pending','unused','user','pending');
DO $$
DECLARE
 today date := (now() AT TIME ZONE 'Asia/Jakarta')::date;
 meta jsonb := '{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}';
 doc jsonb;
 n integer;
 high_water integer;
BEGIN
 -- A duplicate imported number must fail atomically, not mark bootstrap complete.
 BEGIN
  PERFORM initialize_letter_register(jsonb_build_array(
   jsonb_build_object('number','999','date',today-1,'occupied',true,'values','[]'::jsonb),
   jsonb_build_object('number','999','date',today-1,'occupied',false,'values','[]'::jsonb)), today);
  RAISE EXCEPTION 'Duplicate import accepted';
 EXCEPTION WHEN unique_violation THEN NULL;
 END;
 IF (SELECT initialized FROM register_state WHERE id=1) THEN RAISE EXCEPTION 'Failed import committed'; END IF;
 PERFORM initialize_letter_register(jsonb_build_array(
  jsonb_build_object('number','998.1','date',today-2,'occupied',false,'values','[]'::jsonb),
  jsonb_build_object('number','999','date',today-1,'occupied',true,'values','[]'::jsonb),
  jsonb_build_object('number','1000','date',today-1,'occupied',false,'values','[]'::jsonb),
  jsonb_build_object('number','1000.1','date',today-1,'occupied',true,'values','[]'::jsonb)), today);
 doc := create_registered_document('11111111-1111-1111-1111-111111111111',today-2,'Available numeric suffix',meta);
 IF doc->>'surat_number'<>'998.1' OR EXISTS(SELECT 1 FROM audit_logs WHERE action='EMERGENCY_ALLOCATION') THEN
  RAISE EXCEPTION 'Unused imported suffix was not ordinary allocation';
 END IF;
 doc := create_registered_document('11111111-1111-1111-1111-111111111111',today-1,'Backdated',meta);
 IF doc->>'surat_number' <> '1000' THEN RAISE EXCEPTION 'Backdating did not take first empty slot: %',doc; END IF;
 doc := create_registered_document('11111111-1111-1111-1111-111111111111',today+3,'Future',meta);
 IF doc->>'surat_number' <> '1136' THEN RAISE EXCEPTION 'Future number did not follow three 45-slot days: %',doc; END IF;
 FOR n IN 0..2 LOOP
  IF (SELECT count(*) FROM letter_slots WHERE letter_date=today+n AND suffix_index=0) <> 45 THEN
   RAISE EXCEPTION 'Skipped date did not reserve exactly 45: %',today+n;
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM letter_slots WHERE letter_date=today+3) <> 1 THEN RAISE EXCEPTION 'Target date received automatic 45'; END IF;
 doc := create_registered_document('11111111-1111-1111-1111-111111111111',today,'Today',meta);
 IF doc->>'surat_number' <> '1001' THEN RAISE EXCEPTION 'Today did not use own earliest empty slot'; END IF;
 BEGIN
  PERFORM create_registered_document('11111111-1111-1111-1111-111111111111',today-1,'Full',meta);
  RAISE EXCEPTION 'Exhausted ordinary day accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'DAY_FULL%' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM create_registered_document('11111111-1111-1111-1111-111111111111',today-1,'Unauthorized suffix',meta,true,'Forced');
  RAISE EXCEPTION 'User emergency allocation accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'FORBIDDEN%' THEN RAISE; END IF;
 END;
 FOR n IN 1..27 LOOP
  doc := create_registered_document('22222222-2222-2222-2222-222222222222',today-1,'Emergency',meta,true,'No unused slots');
  IF n=1 AND doc->>'surat_number'<>'1000.a' THEN RAISE EXCEPTION 'First suffix wrong'; END IF;
  IF n=2 AND doc->>'surat_number'<>'1000.b' THEN RAISE EXCEPTION 'Second suffix wrong'; END IF;
 END LOOP;
 IF doc->>'surat_number'<>'1000.aa' THEN RAISE EXCEPTION 'Suffix after z wrong'; END IF;
 BEGIN
  PERFORM create_registered_document('33333333-3333-3333-3333-333333333333',today,'Pending',meta);
  RAISE EXCEPTION 'Pending user allocated a number';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'FORBIDDEN%' THEN RAISE; END IF;
 END;
 PERFORM close_letter_days(today+4);
 IF (SELECT count(*) FROM letter_slots WHERE letter_date=today AND suffix_index=0) <>45 THEN RAISE EXCEPTION 'Fixed 45 got extra midnight slots'; END IF;
 IF (SELECT count(*) FROM letter_slots WHERE letter_date=today+3 AND NOT occupied) <>15 THEN RAISE EXCEPTION 'Close failed to leave 15 unused'; END IF;
 high_water := (SELECT current_number FROM register_state WHERE id=1);
 PERFORM close_letter_days(today+4);
 IF high_water<>(SELECT current_number FROM register_state WHERE id=1) THEN RAISE EXCEPTION 'Repeated close consumed more numbers'; END IF;
 -- Calendar-only days must receive 15 even with no submitted letter.
 PERFORM close_letter_days(today+5);
 IF (SELECT count(*) FROM letter_slots WHERE letter_date=today+4 AND NOT occupied)<>15 THEN RAISE EXCEPTION 'Empty day did not receive 15'; END IF;
 RAISE NOTICE 'PASS earliest unused backdate, 45-slot reservation, target dynamic, 15-unused close, fixed-day close, repeated close, empty-day close, emergency roles and suffix .aa';
END $$;

DO $$
DECLARE
 owner_a UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 owner_b UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
 doc documents%ROWTYPE;
 day register_days%ROWTYPE;
BEGIN
 SELECT * INTO doc FROM documents WHERE title='Today';
 IF bump_sync_attempts_and_set_status(doc.id,'synced',NULL,doc.updated_at-interval '1 second') IS NOT NULL THEN RAISE EXCEPTION 'Stale writer marked newer content synced'; END IF;
 IF (SELECT sync_status FROM documents WHERE id=doc.id)<>'pending' THEN RAISE EXCEPTION 'Stale writer changed sync state'; END IF;
 IF NOT acquire_register_sync(owner_a) OR acquire_register_sync(owner_b) THEN RAISE EXCEPTION 'Concurrent writers acquired one lease'; END IF;
 UPDATE register_sync_lease SET expires_at=clock_timestamp()-interval '1 second' WHERE id=1;
 IF renew_register_sync(owner_a) OR NOT acquire_register_sync(owner_b) THEN RAISE EXCEPTION 'Expired writer retained lease'; END IF;
 PERFORM release_register_sync(owner_a);
 IF (SELECT owner FROM register_sync_lease WHERE id=1)<>owner_b THEN RAISE EXCEPTION 'Old writer released new lease'; END IF;
 SELECT * INTO day FROM register_days WHERE letter_date=doc.letter_date;
 IF acknowledge_register_days(owner_a,jsonb_build_array(jsonb_build_object('letter_date',day.letter_date,'revision',day.revision))) THEN RAISE EXCEPTION 'Old owner acknowledged projection'; END IF;
 PERFORM acknowledge_register_days(owner_b,jsonb_build_array(jsonb_build_object('letter_date',day.letter_date,'revision',day.revision-1)));
 IF (SELECT synced_revision FROM register_days WHERE letter_date=day.letter_date)<>day.synced_revision THEN RAISE EXCEPTION 'Stale projection acknowledged newer edits'; END IF;
 PERFORM acknowledge_register_days(owner_b,jsonb_build_array(jsonb_build_object('letter_date',day.letter_date,'revision',day.revision)));
 IF (SELECT synced_revision FROM register_days WHERE letter_date=day.letter_date)<>day.revision THEN RAISE EXCEPTION 'Current projection not acknowledged'; END IF;
 PERFORM release_register_sync(owner_b);
 RAISE NOTICE 'PASS stale document status, exclusive lease, expiry takeover, old-owner isolation and revision-aware acknowledgement';
END $$;
