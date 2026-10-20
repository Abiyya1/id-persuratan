-- Apply manually after 20261013_post_trim_daily_reserves.sql. No existing accounts are rewritten.
BEGIN;
LOCK TABLE public.users IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE roots TEXT;
BEGIN
 IF (SELECT count(*) FROM public.users WHERE role='superadmin')>1 THEN
  SELECT string_agg(username||' ('||id::text||', '||status||')',', ' ORDER BY id) INTO roots
  FROM public.users WHERE role='superadmin';
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SINGLE_SUPERADMIN_REQUIRED',
   DETAIL='Existing superadmin accounts: '||roots,
   HINT='Resolve the extra superadmin accounts with the database owner before rerunning this migration. No account was automatically selected, deleted, or demoted.';
 END IF;
END $$;

CREATE UNIQUE INDEX users_single_superadmin_idx ON public.users(role) WHERE role='superadmin';
CREATE FUNCTION public.enforce_single_superadmin()
RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_LEVEL='STATEMENT' THEN
  -- Share migration10's lock before row locks, including a first bootstrap INSERT.
  PERFORM pg_advisory_xact_lock(6102026);
  PERFORM id FROM public.users WHERE role='superadmin' ORDER BY id FOR UPDATE;
  RETURN NULL;
 END IF;
 IF TG_OP='UPDATE' AND OLD.role<>'superadmin' AND NEW.role='superadmin' THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUPERADMIN_PROTECTED';
 END IF;
 IF OLD.role='superadmin' AND
  (TG_OP='DELETE' OR NEW.role IS DISTINCT FROM OLD.role OR NEW.status IS DISTINCT FROM OLD.status) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUPERADMIN_PROTECTED';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER users_single_superadmin_statement_lock
 BEFORE INSERT OR UPDATE OR DELETE ON public.users
 FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_single_superadmin();
CREATE TRIGGER users_single_superadmin_row_guard
 BEFORE UPDATE OR DELETE ON public.users
 FOR EACH ROW EXECUTE FUNCTION public.enforce_single_superadmin();
REVOKE ALL ON FUNCTION public.enforce_single_superadmin() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.create_managed_user_account(p_actor_id UUID,p_username TEXT,p_password_hash TEXT,p_role TEXT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor public.users%ROWTYPE; created public.users%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(6102026);
 SELECT * INTO actor FROM public.users WHERE id=p_actor_id FOR SHARE;
 IF NOT FOUND OR actor.status<>'approved' OR actor.role<>'superadmin' THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='FORBIDDEN: approved superadmin required';
 END IF;
 IF p_role IS NULL OR p_role NOT IN ('user','admin')
  OR p_username IS NULL OR p_username !~ '^[a-zA-Z0-9._-]{3,50}$'
  OR coalesce(length(p_password_hash),0)=0 THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='INVALID_INPUT: only user or admin accounts may be created';
 END IF;
 INSERT INTO public.users(username,password_hash,role,status)
 VALUES(p_username,p_password_hash,p_role,'approved') RETURNING * INTO created;
 INSERT INTO public.audit_logs(user_id,action,target_id,details)
 VALUES(p_actor_id,'CREATE_USER',created.id::text,jsonb_build_object('username',created.username,'role',created.role,'status',created.status));
 RETURN jsonb_build_object('user',to_jsonb(created)-'password_hash');
END $$;

CREATE FUNCTION public.update_managed_user_account(p_actor_id UUID,p_target_id UUID,p_changes JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE actor public.users%ROWTYPE; target public.users%ROWTYPE; updated public.users%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(6102026);
 SELECT * INTO actor FROM public.users WHERE id=p_actor_id FOR SHARE;
 IF NOT FOUND OR actor.status<>'approved' OR actor.role NOT IN ('admin','superadmin') THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='FORBIDDEN: approved administrator required';
 END IF;
 IF p_changes IS NULL OR jsonb_typeof(p_changes)<>'object' OR p_changes='{}'::jsonb THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='INVALID_INPUT: account changes required';
 END IF;
 IF actor.role='admin' THEN
  IF NOT (p_changes?'status') OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k<>'status')
   OR jsonb_typeof(p_changes->'status')<>'string' OR p_changes->>'status' NOT IN ('approved','rejected') THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='INVALID_INPUT: administrators may only approve or reject pending registrations';
  END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k NOT IN ('role','status','delete'))
   OR (p_changes?'role' AND (jsonb_typeof(p_changes->'role')<>'string' OR p_changes->>'role' NOT IN ('user','admin')))
   OR (p_changes?'status' AND (jsonb_typeof(p_changes->'status')<>'string' OR p_changes->>'status' NOT IN ('pending','approved','rejected')))
   OR (p_changes?'delete' AND p_changes<>'{"delete":true}'::jsonb) THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='INVALID_INPUT: only user/admin management is allowed';
  END IF;
 END IF;
 SELECT * INTO target FROM public.users WHERE id=p_target_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='NOT_FOUND: account not found'; END IF;
 IF actor.role='admin' THEN
  IF p_actor_id=p_target_id OR target.role<>'user' THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='FORBIDDEN: only ordinary-user registrations may be decided';
  END IF;
  IF target.status<>'pending' THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='PENDING_REGISTRATION_REQUIRED';
  END IF;
 END IF;
 IF target.role='superadmin' THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUPERADMIN_PROTECTED';
 END IF;
 IF p_changes='{"delete":true}'::jsonb THEN
  DELETE FROM public.users WHERE id=p_target_id;
  INSERT INTO public.audit_logs(user_id,action,target_id,details)
  VALUES(p_actor_id,'DELETE_USER',target.id::text,jsonb_build_object('username',target.username,'role',target.role));
  RETURN jsonb_build_object('user',to_jsonb(target)-'password_hash','deleted',true);
 END IF;
 IF coalesce(p_changes->>'role',target.role)=target.role AND coalesce(p_changes->>'status',target.status)=target.status THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='INVALID_INPUT: no account changes';
 END IF;
 UPDATE public.users SET role=coalesce(p_changes->>'role',target.role),status=coalesce(p_changes->>'status',target.status)
 WHERE id=p_target_id RETURNING * INTO updated;
 IF updated.status<>target.status THEN
  INSERT INTO public.audit_logs(user_id,action,target_id,details)
  VALUES(p_actor_id,CASE updated.status WHEN 'approved' THEN 'APPROVE_USER' WHEN 'rejected' THEN 'REJECT_USER' ELSE 'UPDATE_USER_STATUS' END,target.id::text,
   CASE WHEN updated.status IN ('approved','rejected') THEN jsonb_build_object('username',updated.username,'previousStatus',target.status)
    ELSE jsonb_build_object('username',updated.username,'from',target.status,'to',updated.status) END);
 END IF;
 IF updated.role<>target.role THEN
  INSERT INTO public.audit_logs(user_id,action,target_id,details)
  VALUES(p_actor_id,'UPDATE_USER_ROLE',target.id::text,jsonb_build_object('username',updated.username,'from',target.role,'to',updated.role));
 END IF;
 RETURN jsonb_build_object('user',to_jsonb(updated)-'password_hash');
END $$;

REVOKE ALL ON FUNCTION public.create_managed_user_account(UUID,TEXT,TEXT,TEXT),public.update_managed_user_account(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_managed_user_account(UUID,TEXT,TEXT,TEXT),public.update_managed_user_account(UUID,UUID,JSONB) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
