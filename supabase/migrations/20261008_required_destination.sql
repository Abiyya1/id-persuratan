BEGIN;

-- Validate new submissions/content edits only; existing archives and sync-only updates remain untouched.
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
  OR jsonb_typeof(p_metadata->'tujuanSurat') IS DISTINCT FROM 'string'
  OR length(destination) NOT BETWEEN 1 AND 500
  OR jsonb_typeof(p_metadata->'ket') IS DISTINCT FROM 'string'
  OR btrim(coalesce(p_metadata->>'ket','')) NOT IN ('SRIKANDI','EOFFICE','MANUAL') THEN
  RAISE EXCEPTION 'INVALID_INPUT: invalid letter fields or configured year';
 END IF;
 IF p_date<>(now() AT TIME ZONE 'Asia/Jakarta')::date AND btrim(p_metadata->>'ket')<>'MANUAL' THEN
  RAISE EXCEPTION 'NON_TODAY_MANUAL_ONLY: dates other than today WIB require MANUAL';
 END IF;
 RETURN p_metadata || jsonb_build_object('kdSurat',btrim(p_metadata->>'kdSurat'),'kdSatker',btrim(p_metadata->>'kdSatker'),'tujuanSurat',destination,'ket',btrim(p_metadata->>'ket'));
END $$;

REVOKE ALL ON FUNCTION public.validate_registered_letter_fields(DATE,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.validate_registered_letter_fields(DATE,TEXT,JSONB) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
