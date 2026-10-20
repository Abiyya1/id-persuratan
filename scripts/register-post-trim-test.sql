\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('persuratan_test.clock_offset',(8*86400)::text,true);
CREATE FUNCTION pg_temp.reset_post_trim_fixture(p_frontier_trimmed boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 TRUNCATE public.letter_slots,public.register_days,public.documents,public.register_day_targets,public.document_deletion_receipts;
 UPDATE public.register_state SET initialized=true,current_number=5057,allocation_floor=100,start_date='2026-10-08',closed_through='2026-10-13' WHERE id=1;
 UPDATE public.register_sync_lease SET owner=NULL,expires_at=NULL WHERE id=1;
 UPDATE public.register_settings SET closing_unused_minimum=15,future_daily_total=40 WHERE id=1;
 INSERT INTO public.register_days(letter_date,closed,fixed_reservation,tail_trimmed,revision,synced_revision)
 SELECT d::date,d::date<'2026-10-14',true,CASE WHEN d::date='2026-10-08' THEN p_frontier_trimmed ELSE true END,3,3 FROM generate_series('2026-10-08'::date,'2026-10-16'::date,'1 day') d;
 INSERT INTO public.documents(id,surat_number,letter_date,title,metadata,created_by)
 VALUES(get_next_document_id(),'5057','2026-10-08','Occupied survivor','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}','11111111-1111-1111-1111-111111111111');
 INSERT INTO public.letter_slots(number,letter_date,base_number,occupied,document_id,"values")
 SELECT n::text,'2026-10-08',n,n=5057,CASE WHEN n=5057 THEN (SELECT id FROM documents WHERE surat_number='5057') END,
 CASE WHEN n=5056 THEN '[1,"","/","5056","/","","","",false,false,false,false]'::jsonb ELSE '[2,"600","/","5057","/","Pusdatin","Occupied survivor","Test",false,false,false,true]'::jsonb END FROM generate_series(5056,5057) n;
 PERFORM save_register_defaults('22222222-2222-2222-2222-222222222222',10,35);
END $$;
SELECT pg_temp.reset_post_trim_fixture();
DO $$
DECLARE actor uuid := '11111111-1111-1111-1111-111111111111'; meta jsonb := '{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}'; doc jsonb; survivor jsonb; unused jsonb; counter int; days jsonb; n int;
BEGIN
 SELECT to_jsonb(d) INTO survivor FROM documents d WHERE surat_number='5057';
 SELECT to_jsonb(s) INTO unused FROM letter_slots s WHERE number='5056';
 SELECT current_val INTO counter FROM id_counter WHERE id=1;
 doc := create_registered_document(actor,DATE '2026-10-14','First after historical trim',meta);
 IF doc->>'surat_number'<>'5117' THEN RAISE EXCEPTION 'Post-trim expected today 5117, got %',doc->>'surat_number'; END IF;
 IF (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-08' AND NOT occupied)<>10 THEN RAISE EXCEPTION 'Oct8 did not count existing unused 5056 toward minimum 10'; END IF;
 FOR n IN 9..13 LOOP
  IF (SELECT count(*) FROM letter_slots WHERE letter_date=make_date(2026,10,n) AND NOT occupied)<>10 THEN RAISE EXCEPTION 'Missing daily reserve on Oct%, including weekend',n; END IF;
 END LOOP;
 IF (SELECT count(*) FROM letter_slots WHERE base_number BETWEEN 5058 AND 5116)<>59 OR (SELECT current_val FROM id_counter WHERE id=1)<>counter+1 THEN RAISE EXCEPTION 'Restoration changed private counter or added wrong number of slots'; END IF;
 IF survivor<>(SELECT to_jsonb(d) FROM documents d WHERE surat_number='5057') OR unused<>(SELECT to_jsonb(s) FROM letter_slots s WHERE number='5056') THEN RAISE EXCEPTION 'Restoration mutated surviving document or unused slot'; END IF;
 IF EXISTS(SELECT 1 FROM register_days WHERE letter_date BETWEEN '2026-10-08' AND '2026-10-13' AND (tail_trimmed OR NOT closed OR revision=synced_revision)) THEN RAISE EXCEPTION 'Historical flags or dirty revisions not restored'; END IF;
 IF (SELECT closed_through FROM register_state WHERE id=1)<>DATE '2026-10-13' THEN RAISE EXCEPTION 'Restoration rewound closing pointer'; END IF;
 SELECT jsonb_agg(jsonb_build_object('letter_date',letter_date,'revision',revision)) INTO days FROM register_days WHERE letter_date<'2026-10-14';
 doc := create_registered_document(actor,DATE '2026-10-14','Repeated creation',meta);
 IF doc->>'surat_number'<>'5118' OR (SELECT count(*) FROM letter_slots WHERE letter_date<'2026-10-14')<>61 OR days<>(SELECT jsonb_agg(jsonb_build_object('letter_date',letter_date,'revision',revision)) FROM register_days WHERE letter_date<'2026-10-14') THEN RAISE EXCEPTION 'Repeat create rebuilt historical reserves'; END IF;
 RAISE NOTICE 'PASS Oct8 false trim frontier, unused5056+occupied5057, latest10 not old15, every Oct9..13, today5117 and repeat idempotence';
END $$;

SELECT pg_temp.reset_post_trim_fixture(true);
DO $$
DECLARE actor uuid := '11111111-1111-1111-1111-111111111111'; writer uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; wrong uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; meta jsonb := '{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}'; stale jsonb; days jsonb; doc jsonb;
BEGIN
 INSERT INTO register_days(letter_date,tail_trimmed,revision,synced_revision) VALUES('2026-11-01',true,4,3);
 INSERT INTO letter_slots(number,letter_date,base_number,retiring) VALUES('5200','2026-11-01',5200,true);
 UPDATE register_state SET current_number=5200 WHERE id=1;
 SELECT jsonb_agg(jsonb_build_object('letter_date',letter_date,'revision',revision-1)) INTO stale FROM register_days;
 PERFORM acquire_register_sync(writer);
 BEGIN PERFORM create_registered_document(actor,DATE '2026-10-14','Pending historical restoration',meta); RAISE EXCEPTION 'Pending restoration accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'REGISTER_TRIM_PENDING:%' THEN RAISE; END IF; END;
 IF acknowledge_register_days(wrong,stale) OR acknowledge_register_days(writer,stale) OR NOT EXISTS(SELECT 1 FROM letter_slots WHERE retiring) THEN RAISE EXCEPTION 'Stale/wrong ack released restoration hold'; END IF;
 SELECT jsonb_agg(jsonb_build_object('letter_date',letter_date,'revision',revision)) INTO days FROM register_days;
 IF NOT acknowledge_register_days(writer,days) THEN RAISE EXCEPTION 'Current acknowledgement rejected'; END IF;
 IF (SELECT current_number FROM register_state WHERE id=1)<>5057 OR (SELECT count(*) FROM letter_slots)<>2 THEN RAISE EXCEPTION 'Acknowledgement did not prune without restoring'; END IF;
 PERFORM close_letter_days(DATE '2026-10-14');
 IF (SELECT current_number FROM register_state WHERE id=1)<>5057 THEN RAISE EXCEPTION 'Cron immediately undid prune'; END IF;
 PERFORM release_register_sync(writer);
 doc := create_registered_document(actor,DATE '2026-10-14','After full writer ack',meta);
 IF doc->>'surat_number'<>'5117' THEN RAISE EXCEPTION 'Current ack failed to permit restoration'; END IF;
 IF (SELECT NOT tail_trimmed AND revision>synced_revision FROM register_days WHERE letter_date='2026-11-01') IS DISTINCT FROM true OR EXISTS(SELECT 1 FROM letter_slots WHERE letter_date='2026-11-01') THEN RAISE EXCEPTION 'Consumed future tombstone not dirtied without allocating future slots'; END IF;
 RAISE NOTICE 'PASS pending global trim hold, stale/wrong lease, exact writer ack, deletion-time prune and cron non-restoration';
END $$;

SELECT pg_temp.reset_post_trim_fixture();
DO $$
DECLARE actor uuid := '11111111-1111-1111-1111-111111111111'; meta jsonb := '{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}'; before_state jsonb; before_slots jsonb; before_days jsonb; before_docs jsonb; counter int;
BEGIN
 INSERT INTO documents(id,surat_number,letter_date,title,metadata,created_by) VALUES(get_next_document_id(),'5058','2026-10-14','Existing number must not move',meta,actor);
 INSERT INTO letter_slots(number,letter_date,base_number,occupied,document_id) SELECT '5058','2026-10-14',5058,true,id FROM documents WHERE surat_number='5058';
 UPDATE register_state SET current_number=5058 WHERE id=1;
 SELECT to_jsonb(s) INTO before_state FROM register_state s WHERE id=1;
 SELECT jsonb_agg(to_jsonb(s) ORDER BY number) INTO before_slots FROM letter_slots s;
 SELECT jsonb_agg(to_jsonb(d) ORDER BY letter_date) INTO before_days FROM register_days d;
 SELECT jsonb_agg(to_jsonb(d) ORDER BY id) INTO before_docs FROM documents d;
 SELECT current_val INTO counter FROM id_counter WHERE id=1;
 BEGIN PERFORM create_registered_document(actor,DATE '2026-10-14','Cannot cross5058',meta); RAISE EXCEPTION 'Occupied later date accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'REGISTER_RESTORE_CONFLICT:%' THEN RAISE; END IF; END;
 IF before_state<>(SELECT to_jsonb(s) FROM register_state s WHERE id=1) OR before_slots<>(SELECT jsonb_agg(to_jsonb(s) ORDER BY number) FROM letter_slots s) OR before_days<>(SELECT jsonb_agg(to_jsonb(d) ORDER BY letter_date) FROM register_days d) OR before_docs<>(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM documents d) OR counter<>(SELECT current_val FROM id_counter WHERE id=1) THEN RAISE EXCEPTION 'Blocked restoration changed existing5058, slots, days or counters'; END IF;
 RAISE NOTICE 'PASS occupied5058 actionable conflict and atomic no-renumber/no-mutation';
END $$;

SELECT pg_temp.reset_post_trim_fixture();
INSERT INTO register_day_targets VALUES('2026-10-09',4),('2026-10-15',7);
DO $$
DECLARE actor uuid := '11111111-1111-1111-1111-111111111111'; meta jsonb := '{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}'; doc jsonb;
BEGIN
 doc := create_registered_document(actor,DATE '2026-10-16','Future custom/default restoration',meta);
 IF doc->>'surat_number'<>'5153' OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-09')<>4 OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-14')<>35 OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-15')<>7 THEN RAISE EXCEPTION 'Custom historical4 / future35+7 policy failed: %',doc; END IF;
 IF (SELECT total FROM register_day_targets WHERE letter_date='2026-10-09')<>4 OR NOT (SELECT closed AND fixed_reservation AND NOT tail_trimmed FROM register_days WHERE letter_date='2026-10-09') THEN RAISE EXCEPTION 'Historical saved plan not preserved/frozen'; END IF;
 doc := create_registered_document(actor,DATE '2026-10-08','Backdated restored unused slot',meta);
 IF doc->>'surat_number'<>'5056' OR doc->>'created_by'<>actor::text THEN RAISE EXCEPTION 'Non-today original-date ownership/allocation changed'; END IF;
 PERFORM save_register_defaults('22222222-2222-2222-2222-222222222222',50,150);
 PERFORM create_registered_document(actor,DATE '2026-10-17','Frozen future defaults survive',meta);
 IF (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-14')<>35 OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-15')<>7 OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-08')<>11 THEN RAISE EXCEPTION 'Changed defaults rebuilt restored historical/active frozen ranges'; END IF;
 RAISE NOTICE 'PASS preserved custom plan overrides minimum, future35, frozen defaults, non-today date and creator ownership';
END $$;

SELECT pg_temp.reset_post_trim_fixture();
DO $$
DECLARE actor uuid := '11111111-1111-1111-1111-111111111111'; meta jsonb := '{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}'; days jsonb; counter int; doc jsonb;
BEGIN
 SELECT jsonb_agg(to_jsonb(d) ORDER BY letter_date) INTO days FROM register_days d;
 SELECT current_val INTO counter FROM id_counter WHERE id=1;
 BEGIN PERFORM create_registered_document(actor,DATE '2026-10-13','Wrong non-today kind',meta||'{"ket":"SRIKANDI"}'::jsonb); RAISE EXCEPTION 'Non-today kind accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'NON_TODAY_MANUAL_ONLY:%' THEN RAISE; END IF; END;
 BEGIN PERFORM create_registered_document('33333333-3333-3333-3333-333333333333',DATE '2026-10-14','Pending actor',meta); RAISE EXCEPTION 'Pending actor restored';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'FORBIDDEN:%' THEN RAISE; END IF; END;
 IF days<>(SELECT jsonb_agg(to_jsonb(d) ORDER BY letter_date) FROM register_days d) OR counter<>(SELECT current_val FROM id_counter WHERE id=1) OR (SELECT count(*) FROM letter_slots)<>2 THEN RAISE EXCEPTION 'Rejected auth/input restored reserves'; END IF;
 PERFORM set_config('persuratan_test.clock_offset','723599',true);
 IF (now() AT TIME ZONE 'Asia/Jakarta')::date<>DATE '2026-10-14' THEN RAISE EXCEPTION 'WIB before-midnight clock fixture invalid'; END IF;
 doc := create_registered_document(actor,DATE '2026-10-14','Before WIB midnight',meta||'{"ket":"SRIKANDI"}'::jsonb);
 IF doc->>'surat_number'<>'5117' THEN RAISE EXCEPTION 'Before-midnight restored through wrong date'; END IF;
 PERFORM set_config('persuratan_test.clock_offset','723600',true);
 BEGIN PERFORM create_registered_document(actor,DATE '2026-10-14','Now yesterday',meta||'{"ket":"SRIKANDI"}'::jsonb); RAISE EXCEPTION 'WIB rollover accepted non-manual';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'NON_TODAY_MANUAL_ONLY:%' THEN RAISE; END IF; END;
 doc := create_registered_document(actor,DATE '2026-10-15','After WIB midnight',meta);
 IF doc->>'surat_number'<>'5128' OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-14' AND NOT occupied)<>10 OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-13')<>10 THEN RAISE EXCEPTION 'Midnight close rebuilt restored historical day or missed new closing'; END IF;
 IF has_function_privilege('anon','public.restore_trimmed_letter_days(date)','EXECUTE') OR has_function_privilege('authenticated','public.restore_trimmed_letter_days(date)','EXECUTE') OR NOT has_function_privilege('service_role','public.restore_trimmed_letter_days(date)','EXECUTE') THEN RAISE EXCEPTION 'Restore helper permission boundary invalid'; END IF;
 RAISE NOTICE 'PASS authorization/input precedes restoration, non-today MANUAL, WIB rollover and service-only helper';
