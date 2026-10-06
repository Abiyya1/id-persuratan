import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Domain types -- mirror supabase/schema.sql
// ---------------------------------------------------------------------------

export type Role = 'user' | 'admin' | 'superadmin';
export type UserStatus = 'pending' | 'approved' | 'rejected';
export type SyncStatus = 'synced' | 'pending' | 'failed';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  status: UserStatus;
  created_at: string;
  updated_at: string;
}

/** Shape returned to the client -- never includes password_hash. */
export type PublicUser = Omit<UserRow, 'password_hash'>;

export interface DocumentRow {
  id: number;
  title: string;
  metadata: Record<string, unknown>;
  created_by: string | null;
  sync_status: SyncStatus;
  sync_attempts: number;
  last_sync_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditLogRow {
  id: number;
  user_id: string | null;
  action: string;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Environment access
// ---------------------------------------------------------------------------

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/**
 * Server-side Supabase client using the SERVICE ROLE key.
 *
 * The service role bypasses RLS, which is what lets API routes read `users`
 * and write `documents` while anon gets SELECT-only on documents.
 *
 * NEVER import this into a client component -- the key would ship to the
 * browser. Use `getBrowserClient()` from ./supabase-client for that.
 */
export function getSupabaseAdmin(): SupabaseClient {
  return createClient(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        // No Supabase Auth session -- this app does its own cookie+JWT auth.
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

/**
 * Strip the password hash before anything crosses the wire to a client.
 *
 * Destructuring with a rest element is the reliable way to do this -- an
 * explicit `delete` or a hand-built copy is easy to forget when a field is
 * added to UserRow later.
 */
export function toPublicUser(user: UserRow): PublicUser {
  const { password_hash, ...rest } = user;
  void password_hash;
  return rest;
}
