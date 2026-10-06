-- ============================================================================
-- SUPERADMIN BOOTSTRAP -- run ONCE, after schema.sql
--
-- Why this file exists:
--   Registration always creates role='user', status='pending'.
--   Pending accounts cannot log in.
--   Approving accounts happens in Dashboard 2, which requires a logged-in
--   superadmin.
--   => On a fresh install nobody can ever log in.
--
-- This breaks the cycle by planting the first superadmin directly.
--
-- HOW TO USE
--   1. Generate a hash:   npm run hash-password -- "MyPassword123"
--   2. Paste the output below in place of __HASH_ME__
--   3. Run this script in the Supabase SQL editor.
--   4. Delete this file, or at minimum never commit a filled-in copy.
-- ============================================================================

-- Sanity check: schema.sql must have run first.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_name = 'users' AND table_schema = 'public') THEN
    RAISE EXCEPTION 'public.users does not exist -- run schema.sql first';
  END IF;
END
$$;

INSERT INTO public.users (username, password_hash, role, status)
VALUES (
  'superadmin',
  '$2a$12$dxWfMmFruG.GCHItrb8iieGS0.f1z3HKsVoBc0c/2JPSmaSq58OA6',   -- <-- paste the bcrypt hash from `npm run hash-password`
  'superadmin',
  'approved'
)
ON CONFLICT (username) DO UPDATE
  SET password_hash = EXCLUDED.password_hash,
      role          = EXCLUDED.role,
      status        = EXCLUDED.status,
      updated_at    = NOW();

-- Confirm it worked:
SELECT id, username, role, status, created_at FROM public.users WHERE username = 'superadmin';
