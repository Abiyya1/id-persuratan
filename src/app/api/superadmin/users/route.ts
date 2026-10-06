import { getSupabaseAdmin, toPublicUser, type UserRow, type Role, type UserStatus } from '@/lib/supabase';
import {
  requireSuperadmin,
  hashPassword,
  validatePasswordStrength,
  validateUsername,
  jsonError,
  handleRoute,
} from '@/lib/auth';
import { writeAudit, AuditAction } from '@/lib/audit';

const MAX_BODY_BYTES = 16 * 1024;
const UNIQUE_VIOLATION = '23505';

const VALID_ROLES: Role[] = ['user', 'admin', 'superadmin'];
const VALID_STATUSES: UserStatus[] = ['pending', 'approved', 'rejected'];

// ===========================================================================
// GET -- list users, optionally filtered
// ===========================================================================
export async function GET(req: Request) {
  return handleRoute(async () => {
    await requireSuperadmin();

    const url = new URL(req.url);
    const statusParam = url.searchParams.get('status');
    const roleParam = url.searchParams.get('role');

    const supabase = getSupabaseAdmin();
    let query = supabase.from('users').select('*').order('created_at', { ascending: false });

    if (statusParam && VALID_STATUSES.includes(statusParam as UserStatus)) {
      query = query.eq('status', statusParam as UserStatus);
    }
    if (roleParam && VALID_ROLES.includes(roleParam as Role)) {
      query = query.eq('role', roleParam as Role);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[superadmin/users] list failed:', error.message);
      return jsonError('Could not load users.', 500);
    }

    // Never let password_hash reach the browser, not even accidentally.
    const users = ((data ?? []) as UserRow[]).map(toPublicUser);

    const counts = {
      total: users.length,
      pending: users.filter((u) => u.status === 'pending').length,
      approved: users.filter((u) => u.status === 'approved').length,
      rejected: users.filter((u) => u.status === 'rejected').length,
    };

    return Response.json({ users, counts });
  });
}

// ===========================================================================
// POST -- manually create a user or admin account
// ===========================================================================
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireSuperadmin();

    const body = await readBody(req);
    if (!body) return jsonError('Invalid request body.', 400);

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const role = typeof body.role === 'string' ? body.role : 'user';

    if (!username || !password) {
      return jsonError('Username and password are required.', 400);
    }

    const usernameError = validateUsername(username);
    if (usernameError) return jsonError(usernameError, 400);

    const passwordError = validatePasswordStrength(password);
    if (passwordError) return jsonError(passwordError, 400);

    if (!VALID_ROLES.includes(role as Role)) {
      return jsonError('Role must be user, admin or superadmin.', 400);
    }

    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from('users')
      .insert({
        username,
        password_hash: await hashPassword(password),
        role: role as Role,
        // Superadmin-created accounts are usable immediately -- that is the
        // whole point of the manual-create path.
        status: 'approved',
      })
      .select('*')
      .single<UserRow>();

    if (error) {
      if (error.code === UNIQUE_VIOLATION) {
        return jsonError(`Username "${username}" is already taken.`, 409);
      }
      console.error('[superadmin/users] create failed:', error.message);
      return jsonError('Could not create the account.', 500);
    }

    await writeAudit({
      userId: actor.id,
      action: AuditAction.CREATE_USER,
      targetId: data.id,
      details: { username, role: data.role, status: data.status },
    });

    return Response.json(
      { message: `Account "${username}" created as ${data.role}.`, user: toPublicUser(data) },
      { status: 201 },
    );
  });
}

