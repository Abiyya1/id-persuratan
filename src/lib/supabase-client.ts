'use client';

import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Browser-side Supabase client.
 *
 * Uses the PUBLIC anon key on purpose. Realtime authorizes sockets as this
 * role, and schema.sql grants anon SELECT on `documents` specifically so
 * Dashboard 2 receives live updates. It has no write policy, so the anon key
 * cannot modify anything.
 */
export function getBrowserClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY in the environment.',
    );
  }

  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });
}
