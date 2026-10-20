import { getSupabaseAdmin, type UserRow } from '@/lib/supabase';
import {
  verifyPassword,
  setSessionCookie,
  jsonError,
  handleRoute,
  PENDING_MESSAGE,
} from '@/lib/auth';
import { writeAudit, AuditAction } from '@/lib/audit';

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Login.
 *
 * Every failure path returns the SAME 401 message. Distinguishing "no such
 * user" from "wrong password" would let an attacker enumerate valid usernames.
 * Pending accounts are the one deliberate exception -- the spec requires
 * telling them to wait, and knowing an account exists but is unapproved is not
 * useful to someone guessing credentials.
 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const body = await readBody(req);
    if (!body) return jsonError('Isi permintaan tidak valid.', 400);

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
      return jsonError('Nama pengguna atau kata sandi salah.', 401);
    }

    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .ilike('username', username.replace(/[\\%_]/g, (c) => `\\${c}`))
      .maybeSingle<UserRow>();

    if (error) {
      console.error('[login] lookup failed:', error.message);
      return jsonError('Layanan masuk untuk sementara tidak tersedia.', 500);
    }

    if (!data) {
      // Spend roughly the same time as a real bcrypt compare so response
      // timing does not reveal whether the username exists.
      await verifyPassword(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
      return jsonError('Nama pengguna atau kata sandi salah.', 401);
    }

    const valid = await verifyPassword(password, data.password_hash);
    if (!valid) {
      await writeAudit({
        userId: data.id,
        action: AuditAction.LOGIN,
        targetId: data.id,
        details: { outcome: 'failed_bad_password' },
      });
      return jsonError('Nama pengguna atau kata sandi salah.', 401);
    }

    // ---- Status gates --------------------------------------------------------
    if (data.status === 'pending') {
      await writeAudit({
        userId: data.id,
        action: AuditAction.LOGIN_BLOCKED_PENDING,
        targetId: data.id,
        details: { reason: 'pending_approval' },
      });
      return jsonError(PENDING_MESSAGE, 403);
    }

    if (data.status === 'rejected') {
      await writeAudit({
        userId: data.id,
        action: AuditAction.LOGIN,
        targetId: data.id,
        details: { outcome: 'blocked_rejected' },
      });
      return jsonError('Akun Anda ditolak. Hubungi administrator.', 403);
    }

    // ---- Approved: mint the session ------------------------------------------
    await setSessionCookie({
      id: data.id,
      username: data.username,
      role: data.role,
      status: data.status,
    });

    await writeAudit({
      userId: data.id,
      action: AuditAction.LOGIN,
      targetId: data.id,
      details: { outcome: 'success', role: data.role },
    });

    return Response.json({
      message: 'Berhasil masuk.',
      user: { id: data.id, username: data.username, role: data.role },
      // The client uses this to pick the portal without another round trip.
      redirectTo: data.role === 'user' ? '/dashboard' : '/admin',
    });
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
