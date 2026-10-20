import { getSupabaseAdmin, type UserRow } from '@/lib/supabase';
import {
  requireUser,
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  validateUsername,
  jsonError,
  handleRoute,
  setSessionCookie,
} from '@/lib/auth';
import { writeAudit, AuditAction } from '@/lib/audit';

const MAX_BODY_BYTES = 16 * 1024;
const UNIQUE_VIOLATION = '23505';

/**
 * Profile updates for any authenticated user.
 *
 * Supports three independent operations, sent one at a time:
 *   { username }              -> rename
 *   { currentPassword, newPassword } -> change password
 *   { revokeSessions }        -> re-issue the session cookie after a change
 *
 * Changing the username or password re-mints the session cookie so the JWT
 * stops carrying the old username. Without this the UI would show the previous
 * name until the 8-hour token expired.
 */
export async function PATCH(req: Request) {
  return handleRoute(async () => {
    const user = await requireUser();

    const body = await readBody(req);
    if (!body) return jsonError('Isi permintaan tidak valid.', 400);

    const supabase = getSupabaseAdmin();
    let changed = false;
    const details: Record<string, unknown> = {};

    // ---- Username ------------------------------------------------------------
    if (typeof body.username === 'string' && body.username !== user.username) {
      const username = body.username.trim();

      const usernameError = validateUsername(username);
      if (usernameError) return jsonError(usernameError, 400);

      const { data: updated, error } = await supabase
        .from('users')
        .update({ username })
        .eq('id', user.id)
        .select('id, username, role, status')
        .single<Pick<UserRow, 'id' | 'username' | 'role' | 'status'>>();

      if (error) {
        // Two accounts differing only by case would violate the LOWER() index.
        if (error.code === UNIQUE_VIOLATION) {
          return jsonError(`Nama pengguna "${username}" sudah digunakan.`, 409);
        }
        console.error('[profile/update] username change failed:', error.message);
        return jsonError('Tidak dapat memperbarui nama pengguna.', 500);
      }

      details.username = { from: user.username, to: updated.username };
      changed = true;

      await writeAudit({
        userId: user.id,
        action: AuditAction.PROFILE_UPDATE,
        targetId: user.id,
        details,
      });
    }

    // ---- Password ------------------------------------------------------------
    if (typeof body.newPassword === 'string' && body.newPassword.length > 0) {
      const currentPassword =
        typeof body.currentPassword === 'string' ? body.currentPassword : '';

      if (!currentPassword) {
        return jsonError('Kata sandi saat ini wajib diisi untuk membuat kata sandi baru.', 400);
      }

      const passwordError = validatePasswordStrength(body.newPassword);
      if (passwordError) return jsonError(passwordError, 400);

      const { data: record, error: fetchError } = await supabase
        .from('users')
        .select('password_hash')
        .eq('id', user.id)
        .maybeSingle<Pick<UserRow, 'password_hash'>>();

      if (fetchError) {
        console.error('[profile/update] fetch failed:', fetchError.message);
        return jsonError('Tidak dapat memverifikasi kata sandi Anda.', 500);
      }

      if (!record) return jsonError('Akun tidak ditemukan.', 404);

      const valid = await verifyPassword(currentPassword, record.password_hash);
      if (!valid) {
        // Deliberately not audited as a success, but logged for visibility.
        await writeAudit({
          userId: user.id,
          action: AuditAction.PROFILE_PASSWORD,
          targetId: user.id,
          details: { outcome: 'failed_bad_current_password' },
        });
        return jsonError('Kata sandi saat ini salah.', 401);
      }

      const newHash = await hashPassword(body.newPassword);

      const { error: updateError } = await supabase
        .from('users')
        .update({ password_hash: newHash })
        .eq('id', user.id);

      if (updateError) {
        console.error('[profile/update] password change failed:', updateError.message);
        return jsonError('Tidak dapat memperbarui kata sandi.', 500);
      }

      await writeAudit({
        userId: user.id,
        action: AuditAction.PROFILE_PASSWORD,
        targetId: user.id,
        details: { outcome: 'changed' },
      });

      changed = true;
    }

    if (!changed) {
      return jsonError('Tidak ada perubahan untuk disimpan.', 400);
    }

    // ---- Re-mint the session so the JWT reflects the new state ---------------
    const { data: fresh } = await supabase
      .from('users')
      .select('id, username, role, status')
      .eq('id', user.id)
      .single<Pick<UserRow, 'id' | 'username' | 'role' | 'status'>>();

    if (fresh) {
      await setSessionCookie({
        id: fresh.id,
        username: fresh.username,
        role: fresh.role,
        status: fresh.status,
      });

      return Response.json({
        message: 'Profil diperbarui.',
        user: { id: fresh.id, username: fresh.username, role: fresh.role },
      });
    }

    return Response.json({ message: 'Profil diperbarui.' });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const length = Number(req.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) return null;

  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
