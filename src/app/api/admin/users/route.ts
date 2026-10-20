import { getSupabaseAdmin, toPublicUser, type PublicUser, type UserRow, type Role, type UserStatus } from '@/lib/supabase';
import {
  requireAdmin,
  requireSuperadmin,
  hashPassword,
  validatePasswordStrength,
  validateUsername,
  jsonError,
  handleRoute,
} from '@/lib/auth';

const MAX_BODY_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ROLES: Role[] = ['user', 'admin', 'superadmin'];
const MANAGED_ROLES = ['user', 'admin'];
const VALID_STATUSES: UserStatus[] = ['pending', 'approved', 'rejected'];
const ROLE_LABELS: Record<Role, string> = {
  user: 'Pengguna',
  admin: 'Administrator',
  superadmin: 'Administrator Utama',
};
interface MutationResult {
  user: PublicUser;
  deleted?: boolean;
}

export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireAdmin();
    const url = new URL(req.url);
    const status = url.searchParams.get('status');
    const role = url.searchParams.get('role');
    let query = getSupabaseAdmin().from('users').select('*').order('created_at', { ascending: false });

    if (actor.role === 'admin') {
      query = query.eq('role', 'user').eq('status', 'pending');
    } else {
      if (status && VALID_STATUSES.includes(status as UserStatus)) query = query.eq('status', status);
      if (role && VALID_ROLES.includes(role as Role)) query = query.eq('role', role);
    }
    const { data, error } = await query;
    if (error) {
      console.error('[admin/users] list failed:', error.message);
      return jsonError('Tidak dapat memuat pengguna.', 500);
    }
    const users = ((data ?? []) as UserRow[]).map(toPublicUser);
    return Response.json({
      users,
      counts: {
        total: users.length,
        pending: users.filter((user) => user.status === 'pending').length,
        approved: users.filter((user) => user.status === 'approved').length,
        rejected: users.filter((user) => user.status === 'rejected').length,
      },
    });
  });
}

export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireSuperadmin();
    const body = await readBody(req);
    if (!body || Object.keys(body).some((key) => !['username', 'password', 'role'].includes(key))) {
      return jsonError('Isi permintaan tidak valid.', 400);
    }
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const role = body.role === undefined ? 'user' : body.role;
    if (!username || !password) return jsonError('Nama pengguna dan kata sandi wajib diisi.', 400);
    const usernameError = validateUsername(username);
    if (usernameError) return jsonError(usernameError, 400);
    const passwordError = validatePasswordStrength(password);
    if (passwordError) return jsonError(passwordError, 400);
    if (typeof role !== 'string' || !MANAGED_ROLES.includes(role)) {
      return jsonError('Peran hanya boleh berupa Pengguna atau Administrator.', 400);
    }

    const { data, error } = await getSupabaseAdmin().rpc('create_managed_user_account', {
      p_actor_id: actor.id,
      p_username: username,
      p_password_hash: await hashPassword(password),
      p_role: role,
    });
    if (error) {
      if (error.code === '23505') return jsonError(`Nama pengguna "${username}" sudah digunakan.`, 409);
      return mutationError(error);
    }
    const { user } = data as MutationResult;
    return Response.json({
      message: `Akun "${username}" dibuat dengan peran ${ROLE_LABELS[user.role]}.`,
      user,
    }, { status: 201 });
  });
}

export async function PATCH(req: Request) {
  return handleRoute(async () => {
    const actor = await requireAdmin();
    const body = await readBody(req);
    if (!body) return jsonError('Isi permintaan tidak valid.', 400);
    const targetId = typeof body.userId === 'string' ? body.userId : '';
    if (!UUID.test(targetId)) return jsonError('ID pengguna tidak valid.', 400);

    if (actor.role === 'admin') {
      if (Object.keys(body).some((key) => !['userId', 'status'].includes(key)) ||
          (body.status !== 'approved' && body.status !== 'rejected')) {
        return jsonError('Administrator hanya dapat menyetujui atau menolak pendaftaran pengguna yang menunggu.', 400);
      }
    } else {
      if (Object.keys(body).some((key) => !['userId', 'role', 'status', 'delete'].includes(key))) {
        return jsonError('Isi permintaan tidak valid.', 400);
      }
      if ('role' in body && (typeof body.role !== 'string' || !MANAGED_ROLES.includes(body.role))) {
        return jsonError('Peran hanya boleh berupa Pengguna atau Administrator.', 400);
      }
      if ('status' in body && (typeof body.status !== 'string' || !VALID_STATUSES.includes(body.status as UserStatus))) {
        return jsonError('Status pengguna tidak valid.', 400);
      }
      if ('delete' in body && (body.delete !== true || Object.keys(body).length !== 2)) {
        return jsonError('Penghapusan tidak boleh digabungkan dengan perubahan akun.', 400);
      }
    }
    const { userId, ...changes } = body;
    void userId;
    if (Object.keys(changes).length === 0) return jsonError('Tidak ada perubahan untuk disimpan.', 400);
    const { data, error } = await getSupabaseAdmin().rpc('update_managed_user_account', {
      p_actor_id: actor.id,
      p_target_id: targetId,
      p_changes: changes,
    });
    if (error) return mutationError(error);
    const result = data as MutationResult;
    if (result.deleted) return Response.json({ message: `Akun "${result.user.username}" dihapus.` });
    const user = result.user;
    const message = changes.status === 'approved'
      ? `Akun "${user.username}" disetujui dan kini dapat masuk.`
      : changes.status === 'rejected'
        ? `Akun "${user.username}" ditolak.`
        : changes.role
          ? `"${user.username}" kini memiliki peran ${ROLE_LABELS[user.role]}.`
          : 'Akun diperbarui.';
    return Response.json({ message, user });
  });
}

function mutationError(error: { code?: string; message: string }): Response {
  if (error.code === '42501') return jsonError('Anda tidak memiliki izin untuk mengelola akun ini.', 403);
  if (error.code === 'P0002') return jsonError('Pengguna tidak ditemukan.', 404);
  if (error.message === 'SUPERADMIN_PROTECTED' || error.message === 'LAST_SUPERADMIN') {
    return jsonError('Akun Administrator Utama dilindungi dan tidak dapat diubah atau dihapus.', 409);
  }
  if (error.message === 'PENDING_REGISTRATION_REQUIRED') {
    return jsonError('Pendaftaran ini tidak lagi menunggu persetujuan. Muat ulang daftar pengguna.', 409);
  }
  if (error.code === '40001') return jsonError('Akun berubah selama permintaan ini. Muat ulang daftar pengguna.', 409);
  if (error.code === '22023') return jsonError('Perubahan akun tidak valid atau tidak ada perubahan untuk disimpan.', 400);
  console.error('[admin/users] mutation failed:', error.message);
  return jsonError('Tidak dapat menyimpan perubahan akun.', 500);
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) return null;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
