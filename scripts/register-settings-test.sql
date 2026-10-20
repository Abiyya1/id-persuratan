\set ON_ERROR_STOP on
-- Disposable-cluster fixture: every change, including resets and counters, rolls back.
BEGIN;
SELECT set_config('persuratan_test.clock_offset','0',true);
TRUNCATE public.letter_slots,public.register_days,public.documents,public.audit_logs,public.register_day_targets;
-- PostgreSQL sequences do not roll back: keep the existing audit sequence untouched.
CREATE TEMP SEQUENCE register_settings_test_audit_id;
ALTER TABLE public.audit_logs ALTER COLUMN id SET DEFAULT nextval('pg_temp.register_settings_test_audit_id'::regclass);
UPDATE public.id_counter SET current_val=100 WHERE id=1;
UPDATE public.register_state SET current_number=100,initialized=false,start_date=NULL,closed_through=NULL WHERE id=1;
UPDATE public.register_settings SET closing_unused_minimum=15,future_daily_total=45 WHERE id=1;
INSERT INTO public.users(id,username,password_hash,role,status) VALUES
 ('61111111-1111-1111-1111-111111111111','settings_user','unused','user','approved'),
 ('62222222-2222-2222-2222-222222222222','settings_admin','unused','admin','approved'),
 ('63333333-3333-3333-3333-333333333333','settings_pending','unused','admin','pending'),
 ('65555555-5555-5555-5555-555555555555','settings_super','unused','superadmin','approved');
DO $$
DECLARE
 admin_id UUID := '62222222-2222-2222-2222-222222222222';
 super_id UUID := '65555555-5555-5555-5555-555555555555';
 user_id UUID := '61111111-1111-1111-1111-111111111111';
 meta JSONB := '{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Uji","ket":"MANUAL"}';
 result JSONB;
 before_state JSONB;
 before_id INT;
 audits INT;
 actor UUID;
 bad INT;
 n INT;
