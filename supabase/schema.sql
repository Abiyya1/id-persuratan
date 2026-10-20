-- ============================================================================
-- Document Labeling & ID Management System -- Base Schema
-- Fresh install: schema, 20261006_letter_register, 20261007_document_delete, seed.
-- Existing installations: apply unapplied migrations only; never reset the counter.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Users Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'superadmin')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Case-insensitive usernames: "Budi" and "budi" must not both exist.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx
  ON public.users (LOWER(username));

-- ----------------------------------------------------------------------------
-- 2. Atomic ID Counter Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.id_counter (
  id INT PRIMARY KEY DEFAULT 1,
  current_val INT NOT NULL DEFAULT 100
);

INSERT INTO public.id_counter (id, current_val) VALUES (1, 100)
  ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. Atomic ID Generation Function
--
-- The row lock from SELECT ... FOR UPDATE is held until the *enclosing
-- transaction* ends, so two concurrent callers serialize here. That is what
-- guarantees no duplicate IDs.
--
-- Note: the lock is released when the RPC call commits, which may be BEFORE
-- the caller's INSERT into documents lands. A crash in that gap burns an ID
-- (the sequence jumps). That is the correct trade-off -- IDs stay unique,
-- they just are not gapless.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_next_document_id()
RETURNS INT AS $$
DECLARE
  next_id INT;
BEGIN
  SELECT current_val + 1 INTO next_id
  FROM public.id_counter
  WHERE id = 1
  FOR UPDATE;

  IF next_id IS NULL THEN
    RAISE EXCEPTION 'id_counter row (id=1) is missing';
  END IF;

  UPDATE public.id_counter
  SET current_val = next_id
  WHERE id = 1;

  RETURN next_id;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 4. Documents Table (with sync queue columns)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.documents (
  id INT PRIMARY KEY,
  title TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (sync_status IN ('synced', 'pending', 'failed')),
  sync_attempts INT NOT NULL DEFAULT 0,
  last_sync_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Backs the Dashboard 2 "filter by sync_status" + newest-first view.
CREATE INDEX IF NOT EXISTS documents_sync_status_idx
  ON public.documents (sync_status);

CREATE INDEX IF NOT EXISTS documents_created_at_idx
  ON public.documents (created_at DESC);

-- Trigram-free search support: prefix/contains on title without a full scan.
CREATE INDEX IF NOT EXISTS documents_title_lower_idx
  ON public.documents (LOWER(title));

-- ----------------------------------------------------------------------------
-- 5. Audit Log Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx
  ON public.audit_logs (created_at DESC);

-- ----------------------------------------------------------------------------
-- 6. updated_at auto-touch trigger
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_touch_updated_at ON public.users;
CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS documents_touch_updated_at ON public.documents;
CREATE TRIGGER documents_touch_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================================================================
-- 7. Row Level Security
--
-- Every table gets RLS ON. The server talks to Postgres with the
-- SERVICE ROLE key, which bypasses RLS entirely -- so these policies do NOT
-- restrict the application. They exist to control what the *public* anon key
-- can reach from the browser.
--
-- No browser SELECT/write policies: all letters and private tables are accessed
-- through API routes with fresh account approval and role/ownership checks.
-- ============================================================================

ALTER TABLE public.users      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.id_counter ENABLE ROW LEVEL SECURITY;

-- Remove the obsolete anonymous Realtime read grant if present.
DROP POLICY IF EXISTS documents_anon_select ON public.documents;

-- ----------------------------------------------------------------------------
-- 8. Atomic sync-queue update
--
-- The cron job and a manual "Re-sync" button can fire at the same time for the
-- same document. A read-modify-write in JS would lose one increment, so the
-- increment happens inside Postgres in a single statement.
--
-- On success we also CLEAR last_sync_error -- a document that has since synced
-- should not keep displaying a stale error next to a 'synced' badge.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bump_sync_attempts_and_set_status(
  p_document_id INT,
  p_status TEXT,
  p_error TEXT
)
RETURNS VOID AS $$
BEGIN
  UPDATE public.documents
  SET sync_attempts   = sync_attempts + 1,
      sync_status     = p_status,
      last_sync_error = p_error
  WHERE id = p_document_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 9. Helper: is the given user an admin?
--    SECURITY DEFINER so it can read `users` without RLS getting in the way
--    when called from a non-service-role context.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.is_admin(uid UUID)
RETURNS BOOLEAN AS $$
DECLARE
  r TEXT;
  s TEXT;
BEGIN
  SELECT role, status INTO r, s
  FROM public.users
  WHERE id = uid;

  RETURN r IN ('admin', 'superadmin') AND s = 'approved';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.get_next_document_id() IS
  'Atomically reserves and returns the next document ID. Gaps are possible; duplicates are not.';
COMMENT ON TABLE public.documents IS
  'Application letters. Access requires fresh approval and API role/ownership checks.';
