-- Apply after 20261008_required_destination.sql; configuration saves never allocate numbers.
BEGIN;
CREATE TABLE public.register_settings (
 id INT PRIMARY KEY CHECK(id=1),
 closing_unused_minimum INT NOT NULL DEFAULT 15 CHECK(closing_unused_minimum BETWEEN 1 AND 50),
 future_daily_total INT NOT NULL DEFAULT 45 CHECK(future_daily_total BETWEEN 1 AND 150)
);
INSERT INTO public.register_settings(id) VALUES(1);
CREATE TABLE public.register_day_targets (
 letter_date DATE PRIMARY KEY CHECK(letter_date BETWEEN DATE '2026-01-01' AND DATE '2026-12-31'),
 total INT NOT NULL CHECK(total BETWEEN 1 AND 400)
);
ALTER TABLE public.register_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.register_day_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.register_settings,public.register_day_targets FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.register_settings,public.register_day_targets TO service_role;

-- All settings mutations use the allocator lock before checking the fresh account.
CREATE FUNCTION public.assert_register_settings_admin(p_user_id UUID)
RETURNS VOID LANGUAGE plpgsql SET search_path=public AS $$
DECLARE actor users%ROWTYPE;
BEGIN
 SELECT * INTO actor FROM users WHERE id=p_user_id FOR SHARE;
 IF NOT FOUND OR actor.status<>'approved' OR actor.role NOT IN ('admin','superadmin') THEN
  RAISE EXCEPTION 'FORBIDDEN: Pengaturan nomor surat hanya untuk admin atau superadmin yang disetujui';
 END IF;
END $$;

CREATE FUNCTION public.register_day_target_locked(p_date DATE)
RETURNS BOOLEAN STABLE LANGUAGE sql SET search_path=public AS $$
 SELECT p_date<(now() AT TIME ZONE 'Asia/Jakarta')::date
  OR EXISTS(SELECT 1 FROM register_days WHERE letter_date=p_date AND (fixed_reservation OR closed))
  OR EXISTS(SELECT 1 FROM register_state WHERE id=1 AND closed_through>=p_date)
  OR EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>p_date)
$$;

CREATE FUNCTION public.get_register_settings()
RETURNS JSONB STABLE LANGUAGE sql SET search_path=public AS $$
 SELECT jsonb_build_object(
  'closingUnusedMinimum',s.closing_unused_minimum,
  'futureDailyTotal',s.future_daily_total,
  'today',(now() AT TIME ZONE 'Asia/Jakarta')::date,
  'year',2026,
  'dayTargets',coalesce((SELECT jsonb_agg(jsonb_build_object('date',t.letter_date,'total',t.total,'locked',register_day_target_locked(t.letter_date)) ORDER BY t.letter_date) FROM register_day_targets t),'[]'::JSONB)
 ) FROM register_settings s WHERE s.id=1
$$;