BEGIN
 IF (now() AT TIME ZONE 'Asia/Jakarta')::date<>DATE '2026-10-06' THEN RAISE EXCEPTION 'Fixture requires isolated 6 October 2026 SQL clock'; END IF;
 result := get_register_settings();
 IF result->>'closingUnusedMinimum'<>'15' OR result->>'futureDailyTotal'<>'45' OR result->>'today'<>'2026-10-06' OR result->>'year'<>'2026' OR result->'dayTargets'<>'[]'::JSONB THEN RAISE EXCEPTION 'Initial settings contract mismatch: %',result; END IF;
 FOREACH actor IN ARRAY ARRAY[user_id,'63333333-3333-3333-3333-333333333333'::UUID,'69999999-9999-9999-9999-999999999999'::UUID] LOOP
  BEGIN
   PERFORM save_register_defaults(actor,20,80);
   RAISE EXCEPTION 'Unauthorized defaults accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'FORBIDDEN:%' THEN RAISE; END IF; END;
  BEGIN
   PERFORM set_register_day_target(actor,DATE '2026-10-12',200);
   RAISE EXCEPTION 'Unauthorized target accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'FORBIDDEN:%' THEN RAISE; END IF; END;
  BEGIN
   PERFORM delete_register_day_target(actor,DATE '2026-10-12');
   RAISE EXCEPTION 'Unauthorized target deletion accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'FORBIDDEN:%' THEN RAISE; END IF; END;
 END LOOP;
 FOREACH bad IN ARRAY ARRAY[0,51,NULL] LOOP
  BEGIN PERFORM save_register_defaults(admin_id,bad,45); RAISE EXCEPTION 'Bad closing minimum accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'INVALID_INPUT:%' THEN RAISE; END IF; END;
 END LOOP;
 FOREACH bad IN ARRAY ARRAY[0,151,NULL] LOOP
  BEGIN PERFORM save_register_defaults(admin_id,15,bad); RAISE EXCEPTION 'Bad future total accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'INVALID_INPUT:%' THEN RAISE; END IF; END;
 END LOOP;
 FOREACH bad IN ARRAY ARRAY[0,401,NULL] LOOP
  BEGIN PERFORM set_register_day_target(admin_id,DATE '2026-10-12',bad); RAISE EXCEPTION 'Bad date total accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'INVALID_INPUT:%' THEN RAISE; END IF; END;
 END LOOP;
 BEGIN PERFORM set_register_day_target(admin_id,DATE '2027-01-01',200); RAISE EXCEPTION 'Wrong year accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'INVALID_INPUT:%' THEN RAISE; END IF; END;
 BEGIN PERFORM set_register_day_target(admin_id,DATE '2026-10-05',200); RAISE EXCEPTION 'Past plan accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'TARGET_LOCKED:%' THEN RAISE; END IF; END;
 BEGIN PERFORM set_register_day_target(admin_id,NULL,200); RAISE EXCEPTION 'Null date accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'INVALID_INPUT:%' THEN RAISE; END IF; END;
 BEGIN PERFORM delete_register_day_target(admin_id,DATE '2027-01-01'); RAISE EXCEPTION 'Wrong-year deletion accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'INVALID_INPUT:%' THEN RAISE; END IF; END;
 SELECT to_jsonb(s) INTO before_state FROM register_state s WHERE id=1;
 SELECT current_val INTO before_id FROM id_counter WHERE id=1;
 PERFORM save_register_defaults(admin_id,1,1);
 PERFORM set_register_day_target(admin_id,DATE '2026-10-20',1);
 PERFORM delete_register_day_target(admin_id,DATE '2026-10-20');
 PERFORM save_register_defaults(super_id,50,150);
 PERFORM set_register_day_target(admin_id,DATE '2026-10-12',400);
 PERFORM set_register_day_target(admin_id,DATE '2026-10-12',200);
 PERFORM set_register_day_target(admin_id,DATE '2026-10-20',100);
 PERFORM delete_register_day_target(admin_id,DATE '2026-10-20');
 PERFORM save_register_defaults(admin_id,20,80);
 IF before_state<>(SELECT to_jsonb(s) FROM register_state s WHERE id=1) OR before_id<>(SELECT current_val FROM id_counter WHERE id=1) OR EXISTS(SELECT 1 FROM letter_slots) OR EXISTS(SELECT 1 FROM register_days) THEN RAISE EXCEPTION 'Planning allocated slots or changed counters'; END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_logs WHERE action='UPDATE_REGISTER_DEFAULTS') OR NOT EXISTS(SELECT 1 FROM audit_logs WHERE action='SET_REGISTER_DAY_TARGET') OR NOT EXISTS(SELECT 1 FROM audit_logs WHERE action='DELETE_REGISTER_DAY_TARGET') THEN RAISE EXCEPTION 'Transactional settings audits missing'; END IF;
 UPDATE users SET role='user' WHERE id=admin_id;
 BEGIN PERFORM save_register_defaults(admin_id,15,45); RAISE EXCEPTION 'Stale admin role accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'FORBIDDEN:%' THEN RAISE; END IF; END;
 UPDATE users SET role='admin' WHERE id=admin_id;
 -- Move to 11 October; default/custom/default ranges precede requested 14 October.
 PERFORM set_config('persuratan_test.clock_offset',(5*86400)::TEXT,true);
 PERFORM initialize_letter_register('[]'::JSONB,DATE '2026-10-11');
 result := create_registered_document(user_id,DATE '2026-10-14','Tanggal mendatang',meta);
 IF result->>'surat_number'<>'461' THEN RAISE EXCEPTION 'Expected 80+200+80 before requested date: %',result; END IF;
 IF (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-11' AND suffix_index=0)<>80 OR (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-12' AND suffix_index=0)<>200 OR (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-13' AND suffix_index=0)<>80 OR (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-14' AND suffix_index=0)<>1 THEN RAISE EXCEPTION 'Dated override did not win between default days'; END IF;
 IF NOT (SELECT (x->>'locked')::BOOLEAN FROM jsonb_array_elements(get_register_settings()->'dayTargets') x WHERE x->>'date'='2026-10-12') THEN RAISE EXCEPTION 'Realized target is editable'; END IF;
 SELECT count(*) INTO audits FROM audit_logs;
 BEGIN PERFORM set_register_day_target(admin_id,DATE '2026-10-12',201); RAISE EXCEPTION 'Frozen target updated';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'TARGET_LOCKED:%' THEN RAISE; END IF; END;
 BEGIN PERFORM set_register_day_target(admin_id,DATE '2026-10-11',100); RAISE EXCEPTION 'Earlier range updated';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'TARGET_LOCKED:%' THEN RAISE; END IF; END;
 IF (SELECT count(*) FROM audit_logs)<>audits THEN RAISE EXCEPTION 'Rejected plan produced audit'; END IF;
 SELECT current_number INTO before_id FROM register_state WHERE id=1;
 PERFORM delete_register_day_target(admin_id,DATE '2026-10-12');
 IF EXISTS(SELECT 1 FROM register_day_targets WHERE letter_date=DATE '2026-10-12') OR before_id<>(SELECT current_number FROM register_state WHERE id=1) OR (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-12')<>200 THEN RAISE EXCEPTION 'Locked future deletion changed numbers or retained plan'; END IF;
 PERFORM save_register_defaults(admin_id,7,150);
 PERFORM create_registered_document(user_id,DATE '2026-10-15','Beku tetap',meta);
 IF (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-11')<>80 OR (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-12')<>200 OR (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-13')<>80 OR (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-14')<>150 THEN RAISE EXCEPTION 'New defaults expanded frozen ranges or skipped open range'; END IF;
 PERFORM close_letter_days(DATE '2026-10-16');
 IF (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-15' AND NOT occupied)<>7 THEN RAISE EXCEPTION 'Closing minimum was not configurable'; END IF;
 PERFORM save_register_defaults(admin_id,50,100);
 PERFORM close_letter_days(DATE '2026-10-16');
 IF (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-15')<>8 THEN RAISE EXCEPTION 'Repeated closing expanded closed range'; END IF;
 RAISE NOTICE 'PASS settings caps, role gates, deferred plans/audits, 80/200/80 days, frozen defaults and closing minimum';
END $$;

-- Independent scenarios still remain in this rollback-only transaction.
TRUNCATE public.letter_slots,public.register_days,public.documents,public.register_day_targets;
UPDATE public.register_state SET initialized=true,current_number=100,start_date=DATE '2026-10-06',closed_through=DATE '2026-10-05' WHERE id=1;
SELECT set_config('persuratan_test.clock_offset','0',true);
DO $$
DECLARE
 actor UUID := '62222222-2222-2222-2222-222222222222';
 meta JSONB := '{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Uji","ket":"MANUAL"}';
 doc JSONB;
 n INT;
 high_water INT;
BEGIN
 PERFORM save_register_defaults(actor,50,45);
 PERFORM set_register_day_target(actor,DATE '2026-10-06',3);
 doc := create_registered_document(actor,DATE '2026-10-06','Target hari ini',meta);
 IF (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-06' AND suffix_index=0)<>3 OR doc->>'surat_number'<>'101' THEN RAISE EXCEPTION 'Today custom total was not realized before first use'; END IF;
 FOR n IN 1..2 LOOP PERFORM create_registered_document(actor,DATE '2026-10-06','Penuh',meta); END LOOP;
 doc := create_registered_document(actor,DATE '2026-10-06','Darurat',meta,true,'Target penuh');
 IF doc->>'surat_number'<>'103.a' OR (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-06' AND suffix_index=0)<>3 THEN RAISE EXCEPTION 'Emergency changed ordinary custom total'; END IF;
 PERFORM close_letter_days(DATE '2026-10-07');
 IF (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-06')<>4 THEN RAISE EXCEPTION 'Custom close incorrectly added unused minimum'; END IF;
 PERFORM set_register_day_target(actor,DATE '2026-10-07',4);
 PERFORM close_letter_days(DATE '2026-10-08');
 IF (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-07' AND suffix_index=0)<>4 OR NOT (SELECT fixed_reservation AND closed FROM register_days WHERE letter_date=DATE '2026-10-07') THEN RAISE EXCEPTION 'Unused custom date was not realized on closing'; END IF;
 -- Later-range conflict must roll back earlier calendar-day allocations too.
 INSERT INTO register_days(letter_date) VALUES(DATE '2026-10-10');
 PERFORM reserve_letter_slots(DATE '2026-10-10',1);
 SELECT current_number INTO high_water FROM register_state WHERE id=1;
 BEGIN PERFORM close_letter_days(DATE '2026-10-11'); RAISE EXCEPTION 'Closing across later range accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'REGISTER_CONFLICT:%' THEN RAISE; END IF; END;
 IF high_water<>(SELECT current_number FROM register_state WHERE id=1) OR EXISTS(SELECT 1 FROM register_days WHERE letter_date=DATE '2026-10-08') OR (SELECT closed_through FROM register_state WHERE id=1)<>DATE '2026-10-07' THEN RAISE EXCEPTION 'Failed closing left partial state'; END IF;
 BEGIN PERFORM set_register_day_target(actor,DATE '2026-10-09',10); RAISE EXCEPTION 'Plan crossed later range';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'TARGET_LOCKED:%' THEN RAISE; END IF; END;
 RAISE NOTICE 'PASS custom today/closing, emergency preservation, later-range and atomic closing conflicts';
END $$;
TRUNCATE public.letter_slots,public.register_days,public.documents,public.register_day_targets;
UPDATE public.register_state SET initialized=true,current_number=100,start_date=DATE '2026-10-06',closed_through=DATE '2026-10-05' WHERE id=1;
DO $$
DECLARE
 actor UUID := '62222222-2222-2222-2222-222222222222';
 meta JSONB := '{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Uji","ket":"MANUAL"}';
 state_before JSONB;
 day_before JSONB;
 id_before INT;
 slots_before INT;
BEGIN
 PERFORM create_registered_document(actor,DATE '2026-10-06','Terbuka',meta);
 BEGIN PERFORM set_register_day_target(actor,DATE '2026-10-06',0); RAISE EXCEPTION 'Zero target accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'INVALID_INPUT:%' THEN RAISE; END IF; END;
 PERFORM set_register_day_target(actor,DATE '2026-10-06',2);
 PERFORM set_register_day_target(actor,DATE '2026-10-06',3);
 PERFORM delete_register_day_target(actor,DATE '2026-10-06');
 IF EXISTS(SELECT 1 FROM register_day_targets) OR (SELECT count(*) FROM letter_slots)<>1 THEN RAISE EXCEPTION 'Unlocked edit/delete allocated'; END IF;
 PERFORM create_registered_document(actor,DATE '2026-10-06','Kedua',meta);
 BEGIN PERFORM set_register_day_target(actor,DATE '2026-10-06',1); RAISE EXCEPTION 'Shrinking target accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'TARGET_TOO_SMALL:%' THEN RAISE; END IF; END;
 -- Fixture represents an externally inconsistent preplanned target: consume must abort all mutations.
 INSERT INTO register_day_targets(letter_date,total) VALUES(DATE '2026-10-08',1);
 INSERT INTO register_days(letter_date) VALUES(DATE '2026-10-08');
 PERFORM reserve_letter_slots(DATE '2026-10-08',2);
 SELECT to_jsonb(s) INTO state_before FROM register_state s WHERE id=1;
 SELECT to_jsonb(d) INTO day_before FROM register_days d WHERE letter_date=DATE '2026-10-06';
 SELECT current_val INTO id_before FROM id_counter WHERE id=1;
 SELECT count(*) INTO slots_before FROM letter_slots;
 BEGIN PERFORM create_registered_document(actor,DATE '2026-10-08','Konflik atomik',meta); RAISE EXCEPTION 'Inconsistent target accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'REGISTER_CONFLICT:%' THEN RAISE; END IF; END;
 IF state_before<>(SELECT to_jsonb(s) FROM register_state s WHERE id=1) OR day_before<>(SELECT to_jsonb(d) FROM register_days d WHERE letter_date=DATE '2026-10-06') OR id_before<>(SELECT current_val FROM id_counter WHERE id=1) OR slots_before<>(SELECT count(*) FROM letter_slots) THEN RAISE EXCEPTION 'Failed allocation left partial state'; END IF;
 RAISE NOTICE 'PASS unlocked edits/deletion, no shrink and atomic allocation failure';
END $$;
TRUNCATE public.letter_slots,public.register_days,public.documents,public.register_day_targets;
UPDATE public.register_state SET initialized=false,current_number=100,start_date=NULL,closed_through=NULL WHERE id=1;
DO $$
DECLARE
 actor UUID := '62222222-2222-2222-2222-222222222222';
 rows JSONB := '[{"number":"501","date":"2026-10-06","occupied":false,"values":[]},{"number":"502","date":"2026-10-07","occupied":false,"values":[]}]';
 high_water INT;
BEGIN
 PERFORM set_register_day_target(actor,DATE '2026-10-06',2);
 PERFORM initialize_letter_register(rows,DATE '2026-10-06');
 SELECT current_number INTO high_water FROM register_state WHERE id=1;
 BEGIN PERFORM create_registered_document(actor,DATE '2026-10-08','Konflik rencana impor','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Uji","ket":"MANUAL"}'); RAISE EXCEPTION 'Imported frozen range silently ignored plan';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'REGISTER_CONFLICT:%' THEN RAISE; END IF; END;
 IF high_water<>(SELECT current_number FROM register_state WHERE id=1) OR (SELECT count(*) FROM letter_slots)<>2 THEN RAISE EXCEPTION 'Conflicting planned import changed numbers'; END IF;
 -- Existing importer keeps its last date dynamic; remove conflicting frozen-date config only.
 PERFORM delete_register_day_target(actor,DATE '2026-10-06');
 PERFORM set_register_day_target(actor,DATE '2026-10-07',3);
 PERFORM create_registered_document(actor,DATE '2026-10-07','Impor terakhir dinamis','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Uji","ket":"MANUAL"}');
 PERFORM save_register_defaults(actor,50,150);
 PERFORM create_registered_document(actor,DATE '2026-10-08','Impor tetap','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Uji","ket":"MANUAL"}');
 IF (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-06')<>1 OR (SELECT count(*) FROM letter_slots WHERE letter_date=DATE '2026-10-07')<>3 THEN RAISE EXCEPTION 'Changed defaults expanded fixed imported ranges'; END IF;
 SELECT current_number INTO high_water FROM register_state WHERE id=1;
 PERFORM close_letter_days(DATE '2026-10-08');
 IF high_water<>(SELECT current_number FROM register_state WHERE id=1) THEN RAISE EXCEPTION 'Closing expanded frozen imported ranges'; END IF;
 IF has_table_privilege('anon','public.register_settings','SELECT') OR has_table_privilege('authenticated','public.register_day_targets','INSERT') OR has_function_privilege('anon','public.get_register_settings()','EXECUTE') OR has_function_privilege('authenticated','public.set_register_day_target(uuid,date,integer)','EXECUTE') OR NOT has_function_privilege('service_role','public.save_register_defaults(uuid,integer,integer)','EXECUTE') THEN RAISE EXCEPTION 'Settings security grants mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class WHERE oid IN ('public.register_settings'::regclass,'public.register_day_targets'::regclass) AND NOT relrowsecurity) THEN RAISE EXCEPTION 'Settings RLS missing'; END IF;
 RAISE NOTICE 'PASS pre-import plan conflict, config-only escape, last imported dynamic range, fixed imported safety and service-role-only grants';
END $$;
-- A saved plan may expire before first import. Import must not skip it via closed_through.
TRUNCATE public.letter_slots,public.register_days,public.documents,public.register_day_targets;
UPDATE public.register_state SET initialized=false,current_number=100,start_date=NULL,closed_through=NULL WHERE id=1;
SELECT set_config('persuratan_test.clock_offset','0',true);
DO $$
DECLARE
 actor UUID := '62222222-2222-2222-2222-222222222222';
 rows JSONB := '[{"number":"501","date":"2026-10-06","occupied":false,"values":[]},{"number":"502","date":"2026-10-07","occupied":false,"values":[]}]';
BEGIN
 PERFORM set_register_day_target(actor,DATE '2026-10-06',2);
 PERFORM set_config('persuratan_test.clock_offset','172800',true);
 BEGIN
  PERFORM initialize_letter_register(rows,DATE '2026-10-08');
  RAISE EXCEPTION 'Expired pre-import target silently skipped';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'REGISTER_CONFLICT:%' THEN RAISE; END IF;
 END;
 IF (SELECT initialized OR current_number<>100 FROM register_state WHERE id=1) OR EXISTS(SELECT 1 FROM letter_slots) THEN RAISE EXCEPTION 'Failed import left partial state'; END IF;
 PERFORM delete_register_day_target(actor,DATE '2026-10-06');
 PERFORM initialize_letter_register(rows,DATE '2026-10-08');
 IF (SELECT count(*) FROM letter_slots)<>2 OR (SELECT current_number FROM register_state WHERE id=1)<>502 THEN RAISE EXCEPTION 'Expired-plan removal did not recover import safely'; END IF;
 RAISE NOTICE 'PASS expired pre-import conflict rollback and config-only recovery';
END $$;
ROLLBACK;
