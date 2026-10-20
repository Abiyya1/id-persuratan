-- Apply after 20261009_register_settings.sql; no existing users or register data are rewritten.
BEGIN;
CREATE FUNCTION public.enforce_approved_superadmin()
RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_LEVEL='STATEMENT' THEN
  -- Serialize before target row locks; ordered survivor locks reject stale RR/Serializable snapshots.
  PERFORM pg_advisory_xact_lock(6102026);
  PERFORM id FROM public.users WHERE role='superadmin' AND status='approved' ORDER BY id FOR UPDATE;
  RETURN NULL;
 END IF;

 IF OLD.role='superadmin' AND OLD.status='approved'
  AND (TG_OP='DELETE' OR NEW.role IS DISTINCT FROM 'superadmin' OR NEW.status IS DISTINCT FROM 'approved') THEN
  -- BEFORE ROW sees earlier changes in this statement, so removing every survivor rolls back the bulk write.
  IF (SELECT count(*) FROM public.users WHERE role='superadmin' AND status='approved')<=1 THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='LAST_SUPERADMIN';
  END IF;
 END IF;

 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER users_superadmin_statement_lock
 BEFORE UPDATE OF role,status OR DELETE ON public.users
 FOR EACH STATEMENT EXECUTE FUNCTION public.enforce_approved_superadmin();
CREATE TRIGGER users_superadmin_row_guard
 BEFORE UPDATE OF role,status OR DELETE ON public.users
 FOR EACH ROW EXECUTE FUNCTION public.enforce_approved_superadmin();
REVOKE ALL ON FUNCTION public.enforce_approved_superadmin() FROM PUBLIC,anon,authenticated;
COMMIT;