CREATE FUNCTION public.save_register_defaults(p_user_id UUID,p_closing_unused_minimum INT,p_future_daily_total INT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=public AS $$
DECLARE old_settings register_settings%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 PERFORM assert_register_settings_admin(p_user_id);
 IF p_closing_unused_minimum IS NULL OR p_closing_unused_minimum NOT BETWEEN 1 AND 50 OR p_future_daily_total IS NULL OR p_future_daily_total NOT BETWEEN 1 AND 150 THEN
  RAISE EXCEPTION 'INVALID_INPUT: Sisa nomor penutupan harus 1–50 dan jumlah harian mendatang harus 1–150';
 END IF;
 SELECT * INTO STRICT old_settings FROM register_settings WHERE id=1 FOR UPDATE;
 UPDATE register_settings SET closing_unused_minimum=p_closing_unused_minimum,future_daily_total=p_future_daily_total WHERE id=1;
 INSERT INTO audit_logs(user_id,action,target_id,details) VALUES(p_user_id,'UPDATE_REGISTER_DEFAULTS','2026',jsonb_build_object(
  'before',jsonb_build_object('closingUnusedMinimum',old_settings.closing_unused_minimum,'futureDailyTotal',old_settings.future_daily_total),
  'after',jsonb_build_object('closingUnusedMinimum',p_closing_unused_minimum,'futureDailyTotal',p_future_daily_total)));
 RETURN get_register_settings();
END $$;

CREATE FUNCTION public.set_register_day_target(p_user_id UUID,p_date DATE,p_total INT)
RETURNS JSONB LANGUAGE plpgsql SET search_path=public AS $$
DECLARE old_total INT; ordinary_count INT;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 PERFORM assert_register_settings_admin(p_user_id);
 IF p_date IS NULL OR p_date NOT BETWEEN DATE '2026-01-01' AND DATE '2026-12-31' OR p_total IS NULL OR p_total NOT BETWEEN 1 AND 400 THEN
  RAISE EXCEPTION 'INVALID_INPUT: Pilih tanggal tahun 2026 dan jumlah nomor 1–400';
 END IF;
 IF register_day_target_locked(p_date) THEN RAISE EXCEPTION 'TARGET_LOCKED: Rentang tanggal ini sudah tetap, ditutup, atau memiliki rentang berikutnya'; END IF;
 SELECT count(*) INTO ordinary_count FROM letter_slots WHERE letter_date=p_date AND suffix_index=0;
 IF p_total<ordinary_count THEN RAISE EXCEPTION 'TARGET_TOO_SMALL: Jumlah rencana tidak boleh kurang dari % nomor yang sudah tersedia',ordinary_count; END IF;
 SELECT total INTO old_total FROM register_day_targets WHERE letter_date=p_date;
 INSERT INTO register_day_targets(letter_date,total) VALUES(p_date,p_total) ON CONFLICT(letter_date) DO UPDATE SET total=excluded.total;
 INSERT INTO audit_logs(user_id,action,target_id,details) VALUES(p_user_id,'SET_REGISTER_DAY_TARGET',p_date::TEXT,jsonb_build_object('date',p_date,'before',old_total,'total',p_total));
 RETURN get_register_settings();
END $$;

CREATE FUNCTION public.delete_register_day_target(p_user_id UUID,p_date DATE)
RETURNS JSONB LANGUAGE plpgsql SET search_path=public AS $$
DECLARE old_total INT;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 PERFORM assert_register_settings_admin(p_user_id);
 IF p_date IS NULL OR p_date NOT BETWEEN DATE '2026-01-01' AND DATE '2026-12-31' THEN RAISE EXCEPTION 'INVALID_INPUT: Pilih tanggal tahun 2026'; END IF;
 -- Removing a plan is safe even for a frozen range: no existing number is changed.
 DELETE FROM register_day_targets WHERE letter_date=p_date RETURNING total INTO old_total;
 IF FOUND THEN
  INSERT INTO audit_logs(user_id,action,target_id,details) VALUES(p_user_id,'DELETE_REGISTER_DAY_TARGET',p_date::TEXT,jsonb_build_object('date',p_date,'total',old_total));
 END IF;
 RETURN get_register_settings();
END $$;

-- Internal shared realization; caller holds advisory lock and has created the day.
-- Ordinary totals deliberately exclude imported numeric and emergency alphabetic suffixes.
CREATE FUNCTION public.apply_register_day_total(p_date DATE,p_total INT,p_custom BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SET search_path=public AS $$
DECLARE day register_days%ROWTYPE; ordinary_count INT;
BEGIN
 IF p_total IS NULL OR p_total NOT BETWEEN 1 AND 400 OR p_custom IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT: Jumlah nomor harian tidak valid'; END IF;
 SELECT * INTO STRICT day FROM register_days WHERE letter_date=p_date FOR UPDATE;
 SELECT count(*) INTO ordinary_count FROM letter_slots WHERE letter_date=p_date AND suffix_index=0;
 IF day.fixed_reservation OR day.closed THEN
  IF p_custom AND ordinary_count<>p_total THEN RAISE EXCEPTION 'REGISTER_CONFLICT: Rencana % nomor tanggal % tidak sesuai dengan rentang tetap % nomor',p_total,p_date,ordinary_count; END IF;
  RETURN;
 END IF;
 IF p_custom AND ordinary_count>p_total THEN RAISE EXCEPTION 'TARGET_TOO_SMALL: Rencana tanggal % lebih kecil dari % nomor yang sudah tersedia',p_date,ordinary_count; END IF;
 IF ordinary_count<p_total THEN
  IF EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>p_date) THEN RAISE EXCEPTION 'REGISTER_CONFLICT: Rentang tanggal % tidak dapat diperluas melewati rentang berikutnya',p_date; END IF;
  PERFORM reserve_letter_slots(p_date,p_total-ordinary_count);
 END IF;
 UPDATE register_days SET fixed_reservation=true,revision=revision+1 WHERE letter_date=p_date AND NOT fixed_reservation;
END $$;

CREATE OR REPLACE FUNCTION public.close_letter_days(p_today DATE DEFAULT (now() AT TIME ZONE 'Asia/Jakarta')::date)
RETURNS VOID LANGUAGE plpgsql SET search_path=public AS $$
DECLARE state register_state%ROWTYPE; settings register_settings%ROWTYPE; day DATE; frozen BOOLEAN; unused INT; finish DATE; target INT;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 SELECT * INTO state FROM register_state WHERE id=1 FOR UPDATE;
 IF NOT state.initialized THEN RAISE EXCEPTION 'REGISTER_NOT_INITIALIZED'; END IF;
 IF p_today IS NULL THEN RAISE EXCEPTION 'INVALID_INPUT: Tanggal penutupan wajib diisi'; END IF;
 SELECT * INTO STRICT settings FROM register_settings WHERE id=1;
 -- Import may advance closed_through past a plan before this loop can see it.
 IF EXISTS(SELECT 1 FROM register_day_targets t WHERE t.letter_date<=state.closed_through
  AND t.total<>(SELECT count(*) FROM letter_slots s WHERE s.letter_date=t.letter_date AND s.suffix_index=0)) THEN
  RAISE EXCEPTION 'REGISTER_CONFLICT: Rencana tanggal yang sudah ditutup tidak sesuai dengan rentang impor. Hapus rencana yang bertentangan tanpa mengubah nomor';
 END IF;
 finish := least(p_today-1,DATE '2026-12-31');
 day := greatest(coalesce(state.closed_through+1,state.start_date,p_today),DATE '2026-01-01');
 WHILE day<=finish LOOP
  INSERT INTO register_days(letter_date) VALUES(day) ON CONFLICT DO NOTHING;
  SELECT total INTO target FROM register_day_targets WHERE letter_date=day;
  IF target IS NOT NULL THEN
   PERFORM apply_register_day_total(day,target,true);
  ELSE
   SELECT fixed_reservation OR closed INTO frozen FROM register_days WHERE letter_date=day;
   IF NOT frozen THEN
    SELECT count(*) INTO unused FROM letter_slots WHERE letter_date=day AND NOT occupied;
    IF unused<settings.closing_unused_minimum THEN
     IF EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>day) THEN RAISE EXCEPTION 'REGISTER_CONFLICT: Rentang tanggal % tidak dapat diperluas melewati rentang berikutnya',day; END IF;
     PERFORM reserve_letter_slots(day,settings.closing_unused_minimum-unused);
    END IF;
   END IF;
  END IF;
  UPDATE register_days SET closed=true,revision=revision+1 WHERE letter_date=day AND NOT closed;
  UPDATE register_state SET closed_through=day WHERE id=1;
  day := day+1;
 END LOOP;