END $$;

SELECT set_config('persuratan_test.clock_offset',(8*86400)::text,true);
SELECT pg_temp.reset_post_trim_fixture();
DELETE FROM register_days WHERE letter_date='2026-10-11';
DO $$
DECLARE doc jsonb;
BEGIN
 doc := create_registered_document('11111111-1111-1111-1111-111111111111',DATE '2026-10-14','Missing trailing calendar day','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}');
 IF doc->>'surat_number'<>'5117' OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-11')<>10 THEN RAISE EXCEPTION 'Missing trailing calendar date not restored'; END IF;
END $$;

SELECT pg_temp.reset_post_trim_fixture();
UPDATE register_days SET tail_trimmed=false;
UPDATE register_days SET fixed_reservation=false WHERE letter_date>='2026-10-14';
DO $$
DECLARE doc jsonb; day_before jsonb;
BEGIN
 SELECT to_jsonb(d) INTO day_before FROM register_days d WHERE letter_date='2026-10-08';
 doc := create_registered_document('11111111-1111-1111-1111-111111111111',DATE '2026-10-14','No trim history preserves closed day','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}');
 IF doc->>'surat_number'<>'5058' OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-08')<>2 OR day_before<>(SELECT to_jsonb(d) FROM register_days d WHERE letter_date='2026-10-08') THEN RAISE EXCEPTION 'Ordinary closed range changed without trim history'; END IF;
