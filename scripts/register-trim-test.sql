\set ON_ERROR_STOP on
BEGIN;
TRUNCATE public.letter_slots,public.register_days,public.documents,public.register_day_targets;
UPDATE public.register_state SET initialized=true,current_number=6300,allocation_floor=100,start_date='2026-10-06',closed_through='2026-10-05' WHERE id=1;
UPDATE public.register_sync_lease SET owner=NULL,expires_at=NULL WHERE id=1;
SELECT set_config('persuratan_test.clock_offset','0',true);
INSERT INTO public.register_days(letter_date,fixed_reservation) SELECT d::date,true FROM generate_series('2026-10-06'::date,'2026-12-02'::date,'1 day') d;
INSERT INTO public.letter_slots(number,letter_date,base_number) SELECT n::text,CASE WHEN n<=5057 THEN DATE '2026-10-08' WHEN n<=6136 THEN DATE '2026-10-09' WHEN n<=6181 THEN DATE '2026-11-02' WHEN n<=6226 THEN DATE '2026-11-03' WHEN n<=6270 THEN DATE '2026-11-04' ELSE DATE '2026-12-02' END,n FROM generate_series(5057,6300) n;
INSERT INTO public.documents(id,surat_number,letter_date,title,metadata,created_by) SELECT get_next_document_id(),n::text,d,'Trim fixture','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}', '11111111-1111-1111-1111-111111111111'::uuid FROM (VALUES(5057,DATE '2026-10-08'),(6181,DATE '2026-11-02'),(6226,DATE '2026-11-03')) f(n,d);
UPDATE public.letter_slots s SET occupied=true,document_id=d.id FROM public.documents d WHERE d.surat_number=s.number;
INSERT INTO public.register_day_targets VALUES('2026-11-02',45),('2026-12-02',4);
DO $$
DECLARE actor uuid := '11111111-1111-1111-1111-111111111111'; writer uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; wrong uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; deleted_id int; second_id int; private_counter int; old_days jsonb; current_days jsonb; result jsonb; state_before jsonb;
BEGIN
 SELECT id INTO deleted_id FROM documents WHERE surat_number='6226';
 SELECT current_val INTO private_counter FROM id_counter WHERE id=1;
 SELECT jsonb_agg(jsonb_build_object('letter_date',letter_date,'revision',revision)) INTO old_days FROM register_days;
 PERFORM acquire_register_sync(writer);
 result := delete_registered_document(actor,deleted_id);
 IF result->>'releasePending'<>'true' OR EXISTS(SELECT 1 FROM documents WHERE id=deleted_id) THEN RAISE EXCEPTION 'Tail deletion did not hold release'; END IF;
 IF (SELECT count(*) FROM letter_slots WHERE retiring)<>119 OR (SELECT current_number FROM register_state WHERE id=1)<>6300 THEN RAISE EXCEPTION 'Entire future tail not held'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(get_register_month(11)->'slots') s WHERE (s->>'base_number')::int>6181) OR jsonb_array_length(get_register_month(12)->'slots')<>0 THEN RAISE EXCEPTION 'Retiring rows remain in projection'; END IF;
 IF acknowledge_register_days(wrong,old_days) OR acknowledge_register_days(writer,old_days) THEN RAISE EXCEPTION 'Wrong/stale writer accepted'; END IF;
 IF NOT (get_document_deletion_status(actor,deleted_id)->>'releasePending')::boolean THEN RAISE EXCEPTION 'Stale ack completed receipt'; END IF;
 BEGIN PERFORM create_registered_document(actor,DATE '2026-12-03','Pending extension','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}'); RAISE EXCEPTION 'Pending tail extended'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'REGISTER_TRIM_PENDING:%' THEN RAISE; END IF; END;
 SELECT jsonb_agg(jsonb_build_object('letter_date',letter_date,'revision',revision)) INTO current_days FROM register_days WHERE extract(month FROM letter_date)=11;
 PERFORM acknowledge_register_days(writer,current_days);
 IF (SELECT current_number FROM register_state WHERE id=1)<>6300 OR NOT (get_document_deletion_status(actor,deleted_id)->>'releasePending')::boolean THEN RAISE EXCEPTION 'Partial month clear rewound counter'; END IF;
 -- A new occupied middle slot after a partial ack invalidates that day's earlier projection.
 result := create_registered_document(actor,DATE '2026-11-02','Concurrent middle allocation','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}');
 IF result->>'surat_number'<>'6137' THEN RAISE EXCEPTION 'Nonretiring middle allocation blocked'; END IF;
 PERFORM acknowledge_register_days(writer,current_days);
 SELECT jsonb_agg(jsonb_build_object('letter_date',letter_date,'revision',revision)) INTO current_days FROM register_days;
 IF NOT acknowledge_register_days(writer,current_days) THEN RAISE EXCEPTION 'Full current projection rejected'; END IF;
 IF (SELECT current_number FROM register_state WHERE id=1)<>6181 OR EXISTS(SELECT 1 FROM letter_slots WHERE base_number>6181) OR get_document_deletion_status(actor,deleted_id)<>'{"releasePending":false,"trimmed":true}'::jsonb THEN RAISE EXCEPTION 'Nov3 full tail not finalized'; END IF;
 IF (SELECT current_val FROM id_counter WHERE id=1)<=private_counter THEN RAISE EXCEPTION 'Private ID counter rewound'; END IF;
 SELECT to_jsonb(s) INTO state_before FROM register_state s WHERE id=1;
 IF NOT acknowledge_register_days(writer,current_days) OR state_before<>(SELECT to_jsonb(s) FROM register_state s WHERE id=1) THEN RAISE EXCEPTION 'Repeat acknowledgement not idempotent'; END IF;
 IF delete_registered_document(actor,deleted_id)->>'releasePending'<>'false' THEN RAISE EXCEPTION 'Repeat deletion lost receipt'; END IF;
 BEGIN PERFORM get_document_deletion_status('44444444-4444-4444-4444-444444444444',deleted_id); RAISE EXCEPTION 'Foreign receipt readable'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'NOT_FOUND:%' THEN RAISE; END IF; END;
 UPDATE users SET status='pending' WHERE id=actor;
 BEGIN PERFORM get_document_deletion_status(actor,deleted_id); RAISE EXCEPTION 'Stale approval read receipt'; EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'FORBIDDEN:%' THEN RAISE; END IF; END;
 UPDATE users SET status='approved' WHERE id=actor;
 IF NOT (get_document_deletion_status('22222222-2222-2222-2222-222222222222',deleted_id)->>'trimmed')::boolean THEN RAISE EXCEPTION 'Admin status inaccessible'; END IF;
 -- Remove the concurrently occupied gap as a middle deletion before the second tail example.
 PERFORM delete_registered_document(actor,(result->>'id')::int);
 SELECT jsonb_agg(jsonb_build_object('letter_date',letter_date,'revision',revision)) INTO current_days FROM register_days;
 PERFORM acknowledge_register_days(writer,current_days);
 result := create_registered_document(actor,DATE '2026-11-03','Next after Nov3 trim','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}');
 IF result->>'surat_number'<>'6182' THEN RAISE EXCEPTION 'Next allocation not 6182: %',result; END IF;
 PERFORM delete_registered_document(actor,(result->>'id')::int);
 SELECT jsonb_agg(jsonb_build_object('letter_date',letter_date,'revision',revision)) INTO current_days FROM register_days;
 PERFORM acknowledge_register_days(writer,current_days);
 SELECT id INTO second_id FROM documents WHERE surat_number='6181';
 PERFORM delete_registered_document(actor,second_id);
 SELECT jsonb_agg(jsonb_build_object('letter_date',letter_date,'revision',revision)) INTO current_days FROM register_days;
 PERFORM acknowledge_register_days(writer,current_days);
 IF (SELECT current_number FROM register_state WHERE id=1)<>5057 OR EXISTS(SELECT 1 FROM letter_slots WHERE base_number>5057) THEN RAISE EXCEPTION 'Nov2 deletion failed to remove 5058 onward'; END IF;
 PERFORM close_letter_days(DATE '2026-12-03');
 IF (SELECT current_number FROM register_state WHERE id=1)<>5057 OR (SELECT total FROM register_day_targets WHERE letter_date='2026-11-02')<>45 THEN RAISE EXCEPTION 'Closing recreated tail or changed preserved override'; END IF;
 PERFORM release_register_sync(writer);
 PERFORM set_config('persuratan_test.clock_offset','5011200',true);
 result := create_registered_document(actor,DATE '2026-12-03','Next after trim','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}');
 IF result->>'surat_number'<>'5917'
  OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-08' AND NOT occupied)<>15
  OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-11-02')<>45
  OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-12-02')<>4
 THEN RAISE EXCEPTION 'Explicit Dec3 creation failed to restore elapsed 54x15/default and preserved45/4 plans: %',result; END IF;
 RAISE NOTICE 'PASS Nov3/Nov2 deletion-time complete tail prune, partial/stale/failed acknowledgements, concurrent middle allocation, receipts, private IDs, repeat deletion/ack, cron suppression and explicit elapsed-day restoration';
