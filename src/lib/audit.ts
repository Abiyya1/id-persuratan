import { getSupabaseAdmin } from './supabase';
import type { DocumentRow } from './supabase';

/** Audit actions used across the app, kept in one place so they stay consistent. */
export const AuditAction = {
  REGISTER: 'REGISTER',
  LOGIN: 'LOGIN',
  LOGIN_BLOCKED_PENDING: 'LOGIN_BLOCKED_PENDING',
  LOGOUT: 'LOGOUT',
  CREATE_DOC: 'CREATE_DOC',
  EDIT_DOC: 'EDIT_DOC',
  EDIT_ID: 'EDIT_ID',
  RESYNC_DOC: 'RESYNC_DOC',
  CRON_RESYNC: 'CRON_RESYNC',
  APPROVE_USER: 'APPROVE_USER',
  REJECT_USER: 'REJECT_USER',
  CREATE_USER: 'CREATE_USER',
  UPDATE_USER_ROLE: 'UPDATE_USER_ROLE',
  UPDATE_USER_STATUS: 'UPDATE_USER_STATUS',
  DELETE_USER: 'DELETE_USER',
  PROFILE_UPDATE: 'PROFILE_UPDATE',
  PROFILE_PASSWORD: 'PROFILE_PASSWORD',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

interface AuditInput {
  userId?: string | null;
  action: AuditActionValue | string;
  targetId?: string | number | null;
  details?: Record<string, unknown>;
}

/**
 * Write one audit_logs row.
 *
 * Never throws. An audit write failing must not roll back or crash the
 * operation the user actually requested -- losing a log line is strictly
 * better than losing the document or surfacing a 500 to the user.
 * Failures go to the server log so they are at least visible.
 */
export async function writeAudit({
  userId,
  action,
  targetId,
  details = {},
}: AuditInput): Promise<void> {
  try {
    const supabase = getSupabaseAdmin();

    const { error } = await supabase.from('audit_logs').insert({
      user_id: userId ?? null,
      action,
      target_id: targetId === null || targetId === undefined ? null : String(targetId),
      details,
    });

    if (error) {
      console.error(`[audit] failed to write "${action}":`, error.message);
    }
  } catch (err) {
    console.error(`[audit] threw while writing "${action}":`, err);
  }
}

/**
 * Record a Google Sheets sync outcome on the document itself.
 *
 * Called on both the success and failure paths of every append attempt.
 * `error` is null on success, which is what flips the row to 'synced'.
 */
export async function recordSyncResult(
  documentId: number,
  outcome: { ok: true } | { ok: false; error: string },
): Promise<void> {
  const supabase = getSupabaseAdmin();

  const patch = outcome.ok
    ? { sync_status: 'synced', last_sync_error: null }
    : {
        sync_status: 'failed',
        last_sync_error: outcome.error.slice(0, 1000),
      };

  // Atomic read-modify-write. `sync_attempts` cannot be incremented in the
  // client without a round trip, so we use Postgres to do it in one statement
  // and avoid a lost update between the cron job and a manual resync.
  const { error } = await supabase.rpc('bump_sync_attempts_and_set_status', {
    p_document_id: documentId,
    p_status: patch.sync_status,
    p_error: patch.last_sync_error ?? null,
  });

  if (error) {
    // Fallback: if the helper RPC is missing (schema.sql predates it), write
    // the patch directly. Slightly racy on sync_attempts, never on status.
    console.warn(
      `[sync] bump_sync_attempts_and_set_status RPC failed for doc ${documentId}, using fallback:`,
      error.message,
    );

    const { data, error: fallbackError } = await supabase
      .from('documents')
      .update({ ...patch, sync_attempts: 0 })
      .eq('id', documentId)
      .select('sync_attempts')
      .maybeSingle();

    if (fallbackError) {
      console.error(`[sync] fallback update failed for doc ${documentId}:`, fallbackError.message);
      return;
    }

    const attempts = (data?.sync_attempts ?? 0) + 1;
    await supabase
      .from('documents')
      .update({ sync_attempts: attempts })
      .eq('id', documentId);
  }
}

/** Fetch a document by ID, or null. Used by resync paths. */
export async function getDocument(id: number): Promise<DocumentRow | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error(`[documents] fetch failed for id ${id}:`, error.message);
    return null;
  }
  return data as DocumentRow | null;
}