END $$;

SELECT pg_temp.reset_post_trim_fixture();
INSERT INTO letter_slots(number,letter_date,base_number) VALUES('5058','2026-10-14',5058);
UPDATE register_state SET current_number=5058 WHERE id=1;
DO $$
BEGIN
 BEGIN PERFORM create_registered_document('11111111-1111-1111-1111-111111111111',DATE '2026-10-14','Cannot cross later unused range','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}'); RAISE EXCEPTION 'Later allocated unused date crossed';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'REGISTER_RESTORE_CONFLICT:%' THEN RAISE; END IF; END;
 IF (SELECT count(*) FROM letter_slots)<>3 OR (SELECT current_number FROM register_state WHERE id=1)<>5058 THEN RAISE EXCEPTION 'Date conflict left partial restoration'; END IF;
END $$;

SELECT pg_temp.reset_post_trim_fixture();
INSERT INTO register_day_targets VALUES('2026-10-08',1);
DO $$
BEGIN
 BEGIN PERFORM create_registered_document('11111111-1111-1111-1111-111111111111',DATE '2026-10-14','Invalid retained custom plan','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}'); RAISE EXCEPTION 'Too-small retained plan accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'TARGET_TOO_SMALL:%' THEN RAISE; END IF; END;
 IF (SELECT count(*) FROM letter_slots)<>2 OR (SELECT current_number FROM register_state WHERE id=1)<>5057 THEN RAISE EXCEPTION 'Invalid plan left partial restoration'; END IF;
 RAISE NOTICE 'PASS missing trailing calendar day, no-trim frozen ranges, later unused-date conflicts and invalid saved-plan atomicity';
