  -- PostgreSQL 15+: apply after the letter-register migrations, before enabling number sorting.
  -- No document contents, numbers, dates, or allocator state are modified.
  BEGIN;
  CREATE OR REPLACE VIEW public.document_list_sorted WITH (security_invoker=true) AS
  SELECT d.*,
  coalesce(s.base_number::numeric, parsed.parts[1]::numeric) AS number_sort_base,
  CASE
    WHEN parsed.parts[2] IS NULL THEN 0
    WHEN parsed.parts[2] ~ '^[0-9]+$' THEN 1
    ELSE 2
  END AS number_sort_kind,
  coalesce(s.suffix_index::numeric,
    CASE
    WHEN parsed.parts[2] IS NULL THEN 0::numeric
    WHEN parsed.parts[2] ~ '^[0-9]+$' THEN parsed.parts[2]::numeric
    ELSE (
      -- Bijective base 26 matches the allocator: a=1, z=26, aa=27.
      SELECT sum((ascii(substr(parsed.parts[2], position, 1))-96)::numeric
      * power(26::numeric, length(parsed.parts[2])-position))
      FROM generate_series(1,length(parsed.parts[2])) AS letters(position)
    )
    END
  ) AS number_sort_suffix
  FROM public.documents d
  CROSS JOIN LATERAL (
  SELECT regexp_match(ltrim(btrim(d.surat_number),'.'),
    '^([1-9][0-9]*)(?:\.([a-z]+|[1-9][0-9]*))?$') AS parts
  ) parsed
  LEFT JOIN public.letter_slots s ON s.document_id=d.id
  AND s.number=ltrim(btrim(d.surat_number),'.');

  REVOKE ALL ON public.document_list_sorted FROM PUBLIC,anon,authenticated,service_role;
  GRANT SELECT ON public.document_list_sorted TO service_role;
  NOTIFY pgrst,'reload schema';
  COMMIT;
