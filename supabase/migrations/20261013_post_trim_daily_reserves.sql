-- Apply after 20261012_register_tail_trim.sql. Only explicit creation restores elapsed reserves.
BEGIN;
-- Older writers acknowledged value-only clears; reproject trimmed months with full cell cleanup.
UPDATE public.register_days SET revision=revision+1 WHERE tail_trimmed;

CREATE FUNCTION public.restore_trimmed_letter_days(p_today DATE)
RETURNS VOID LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE state register_state%ROWTYPE; settings register_settings%ROWTYPE; first_trim DATE; frontier DATE; day DATE; saved_day register_days%ROWTYPE; target INT; available INT; missing INT;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 SELECT * INTO state FROM register_state WHERE id=1 FOR UPDATE;
 IF NOT state.initialized THEN RAISE EXCEPTION 'REGISTER_NOT_INITIALIZED'; END IF;
 IF p_today IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT: Tanggal pemulihan wajib diisi'; END IF;
 SELECT min(letter_date) INTO first_trim FROM register_days WHERE tail_trimmed AND letter_date<p_today;
 IF first_trim IS NULL THEN RETURN; END IF;
 IF EXISTS(SELECT 1 FROM letter_slots WHERE retiring) THEN RAISE EXCEPTION 'REGISTER_TRIM_PENDING: Pengosongan nomor terakhir belum dikonfirmasi Google Sheets'; END IF;
 SELECT * INTO STRICT settings FROM register_settings WHERE id=1;
 -- The surviving occupied frontier can have no retiring row, so migration12 did not flag it.
 SELECT max(letter_date) INTO frontier FROM letter_slots WHERE occupied AND NOT retiring AND letter_date<=first_trim;
 day := greatest(coalesce(frontier,first_trim),DATE '2026-01-01');
 WHILE day<=least(p_today-1,DATE '2026-12-31') LOOP
  SELECT * INTO saved_day FROM register_days WHERE letter_date=day FOR UPDATE;
  IF NOT FOUND OR saved_day.tail_trimmed OR day=frontier OR NOT EXISTS(SELECT 1 FROM letter_slots WHERE letter_date=day) THEN
   SELECT total INTO target FROM register_day_targets WHERE letter_date=day;
   IF target IS NOT NULL THEN
    SELECT count(*) INTO available FROM letter_slots WHERE letter_date=day AND suffix_index=0;
    IF available>target THEN RAISE EXCEPTION 'TARGET_TOO_SMALL: Rencana tanggal % lebih kecil dari % nomor yang sudah tersedia',day,available; END IF;
    missing := target-available;
   ELSE
    SELECT count(*) INTO available FROM letter_slots WHERE letter_date=day AND NOT occupied;
    missing := greatest(settings.closing_unused_minimum-available,0);
   END IF;
   IF missing>0 AND EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>day) THEN
    RAISE EXCEPTION 'REGISTER_RESTORE_CONFLICT: Sisa nomor tanggal % tidak dapat dipulihkan karena ada rentang tanggal berikutnya. Tinjau atau hapus surat terakhir yang dibuat setelah pemangkasan, lalu sinkronkan ulang sebelum membuat ulang; nomor yang sudah dipakai tidak diubah',day;
   END IF;
   INSERT INTO register_days(letter_date) VALUES(day) ON CONFLICT DO NOTHING;
   PERFORM reserve_letter_slots(day,missing);
   IF missing>0 OR saved_day.letter_date IS NULL OR saved_day.tail_trimmed THEN
    UPDATE register_days SET tail_trimmed=false,closed=true,fixed_reservation=(target IS NOT NULL),revision=revision+1 WHERE letter_date=day;
   END IF;
  END IF;
  day := day+1;
 END LOOP;
 -- Consume empty future tombstones once; later closure must not replay the repaired frontier.
 UPDATE register_days d SET tail_trimmed=false,fixed_reservation=false,revision=revision+1
 WHERE d.tail_trimmed AND NOT d.closed AND d.letter_date>=p_today
  AND NOT EXISTS(SELECT 1 FROM letter_slots s WHERE s.letter_date=d.letter_date);
END $$;