// ===========================================================================
// PATCH -- approve, reject, change role, or delete
// ===========================================================================
export async function PATCH(req: Request) {
  return handleRoute(async () => {
    const actor = await requireSuperadmin();

    const body = await readBody(req);
    if (!body) return jsonError('Invalid request body.', 400);

    const targetId = typeof body.userId === 'string' ? body.userId : '';
    if (!targetId) return jsonError('A userId is required.', 400);

    const supabase = getSupabaseAdmin();

    const { data: target, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('id', targetId)
      .maybeSingle<UserRow>();

    if (fetchError) {
      console.error('[superadmin/users] fetch failed:', fetchError.message);
      return jsonError('Could not load the user.', 500);
    }

    if (!target) return jsonError('User not found.', 404);

    // ---- Guards against locking everyone out --------------------------------
    // A superadmin demoting themselves could leave the system with no one able
    // to approve accounts.
    const selfTarget = actor.id === target.id;

    const wantsLowerRole =
      typeof body.role === 'string' &&
      body.role !== target.role &&
      !VALID_ROLES.includes(body.role as Role);

    if (wantsLowerRole) return jsonError('Role must be user, admin or superadmin.', 400);

    const wantsNonApproved =
      typeof body.status === 'string' && !VALID_STATUSES.includes(body.status as UserStatus);

    if (wantsNonApproved) {
      return jsonError('Status must be pending, approved or rejected.', 400);
    }

    if (selfTarget && typeof body.role === 'string' && body.role !== 'superadmin') {
      return jsonError('You cannot remove your own superadmin role.', 400);
    }

    if (selfTarget && typeof body.status === 'string' && body.status !== 'approved') {
      return jsonError('You cannot revoke your own access.', 400);
    }

    if (selfTarget && body.delete === true) {
      return jsonError('You cannot delete your own account.', 400);
    }

    // Demoting the LAST remaining superadmin would brick the approval queue.
    if (
      target.role === 'superadmin' &&
      ((typeof body.role === 'string' && body.role !== 'superadmin') || body.delete === true)
    ) {
      const { count } = await supabase
        .from('users')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'superadmin')
        .eq('status', 'approved');

      if ((count ?? 0) <= 1) {
        return jsonError(
          'This is the only active superadmin. Promote another account first.',
          409,
        );
      }
    }

    // ---- Delete -------------------------------------------------------------
    if (body.delete === true) {
      const { error: deleteError } = await supabase.from('users').delete().eq('id', targetId);

      if (deleteError) {
        console.error('[superadmin/users] delete failed:', deleteError.message);
        return jsonError('Could not delete the account.', 500);
      }

      await writeAudit({
        userId: actor.id,
        action: AuditAction.DELETE_USER,
        targetId,
        details: { username: target.username, role: target.role },
      });

      return Response.json({ message: `Account "${target.username}" deleted.` });
    }

    // ---- Update -------------------------------------------------------------
    const patch: Record<string, unknown> = {};

    if (typeof body.role === 'string' && body.role !== target.role) {
      patch.role = body.role as Role;
    }

    if (typeof body.status === 'string' && body.status !== target.status) {
      patch.status = body.status as UserStatus;
    }

    if (Object.keys(patch).length === 0) {
      return jsonError('Nothing to update.', 400);
    }

    const { data: updated, error: updateError } = await supabase
      .from('users')
      .update(patch)
      .eq('id', targetId)
      .select('*')
      .single<UserRow>();

    if (updateError) {
      console.error('[superadmin/users] update failed:', updateError.message);
      return jsonError('Could not update the account.', 500);
    }

    // Audit the two effects separately -- an approval and a role change are
    // different decisions and should be distinguishable later.
    if (patch.status === 'approved') {
      await writeAudit({
        userId: actor.id,
        action: AuditAction.APPROVE_USER,
        targetId,
        details: { username: updated.username, previousStatus: target.status },
      });
    } else if (patch.status === 'rejected') {
      await writeAudit({
        userId: actor.id,
        action: AuditAction.REJECT_USER,
        targetId,
        details: { username: updated.username, previousStatus: target.status },
      });
    } else if (patch.status) {
      await writeAudit({
        userId: actor.id,
        action: AuditAction.UPDATE_USER_STATUS,
        targetId,
        details: { username: updated.username, from: target.status, to: patch.status },
      });
    }

    if (patch.role) {
      await writeAudit({
        userId: actor.id,
        action: AuditAction.UPDATE_USER_ROLE,
        targetId,
        details: { username: updated.username, from: target.role, to: patch.role },
      });
    }

    const message =
      patch.status === 'approved'
        ? `Approved "${updated.username}". They can now sign in.`
        : patch.status === 'rejected'
          ? `Rejected "${updated.username}".`
          : patch.role
            ? `"${updated.username}" is now ${updated.role}.`
            : 'Account updated.';

    return Response.json({ message, user: toPublicUser(updated) });
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