END $$;
ROLLBACK;

BEGIN;
TRUNCATE public.letter_slots,public.register_days,public.documents,public.register_day_targets;
UPDATE public.register_state SET initialized=true,current_number=205,allocation_floor=100,start_date='2026-10-06',closed_through='2026-10-05' WHERE id=1;
UPDATE public.register_sync_lease SET owner=NULL,expires_at=NULL WHERE id=1;
INSERT INTO register_days(letter_date) VALUES('2026-10-06'),('2026-10-07'),('2026-10-08');
UPDATE register_days SET fixed_reservation=true WHERE letter_date<'2026-10-08';
INSERT INTO letter_slots(number,letter_date,base_number,occupied,"values") VALUES('200','2026-10-06',200,true,'[1,"600","/","200","/","Pusdatin","Imported occupied","Destination",false,false,false,true]'),('201.a','2026-10-07',201,true,'[]');
INSERT INTO documents(id,surat_number,letter_date,title,metadata,created_by) VALUES(get_next_document_id(),'205','2026-10-08','Tail','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}','11111111-1111-1111-1111-111111111111');
INSERT INTO letter_slots(number,letter_date,base_number,occupied,document_id) SELECT '205','2026-10-08',205,true,id FROM documents WHERE surat_number='205';
DO $$
DECLARE writer uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; id int; days jsonb; doc jsonb;
BEGIN
 SELECT d.id INTO id FROM documents d WHERE surat_number='205';
 PERFORM delete_registered_document('11111111-1111-1111-1111-111111111111',id);
 PERFORM acquire_register_sync(writer);
 SELECT jsonb_agg(jsonb_build_object('letter_date',letter_date,'revision',revision)) INTO days FROM register_days;
 PERFORM acknowledge_register_days(writer,days);
 IF (SELECT current_number FROM register_state WHERE register_state.id=1)<>201 OR NOT EXISTS(SELECT 1 FROM letter_slots WHERE number='200' AND occupied) OR NOT EXISTS(SELECT 1 FROM letter_slots WHERE number='201.a' AND occupied) THEN RAISE EXCEPTION 'Imported occupied/suffix base not protected'; END IF;
 PERFORM release_register_sync(writer);
 INSERT INTO register_day_targets VALUES('2026-10-08',3);
 doc := create_registered_document('11111111-1111-1111-1111-111111111111',DATE '2026-10-08','Reactivate custom plan','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}');
 IF doc->>'surat_number'<>'202' OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-08')<>3 THEN RAISE EXCEPTION 'Explicit future plan not reactivated'; END IF;
 RAISE NOTICE 'PASS imported occupied protection, surviving suffix base and preserved future plan reactivation';
