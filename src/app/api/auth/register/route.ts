import { getSupabaseAdmin, type UserRow } from '@/lib/supabase';
import {
  hashPassword,
  validatePasswordStrength,
  validateUsername,
  jsonError,
  handleRoute,
} from '@/lib/auth';
import { writeAudit, AuditAction } from '@/lib/audit';

/** Guard against an unbounded body being JSON-parsed. */
const MAX_BODY_BYTES = 16 * 1024;

/** Postgres unique-violation. The race loser gets this on INSERT. */
const UNIQUE_VIOLATION = '23505';

export async function POST(req: Request) {
  return handleRoute(async () => {
    const body = await readBody(req);
    if (!body) return jsonError('Invalid request body.', 400);

    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
      return jsonError('Username and password are required.', 400);
    }

    const usernameError = validateUsername(username);
    if (usernameError) return jsonError(usernameError, 400);

    const passwordError = validatePasswordStrength(password);
    if (passwordError) return jsonError(passwordError, 400);

    const supabase = getSupabaseAdmin();

    // Case-insensitive duplicate check. `username` is validated to contain no
    // `%` or `_`-as-wildcard ambiguity... actually `_` IS allowed, and ilike
    // treats it as a single-char wildcard. Escape it so "ab_c" does not match
    // "abxc". Combined with the UNIQUE index on LOWER(username), the INSERT
    // below is still the real guarantee -- this is just a fast, friendly path.
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .ilike('username', username.replace(/[\\%_]/g, (c) => `\\${c}`))
      .maybeSingle<{ id: string }>();

    // Do not confirm whether the username is taken -- that would let anyone
    // enumerate accounts. Message stays deliberately vague.
    if (existing) return jsonError('Unable to register with those details.', 409);

    const { data: created, error: insertError } = await supabase
      .from('users')
      .insert({
        username,
        password_hash: await hashPassword(password),
        role: 'user', // Never client-controlled. Always the lowest privilege.
        status: 'pending', // Blocked until a superadmin approves.
      })
      .select('id, username, role, status')
      .single();

    if (insertError) {
      // Two simultaneous registrations for the same name: the loser lands here.
      // Return the same 409 as the pre-check so behaviour is identical.
      if (insertError.code === UNIQUE_VIOLATION) {
        return jsonError('Unable to register with those details.', 409);
      }

      console.error('[register] insert failed:', insertError.message);
      return jsonError('Registration is temporarily unavailable.', 500);
    }

    await writeAudit({
      userId: created.id,
      action: AuditAction.REGISTER,
      targetId: created.id,
      details: { username, role: 'user', status: 'pending' },
    });

    // Deliberately NOT setting a session cookie. A pending account must not
    // hold a usable session; the block belongs at /login.
    return Response.json(
      {
        message:
          'Registration received. Your account is pending Superadmin approval. ' +
          'You will be able to sign in once it has been approved.',
        user: { username: created.username, status: created.status },
        pending: true,
      },
      { status: 201 },
    );
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

export type { UserRow };
