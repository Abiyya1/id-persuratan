\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.documents(id,surat_number,title,letter_date,created_at,metadata)
SELECT 1900000000+n, number, 'Document sort regression',
 CASE WHEN n=9 THEN NULL ELSE DATE '2026-10-06'+(n%3)::integer END,
 TIMESTAMPTZ '2026-10-06 08:00:00+00'+(n%2)*INTERVAL '1 minute', '{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}'::jsonb
FROM unnest(ARRAY['900002','900010','.900020','900020.2','900020.10','900020.a','900020.z','900020.aa','archive-sort']) WITH ORDINALITY AS fixture(number,n);
INSERT INTO public.register_days(letter_date) VALUES ('2026-12-30') ON CONFLICT DO NOTHING;
INSERT INTO public.letter_slots(number,letter_date,base_number,suffix_index,occupied,document_id)
VALUES ('900020.a','2026-12-30',900020,1,true,1900000006);
DO $$
DECLARE actual text[];
BEGIN
 SELECT array_agg(surat_number ORDER BY number_sort_base ASC NULLS LAST,number_sort_kind ASC,number_sort_suffix ASC NULLS LAST,id ASC)
 INTO actual FROM public.document_list_sorted WHERE title='Document sort regression';
 IF actual<>ARRAY['900002','900010','.900020','900020.2','900020.10','900020.a','900020.z','900020.aa','archive-sort'] THEN
  RAISE EXCEPTION 'Natural ascending order incorrect: %',actual;
 END IF;
 SELECT array_agg(surat_number) INTO actual FROM (
  SELECT surat_number FROM public.document_list_sorted WHERE title='Document sort regression'
  ORDER BY number_sort_base DESC NULLS LAST,number_sort_kind DESC,number_sort_suffix DESC NULLS LAST,id ASC LIMIT 3 OFFSET 3
 ) page;
 IF actual<>ARRAY['900020.10','900020.2','.900020'] THEN RAISE EXCEPTION 'Descending page order incorrect: %',actual; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.document_list_sorted WHERE surat_number='900020.aa' AND number_sort_suffix=27)
 OR NOT EXISTS(SELECT 1 FROM public.document_list_sorted WHERE surat_number='900020.a' AND number_sort_suffix=1)
 THEN RAISE EXCEPTION 'Slot and slotless alphabetic ordinals must agree'; END IF;
 IF has_table_privilege('anon','public.document_list_sorted','SELECT')
 OR has_table_privilege('authenticated','public.document_list_sorted','SELECT')
 OR NOT has_table_privilege('service_role','public.document_list_sorted','SELECT')
 THEN RAISE EXCEPTION 'Document sorting view must be service-only'; END IF;
 SELECT array_agg(surat_number ORDER BY letter_date ASC NULLS LAST,id ASC) INTO actual
 FROM public.document_list_sorted WHERE title='Document sort regression';
 IF actual<>ARRAY['.900020','900020.a','900002','900020.2','900020.z','900010','900020.10','900020.aa','archive-sort']
 THEN RAISE EXCEPTION 'Date ordering, stable ties or null placement incorrect: %',actual; END IF;
 SELECT array_agg(surat_number ORDER BY created_at DESC NULLS LAST,id ASC) INTO actual
 FROM public.document_list_sorted WHERE title='Document sort regression';
 IF actual<>ARRAY['900002','.900020','900020.10','900020.z','archive-sort','900010','900020.2','900020.a','900020.aa']
 THEN RAISE EXCEPTION 'Creation-time ordering or stable ties incorrect: %',actual; END IF;
END $$;
GRANT SELECT ON public.documents,public.letter_slots TO service_role;
SET LOCAL ROLE service_role;
SELECT count(*) FROM public.document_list_sorted WHERE title='Document sort regression';
RESET ROLE;
REVOKE SELECT ON public.documents FROM service_role;
SET LOCAL ROLE service_role;
DO $$ BEGIN
 BEGIN
  PERFORM id FROM public.document_list_sorted LIMIT 1;
  RAISE EXCEPTION 'Sorting view bypassed underlying document permissions';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
RESET ROLE;
ROLLBACK;
