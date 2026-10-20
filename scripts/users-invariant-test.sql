\set ON_ERROR_STOP on
BEGIN;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.users,public.audit_logs TO service_role;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;
SET LOCAL ROLE service_role;
DO $$
DECLARE
 champion UUID;
 ordinary UUID := gen_random_uuid();
 pending_user UUID := gen_random_uuid();
 approved_user UUID := gen_random_uuid();
 rejected_user UUID := gen_random_uuid();
 admin_id UUID := gen_random_uuid();
 pending_admin UUID := gen_random_uuid();
 rejected_admin UUID := gen_random_uuid();
 missing_id UUID := gen_random_uuid();
 operation INT;
 state TEXT;
 actor_id UUID;
 target_id UUID;
 changes JSONB;
 result JSONB;
 before_audits INT;
 before_users JSONB;
BEGIN
 SELECT id INTO champion FROM public.users WHERE role='superadmin';
 IF champion IS NULL OR (SELECT count(*) FROM public.users WHERE role='superadmin')<>1 THEN
  RAISE EXCEPTION 'Harness must bootstrap exactly one superadmin';
 END IF;
 INSERT INTO public.users(id,username,password_hash,role,status) VALUES
  (ordinary,'invariant_ordinary_'||ordinary,'unused','user','pending'),
  (pending_user,'invariant_pending_'||pending_user,'unused','user','pending'),
  (approved_user,'invariant_approved_'||approved_user,'unused','user','approved'),
  (rejected_user,'invariant_rejected_'||rejected_user,'unused','user','rejected'),
  (admin_id,'invariant_admin_'||admin_id,'unused','admin','approved'),
  (pending_admin,'invariant_pending_admin_'||pending_admin,'unused','admin','pending'),
  (rejected_admin,'invariant_rejected_admin_'||rejected_admin,'unused','admin','rejected');

 FOREACH state IN ARRAY ARRAY['pending','approved','rejected'] LOOP
  BEGIN
   INSERT INTO public.users(username,password_hash,role,status) VALUES('duplicate_'||state,'unused','superadmin',state);
   RAISE EXCEPTION 'Duplicate superadmin accepted with status %',state;
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
 END LOOP;
 BEGIN
  UPDATE public.users SET role='superadmin' WHERE id=ordinary;
  RAISE EXCEPTION 'An existing account was promoted to superadmin';
 EXCEPTION WHEN check_violation THEN
  IF SQLERRM<>'SUPERADMIN_PROTECTED' THEN RAISE; END IF;
 END;

 FOR operation IN 1..4 LOOP
  SELECT jsonb_agg(to_jsonb(u) ORDER BY id) INTO before_users FROM public.users u;
  BEGIN
   CASE operation
    WHEN 1 THEN UPDATE public.users SET role='admin' WHERE id IN(champion,ordinary);
    WHEN 2 THEN UPDATE public.users SET status='pending' WHERE id IN(champion,ordinary);
    WHEN 3 THEN UPDATE public.users SET status='rejected' WHERE id IN(champion,ordinary);
    WHEN 4 THEN DELETE FROM public.users WHERE id IN(champion,ordinary);
   END CASE;
   RAISE EXCEPTION 'Protected superadmin bulk loss accepted: %',operation;
  EXCEPTION WHEN check_violation THEN
   IF SQLERRM NOT IN ('SUPERADMIN_PROTECTED','LAST_SUPERADMIN') THEN RAISE; END IF;
  END;
  IF before_users<>(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM public.users u) THEN
   RAISE EXCEPTION 'Rejected bulk mutation did not roll back every affected account';
  END IF;
 END LOOP;
 UPDATE public.users SET username='invariant_profile_'||champion,password_hash='changed' WHERE id=champion;
 UPDATE public.users SET role='superadmin',status='approved' WHERE id=champion;
 IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=champion AND username='invariant_profile_'||champion AND password_hash='changed' AND role='superadmin' AND status='approved') THEN
  RAISE EXCEPTION 'Ordinary profile or unchanged role/status update was refused';
 END IF;

 SELECT count(*) INTO before_audits FROM public.audit_logs;
 FOREACH actor_id IN ARRAY ARRAY[missing_id,pending_admin,rejected_admin,approved_user] LOOP
  BEGIN
   PERFORM public.update_managed_user_account(actor_id,pending_user,'{"status":"approved"}');
   RAISE EXCEPTION 'Unauthorized actor decided a pending registration';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
 END LOOP;
 FOREACH changes IN ARRAY ARRAY[
  '{"status":"approved","role":"admin"}'::jsonb,
  '{"status":"approved","username":"changed"}'::jsonb,
  '{"status":"approved","password":"Passw0rd1"}'::jsonb,
  '{"status":"approved","delete":false}'::jsonb,
  '{"status":"approved","action":"approve"}'::jsonb,
  '{"status":"pending"}'::jsonb,
  '{"role":"admin"}'::jsonb,
  '{}'::jsonb,
  '[]'::jsonb
 ] LOOP
  BEGIN
   PERFORM public.update_managed_user_account(admin_id,pending_user,changes);
   RAISE EXCEPTION 'Admin extra fields or nondecision payload accepted: %',changes;
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
 END LOOP;
 FOREACH target_id IN ARRAY ARRAY[admin_id,pending_admin,rejected_admin,champion,approved_user,rejected_user,missing_id] LOOP
  BEGIN
   PERFORM public.update_managed_user_account(admin_id,target_id,'{"status":"approved"}');
   RAISE EXCEPTION 'Admin managed self, another role, or a nonpending account';
  EXCEPTION WHEN insufficient_privilege OR check_violation OR no_data_found THEN NULL;
  END;
 END LOOP;
 IF (SELECT count(*) FROM public.audit_logs)<>before_audits
  OR NOT EXISTS(SELECT 1 FROM public.users WHERE id=pending_user AND role='user' AND status='pending') THEN
  RAISE EXCEPTION 'Rejected decisions changed data or emitted false audits';
 END IF;

 result := public.update_managed_user_account(admin_id,pending_user,'{"status":"approved"}');
 IF result->'user'->>'role'<>'user' OR result->'user'->>'status'<>'approved' OR (result->'user')?'password_hash'
  OR (SELECT count(*) FROM public.audit_logs a WHERE a.user_id=admin_id AND a.target_id=pending_user::text AND a.action='APPROVE_USER')<>1 THEN
  RAISE EXCEPTION 'Approval response, unchanged ordinary role, or transactional audit is wrong';
 END IF;
 result := public.update_managed_user_account(admin_id,ordinary,'{"status":"rejected"}');
 IF result->'user'->>'status'<>'rejected'
  OR (SELECT count(*) FROM public.audit_logs a WHERE a.user_id=admin_id AND a.target_id=ordinary::text AND a.action='REJECT_USER')<>1 THEN
  RAISE EXCEPTION 'Pending rejection or its audit is wrong';
 END IF;

 FOREACH changes IN ARRAY ARRAY['{"role":"superadmin"}'::jsonb,'{"status":"rejected"}'::jsonb,'{"delete":true}'::jsonb] LOOP
  BEGIN
   PERFORM public.update_managed_user_account(champion,champion,changes);
   RAISE EXCEPTION 'Superadmin self-management accepted';
  EXCEPTION WHEN check_violation OR invalid_parameter_value THEN NULL;
  END;
 END LOOP;
 FOREACH state IN ARRAY ARRAY['superadmin','bogus'] LOOP
  BEGIN
   PERFORM public.create_managed_user_account(champion,'forbidden_root','unused',state);
   RAISE EXCEPTION 'Application created disallowed role %',state;
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
 END LOOP;
 BEGIN
  PERFORM public.create_managed_user_account(admin_id,'forbidden_admin','unused','admin');
  RAISE EXCEPTION 'Admin created an account';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 result := public.create_managed_user_account(champion,'manual_admin_'||admin_id,'unused','admin');
 IF result->'user'->>'role'<>'admin' OR result->'user'->>'status'<>'approved' OR (result->'user')?'password_hash' THEN
  RAISE EXCEPTION 'Superadmin manual admin creation failed';
 END IF;
 result := public.update_managed_user_account(champion,approved_user,'{"role":"admin"}');
 IF result->'user'->>'role'<>'admin' OR result->'user'->>'status'<>'approved' THEN
  RAISE EXCEPTION 'Superadmin ordinary-user promotion failed';
 END IF;
 result := public.update_managed_user_account(champion,rejected_user,'{"role":"admin","status":"approved"}');
 IF result->'user'->>'role'<>'admin' OR result->'user'->>'status'<>'approved' THEN
  RAISE EXCEPTION 'Superadmin combined management failed';
 END IF;
 result := public.update_managed_user_account(champion,rejected_user,'{"delete":true}');
 IF NOT (result->>'deleted')::boolean OR EXISTS(SELECT 1 FROM public.users WHERE id=rejected_user)
  OR (SELECT count(*) FROM public.audit_logs a WHERE a.target_id=rejected_user::text AND a.action='DELETE_USER')<>1 THEN
  RAISE EXCEPTION 'Superadmin deletion or transactional audit failed';
 END IF;

 IF has_function_privilege('anon','public.enforce_approved_superadmin()','EXECUTE')
  OR has_function_privilege('authenticated','public.enforce_approved_superadmin()','EXECUTE')
  OR has_function_privilege('anon','public.enforce_single_superadmin()','EXECUTE')
  OR has_function_privilege('authenticated','public.enforce_single_superadmin()','EXECUTE')
  OR has_function_privilege('anon','public.create_managed_user_account(uuid,text,text,text)','EXECUTE')
  OR has_function_privilege('authenticated','public.create_managed_user_account(uuid,text,text,text)','EXECUTE')
  OR has_function_privilege('anon','public.update_managed_user_account(uuid,uuid,jsonb)','EXECUTE')
  OR has_function_privilege('authenticated','public.update_managed_user_account(uuid,uuid,jsonb)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.update_managed_user_account(uuid,uuid,jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'Account mutation RPC or invariant has incorrect role permissions';
 END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.users'::regclass AND NOT tgisinternal
  AND tgname IN ('users_superadmin_statement_lock','users_superadmin_row_guard'))<>2 THEN
  RAISE EXCEPTION 'Migration10 active-superadmin protections were removed';
 END IF;
 RAISE NOTICE 'PASS one root for all statuses, immutable root/bulk rollback/profile preservation, scoped pending decisions, strict payloads, transactional audits, root creation/escalation rejection and superadmin user/admin management';
END $$;
ROLLBACK;
