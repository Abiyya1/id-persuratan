\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE
 today DATE := (now() AT TIME ZONE 'Asia/Jakarta')::date;
 owner_id UUID := '11111111-1111-1111-1111-111111111111';
 meta JSONB := '{"kdSurat":"600","kdSatker":"Pusdatin","ket":"MANUAL","tujuanSurat":"Sekretariat"}';
 destination JSONB;
 doc JSONB;
 ket TEXT;
 before_count INT;
 before_number INT;
BEGIN
 BEGIN
  PERFORM create_registered_document(owner_id,today,'Form omitted destination',meta-'tujuanSurat');
  RAISE EXCEPTION 'Omitted destination accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'INVALID_INPUT%' THEN RAISE; END IF;
 END;
 FOR destination IN SELECT value FROM jsonb_array_elements('[null,"","   "]'::jsonb) LOOP
  BEGIN
   PERFORM create_registered_document(owner_id,today,'Form empty destination',meta||jsonb_build_object('tujuanSurat',destination));
   RAISE EXCEPTION 'Empty destination accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'INVALID_INPUT%' THEN RAISE; END IF;
  END;
 END LOOP;
 doc := create_registered_document(owner_id,today,'Form trimmed destination',meta||jsonb_build_object('tujuanSurat','  Sekretariat  '));
 IF doc->'metadata'->>'tujuanSurat'<>'Sekretariat' THEN RAISE EXCEPTION 'Destination normalization failed'; END IF;
 SELECT count(*) INTO before_count FROM documents;
 SELECT current_number INTO before_number FROM register_state WHERE id=1;
 FOR destination IN SELECT value FROM jsonb_array_elements('[123,true,{},[]]'::jsonb) LOOP
  BEGIN
   PERFORM create_registered_document(owner_id,today,'Form invalid destination',meta||jsonb_build_object('tujuanSurat',destination));
   RAISE EXCEPTION 'Non-string destination accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'INVALID_INPUT%' THEN RAISE; END IF;
  END;
 END LOOP;
 BEGIN
  PERFORM create_registered_document(owner_id,today,'Form long destination',meta||jsonb_build_object('tujuanSurat',repeat('x',501)));
  RAISE EXCEPTION 'Oversized destination accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'INVALID_INPUT%' THEN RAISE; END IF;
 END;
 BEGIN
  PERFORM create_registered_document(owner_id,today,'Form CAT rejected',meta||'{"ket":"CAT"}'::jsonb);
  RAISE EXCEPTION 'CAT accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'INVALID_INPUT%' THEN RAISE; END IF;
 END;
 FOREACH ket IN ARRAY ARRAY['SRIKANDI','EOFFICE'] LOOP
  BEGIN
   PERFORM create_registered_document(owner_id,today-1,'Form yesterday invalid Ket',meta||jsonb_build_object('ket',ket));
   RAISE EXCEPTION 'Yesterday non-MANUAL accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'NON_TODAY_MANUAL_ONLY%' THEN RAISE; END IF;
  END;
  BEGIN
   PERFORM create_registered_document(owner_id,today+1,'Form tomorrow invalid Ket',meta||jsonb_build_object('ket',ket));
   RAISE EXCEPTION 'Tomorrow non-MANUAL accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'NON_TODAY_MANUAL_ONLY%' THEN RAISE; END IF;
  END;
 END LOOP;
 IF (SELECT count(*) FROM documents)<>before_count OR (SELECT current_number FROM register_state WHERE id=1)<>before_number THEN RAISE EXCEPTION 'Rejected form mutated allocation'; END IF;
 FOREACH ket IN ARRAY ARRAY['SRIKANDI','EOFFICE','MANUAL'] LOOP
  doc := create_registered_document(owner_id,today,'Form revision '||ket,meta||jsonb_build_object('ket',ket));
  IF doc->'metadata'->>'ket'<>ket THEN RAISE EXCEPTION 'Today Ket rejected or coerced'; END IF;
 END LOOP;
END $$;
-- Advance this isolated cluster across WIB midnight, not the UTC date boundary.
SET LOCAL persuratan_test.clock_offset='32400';
DO $$
DECLARE doc documents%ROWTYPE; outcome JSONB;
BEGIN
 SELECT * INTO STRICT doc FROM documents WHERE title='Form legacy CAT';
 outcome := bump_sync_attempts_and_set_status(doc.id,'synced',NULL,doc.updated_at);
 IF outcome->>'sync_status'<>'synced' THEN RAISE EXCEPTION 'Historical CAT synchronization was blocked'; END IF;
 BEGIN
  UPDATE documents SET title='Form historical edit' WHERE id=doc.id;
  RAISE EXCEPTION 'Historical CAT content edit accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'INVALID_INPUT%' THEN RAISE; END IF;
 END;
 UPDATE documents SET title='Form historical manual edit',metadata=metadata||'{"ket":"MANUAL","tujuanSurat":"Sekretariat"}'::jsonb WHERE id=doc.id;
 IF NOT EXISTS(SELECT 1 FROM documents WHERE id=doc.id AND metadata->>'ket'='MANUAL' AND metadata->>'tujuanSurat'='Sekretariat') THEN RAISE EXCEPTION 'Historical MANUAL edit failed'; END IF;
END $$;
ROLLBACK;