END $$;
ROLLBACK;

BEGIN;
TRUNCATE public.letter_slots,public.register_days,public.documents,public.register_day_targets;
UPDATE public.register_state SET initialized=false,current_number=100,allocation_floor=100,start_date=NULL,closed_through=NULL WHERE id=1;
UPDATE public.register_sync_lease SET owner=NULL,expires_at=NULL WHERE id=1;
DO $$
DECLARE actor uuid := '11111111-1111-1111-1111-111111111111'; writer uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; doc jsonb; days jsonb; private_counter int;
BEGIN
 PERFORM initialize_letter_register('[]',DATE '2026-10-06');
 doc := create_registered_document(actor,DATE '2026-10-06','Only document','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}');
 SELECT current_val INTO private_counter FROM id_counter WHERE id=1;
 PERFORM delete_registered_document(actor,(doc->>'id')::int);
 PERFORM acquire_register_sync(writer);
 SELECT jsonb_agg(jsonb_build_object('letter_date',letter_date,'revision',revision)) INTO days FROM register_days;
 PERFORM acknowledge_register_days(writer,days);
 IF (SELECT current_number FROM register_state WHERE id=1)<>100 OR (SELECT current_val FROM id_counter WHERE id=1)<>private_counter OR EXISTS(SELECT 1 FROM letter_slots) OR NOT (SELECT initialized FROM register_state WHERE id=1) THEN RAISE EXCEPTION 'Empty ledger did not restore official baseline only'; END IF;
 doc := create_registered_document(actor,DATE '2026-10-06','Fresh private ID','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}');
 IF doc->>'surat_number'<>'101' OR (doc->>'id')::int<=private_counter THEN RAISE EXCEPTION 'Empty baseline allocation or private ID invalid'; END IF;
 IF has_function_privilege('anon','public.get_document_deletion_status(uuid,integer)','EXECUTE') OR has_function_privilege('authenticated','public.get_document_deletion_status(uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Receipt RPC publicly executable'; END IF;
 RAISE NOTICE 'PASS all-empty initialization baseline and service-only receipt RPC';
END $$;
ROLLBACK;

BEGIN;
TRUNCATE public.letter_slots,public.register_days,public.documents,public.register_day_targets;
UPDATE public.register_state SET initialized=false,current_number=100,allocation_floor=100,start_date=NULL,closed_through=NULL WHERE id=1;
UPDATE public.register_sync_lease SET owner=NULL,expires_at=NULL WHERE id=1;
DO $$
DECLARE actor uuid := '11111111-1111-1111-1111-111111111111'; writer uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; meta jsonb := '{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}'; doc jsonb; days jsonb; before_number int;
BEGIN
 PERFORM initialize_letter_register('[]',DATE '2026-10-06');
 PERFORM set_register_day_target('22222222-2222-2222-2222-222222222222',DATE '2026-10-08',4);
 PERFORM create_registered_document(actor,DATE '2026-10-08','Partial survivor one',meta);
 PERFORM create_registered_document(actor,DATE '2026-10-08','Partial survivor two',meta);
 doc := create_registered_document(actor,DATE '2026-10-08','Partial last used',meta);
 PERFORM delete_registered_document(actor,(doc->>'id')::int);
 PERFORM acquire_register_sync(writer);
 SELECT jsonb_agg(jsonb_build_object('letter_date',letter_date,'revision',revision)) INTO days FROM register_days;
 PERFORM acknowledge_register_days(writer,days);
 SELECT current_number INTO before_number FROM register_state WHERE id=1;
 IF (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-08')<>2 OR (SELECT total FROM register_day_targets WHERE letter_date='2026-10-08')<>4 THEN RAISE EXCEPTION 'Partial trim did not preserve realized range and plan separately'; END IF;
 PERFORM save_register_defaults('22222222-2222-2222-2222-222222222222',20,80);
 PERFORM close_letter_days(DATE '2026-10-09');
 IF (SELECT current_number FROM register_state WHERE id=1)<>before_number OR NOT (SELECT closed AND tail_trimmed FROM register_days WHERE letter_date='2026-10-08') THEN RAISE EXCEPTION 'Partial custom closed range was expanded or rejected'; END IF;
 PERFORM set_config('persuratan_test.clock_offset',(3*86400)::text,true);
 doc := create_registered_document(actor,DATE '2026-10-09','After partial frozen day',meta);
 IF (doc->>'surat_number')::int<>before_number+3 OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-08')<>4 OR (SELECT total FROM register_day_targets WHERE letter_date='2026-10-08')<>4 THEN RAISE EXCEPTION 'Explicit creation failed to restore saved custom4 over changed minimum20'; END IF;
 RAISE NOTICE 'PASS partial custom prune remains pruned at closure, then explicit creation restores custom total instead of changed closing minimum';
END $$;
ROLLBACK;

BEGIN;
TRUNCATE public.letter_slots,public.register_days,public.documents,public.register_day_targets;
UPDATE public.register_state SET initialized=false,current_number=100,allocation_floor=100,start_date=NULL,closed_through=NULL WHERE id=1;
UPDATE public.register_sync_lease SET owner=NULL,expires_at=NULL WHERE id=1;
UPDATE public.register_settings SET closing_unused_minimum=15,future_daily_total=45 WHERE id=1;
DO $$
DECLARE actor uuid := '11111111-1111-1111-1111-111111111111'; writer uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; meta jsonb := '{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}'; survivor jsonb; doc jsonb; days jsonb;
BEGIN
 PERFORM initialize_letter_register('[]',DATE '2026-10-06');
 survivor := create_registered_document(actor,DATE '2026-10-06','Today survives forward trim',meta);
 PERFORM set_register_day_target('22222222-2222-2222-2222-222222222222',DATE '2026-10-07',200);
 doc := create_registered_document(actor,DATE '2026-10-09','Furthest future to delete',meta);
 PERFORM delete_registered_document(actor,(doc->>'id')::int);
 PERFORM acquire_register_sync(writer);
 SELECT jsonb_agg(jsonb_build_object('letter_date',letter_date,'revision',revision)) INTO days FROM register_days;
 PERFORM acknowledge_register_days(writer,days);
 IF (SELECT current_number FROM register_state WHERE id=1)<>101 OR EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>'2026-10-06') THEN RAISE EXCEPTION 'Forward trim left unused future reservations'; END IF;
 doc := create_registered_document(actor,DATE '2026-10-09','Explicit forward reallocation',meta);
 IF doc->>'surat_number'<>'347' OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-07')<>200 OR (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-08')<>45 THEN RAISE EXCEPTION 'Explicit forward allocation did not restore 200/45 intervening plans: %',doc; END IF;
 IF (SELECT count(*) FROM letter_slots WHERE letter_date='2026-10-06')<>1 OR NOT EXISTS(SELECT 1 FROM documents WHERE id=(survivor->>'id')::int AND surat_number='101') THEN RAISE EXCEPTION 'Explicit reallocation refilled or renumbered partially trimmed survivor'; END IF;
 RAISE NOTICE 'PASS explicit forward reallocation restores empty open custom/default days without refilling surviving partial ranges';
END $$;
ROLLBACK;
