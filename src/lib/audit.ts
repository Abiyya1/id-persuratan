import { getSupabaseAdmin } from './supabase';

/** Audit actions used across the app, kept in one place so they stay consistent. */
export const AuditAction = {
  REGISTER: 'REGISTER',
  LOGIN: 'LOGIN',
  LOGIN_BLOCKED_PENDING: 'LOGIN_BLOCKED_PENDING',
  LOGOUT: 'LOGOUT',
  CREATE_DOC: 'CREATE_DOC',
  EDIT_DOC: 'EDIT_DOC',
  DELETE_DOC: 'DELETE_DOC',
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