END $$;

SELECT pg_temp.reset_post_trim_fixture();
DO $$
DECLARE actor uuid := '11111111-1111-1111-1111-111111111111'; meta jsonb := '{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}'; doc jsonb; day_before jsonb;
BEGIN
 PERFORM create_registered_document(actor,DATE '2026-10-14','Consume historical trim history',meta);
 PERFORM set_config('persuratan_test.clock_offset',(9*86400)::text,true);
 doc := create_registered_document(actor,DATE '2026-10-14','Consume a newly closed unused slot',meta);
 IF doc->>'surat_number'<>'5118' OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-14' AND NOT occupied)<>9 THEN RAISE EXCEPTION 'Backdated frontier consumption fixture invalid'; END IF;
 SELECT to_jsonb(d) INTO day_before FROM register_days d WHERE letter_date='2026-10-14';
 PERFORM set_config('persuratan_test.clock_offset',(11*86400)::text,true);
 doc := create_registered_document(actor,DATE '2026-10-17','Future markers must not replay frontier',meta);
 IF doc->>'surat_number'<>'5148' OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-14' AND NOT occupied)<>9 OR day_before<>(SELECT to_jsonb(d) FROM register_days d WHERE letter_date='2026-10-14') THEN RAISE EXCEPTION 'Expired future trim markers rebuilt a previously closed frontier'; END IF;
 RAISE NOTICE 'PASS future tombstones consumed once, historical frontier not refilled after backdated reuse and later closure';
END $$;
ROLLBACK;