END $$;

-- Preserve destination validator, imported-range initialization, deletion, acknowledgement and lease contracts.
CREATE OR REPLACE FUNCTION public.create_registered_document(p_user_id UUID,p_date DATE,p_title TEXT,p_metadata JSONB,p_emergency BOOLEAN DEFAULT false,p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SET search_path=public AS $$
DECLARE today DATE := (now() AT TIME ZONE 'Asia/Jakarta')::date; state register_state%ROWTYPE; settings register_settings%ROWTYPE; u users%ROWTYPE; slot letter_slots%ROWTYPE; day DATE; target INT; base INT; next_suffix INT; suffix TEXT; n INT; doc documents%ROWTYPE; emergency_allocated BOOLEAN := false;
BEGIN
 PERFORM pg_advisory_xact_lock(6002026);
 SELECT * INTO u FROM users WHERE id=p_user_id;
 IF NOT FOUND OR u.status<>'approved' THEN RAISE EXCEPTION 'FORBIDDEN: approved account required'; END IF;
 IF p_emergency AND (u.role NOT IN ('admin','superadmin') OR length(btrim(coalesce(p_reason,''))) NOT BETWEEN 1 AND 500) THEN RAISE EXCEPTION 'FORBIDDEN: administrator confirmation and reason required'; END IF;
 p_metadata := validate_registered_letter_fields(p_date,p_title,p_metadata);
 SELECT * INTO state FROM register_state WHERE id=1 FOR UPDATE;
 IF NOT state.initialized THEN RAISE EXCEPTION 'REGISTER_NOT_INITIALIZED'; END IF;
 PERFORM close_letter_days(today);
 SELECT * INTO STRICT settings FROM register_settings WHERE id=1;
 IF p_date>today THEN
  day := today;
  WHILE day<p_date LOOP
   INSERT INTO register_days(letter_date) VALUES(day) ON CONFLICT DO NOTHING;
   SELECT total INTO target FROM register_day_targets WHERE letter_date=day;
   -- Shared helper never applies changed defaults to a fixed/closed range.
   PERFORM apply_register_day_total(day,coalesce(target,settings.future_daily_total),target IS NOT NULL);
   day := day+1;
  END LOOP;
 END IF;
 INSERT INTO register_days(letter_date) SELECT p_date WHERE p_date>=today ON CONFLICT DO NOTHING;
 SELECT total INTO target FROM register_day_targets WHERE letter_date=p_date;
 IF target IS NOT NULL AND EXISTS(SELECT 1 FROM register_days WHERE letter_date=p_date) THEN
  PERFORM apply_register_day_total(p_date,target,true);
 END IF;
 SELECT * INTO slot FROM letter_slots WHERE letter_date=p_date AND NOT occupied ORDER BY base_number,suffix_index LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN
  IF p_date>=today AND NOT EXISTS(SELECT 1 FROM letter_slots WHERE letter_date>p_date) AND NOT coalesce((SELECT fixed_reservation OR closed FROM register_days WHERE letter_date=p_date),true) THEN
   PERFORM reserve_letter_slots(p_date,1);
   SELECT * INTO slot FROM letter_slots WHERE letter_date=p_date AND NOT occupied ORDER BY base_number,suffix_index LIMIT 1 FOR UPDATE;
  ELSE
   SELECT max(base_number) INTO base FROM letter_slots WHERE letter_date=p_date;
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

REVOKE ALL ON FUNCTION public.assert_register_settings_admin(UUID),public.register_day_target_locked(DATE),public.get_register_settings(),public.save_register_defaults(UUID,INT,INT),public.set_register_day_target(UUID,DATE,INT),public.delete_register_day_target(UUID,DATE),public.apply_register_day_total(DATE,INT,BOOLEAN),public.close_letter_days(DATE),public.create_registered_document(UUID,DATE,TEXT,JSONB,BOOLEAN,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.assert_register_settings_admin(UUID),public.register_day_target_locked(DATE),public.get_register_settings(),public.save_register_defaults(UUID,INT,INT),public.set_register_day_target(UUID,DATE,INT),public.delete_register_day_target(UUID,DATE),public.apply_register_day_total(DATE,INT,BOOLEAN),public.close_letter_days(DATE),public.create_registered_document(UUID,DATE,TEXT,JSONB,BOOLEAN,TEXT) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