CREATE OR REPLACE FUNCTION public.create_registered_document(p_user_id UUID,p_date DATE,p_title TEXT,p_metadata JSONB,p_emergency BOOLEAN DEFAULT false,p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE today DATE := (now() AT TIME ZONE 'Asia/Jakarta')::date; state register_state%ROWTYPE; settings register_settings%ROWTYPE; u users%ROWTYPE; slot letter_slots%ROWTYPE; day DATE; target INT; base INT; next_suffix INT; suffix TEXT; n INT; doc documents%ROWTYPE; emergency_allocated BOOLEAN := false;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 SELECT * INTO u FROM users WHERE id=p_user_id FOR SHARE;
 IF NOT FOUND OR u.status<>'approved' THEN RAISE EXCEPTION 'FORBIDDEN: approved account required'; END IF;
 IF p_emergency AND (u.role NOT IN ('admin','superadmin') OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 500) THEN RAISE EXCEPTION 'FORBIDDEN: administrator confirmation and reason required'; END IF;
 p_metadata := validate_registered_letter_fields(p_date,p_title,p_metadata);
 SELECT * INTO state FROM register_state WHERE id=1 FOR UPDATE;
 IF NOT state.initialized THEN RAISE EXCEPTION 'REGISTER_NOT_INITIALIZED'; END IF;
 PERFORM restore_trimmed_letter_days(today);
 PERFORM close_letter_days(today);
 SELECT * INTO STRICT settings FROM register_settings WHERE id=1;
 IF p_date>today THEN
  day := today;
  WHILE day<p_date LOOP
   INSERT INTO register_days(letter_date) VALUES(day) ON CONFLICT DO NOTHING;
   SELECT total INTO target FROM register_day_targets WHERE letter_date=day;
   IF NOT EXISTS(SELECT 1 FROM letter_slots WHERE retiring)
    AND NOT EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>=day) THEN
    UPDATE register_days SET tail_trimmed=false,fixed_reservation=false
    WHERE letter_date=day AND tail_trimmed AND NOT closed;
   END IF;
   IF NOT (SELECT tail_trimmed FROM register_days WHERE letter_date=day) THEN
    PERFORM apply_register_day_total(day,coalesce(target,settings.future_daily_total),target IS NOT NULL);
   END IF;
   day := day+1;
  END LOOP;
 END IF;
 INSERT INTO register_days(letter_date) SELECT p_date WHERE p_date>=today ON CONFLICT DO NOTHING;
 IF p_date>=today AND NOT EXISTS(SELECT 1 FROM letter_slots WHERE retiring)
  AND NOT EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>p_date) THEN
  UPDATE register_days SET tail_trimmed=false,fixed_reservation=false
  WHERE letter_date=p_date AND tail_trimmed AND NOT closed;
 END IF;
 SELECT total INTO target FROM register_day_targets WHERE letter_date=p_date;
 IF target IS NOT NULL AND EXISTS(SELECT 1 FROM register_days WHERE letter_date=p_date) THEN
  PERFORM apply_register_day_total(p_date,target,true);
 END IF;
 SELECT * INTO slot FROM letter_slots WHERE letter_date=p_date AND NOT occupied AND NOT retiring ORDER BY base_number,suffix_index LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN
  IF p_date>=today AND NOT EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>p_date) AND NOT coalesce((SELECT fixed_reservation OR closed FROM register_days WHERE letter_date=p_date),true) THEN
   PERFORM reserve_letter_slots(p_date,1);
   SELECT * INTO slot FROM letter_slots WHERE letter_date=p_date AND NOT occupied ORDER BY base_number,suffix_index LIMIT 1 FOR UPDATE;
  ELSE
   IF EXISTS(SELECT 1 FROM letter_slots WHERE retiring AND letter_date=p_date) THEN RAISE EXCEPTION 'REGISTER_TRIM_PENDING: Pengosongan nomor terakhir belum dikonfirmasi Google Sheets'; END IF;
   SELECT max(base_number) INTO base FROM letter_slots WHERE letter_date=p_date AND NOT retiring;
   IF base IS NULL THEN RAISE EXCEPTION 'DAY_MISSING: no historical range for this date'; END IF;
   IF NOT p_emergency THEN RAISE EXCEPTION 'DAY_FULL: no unused numbers on this date'; END IF;
   SELECT coalesce(max(suffix_index),0)+1 INTO next_suffix FROM letter_slots WHERE letter_date=p_date AND base_number=base AND number ~ '\.[a-z]+$';
   n := next_suffix; suffix := '';
   WHILE n>0 LOOP suffix := chr(97+(n-1)%26)||suffix; n := (n-1)/26; END LOOP;
   INSERT INTO letter_slots(number,letter_date,base_number,suffix_index) VALUES(base::text||'.'||suffix,p_date,base,next_suffix) RETURNING * INTO slot;
   emergency_allocated := true;
  END IF;
 END IF;
 INSERT INTO documents(id,surat_number,letter_date,title,metadata,created_by,sync_status)
 VALUES(get_next_document_id(),slot.number,p_date,btrim(p_title),p_metadata,p_user_id,'pending') RETURNING * INTO doc;
 UPDATE letter_slots SET occupied=true,document_id=doc.id WHERE number=slot.number;
 UPDATE register_days SET revision=revision+1 WHERE letter_date=p_date;
 IF emergency_allocated THEN
  INSERT INTO audit_logs(user_id,action,target_id,details) VALUES(p_user_id,'EMERGENCY_ALLOCATION',doc.id::TEXT,jsonb_build_object('surat_number',slot.number,'date',p_date,'reason',p_reason));
 END IF;
 RETURN to_jsonb(doc);
END $$;

REVOKE ALL ON FUNCTION public.restore_trimmed_letter_days(DATE),public.create_registered_document(UUID,DATE,TEXT,JSONB,BOOLEAN,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.restore_trimmed_letter_days(DATE),public.create_registered_document(UUID,DATE,TEXT,JSONB,BOOLEAN,TEXT) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
