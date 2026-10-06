import 'server-only';

import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { getSupabaseAdmin, type Role, type UserRow, type UserStatus } from './supabase';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'dlms_session';

/** 12 rounds. ~250ms on modern hardware -- slow enough to resist offline cracking. */
const BCRYPT_ROUNDS = 12;

/** Sessions last 8 hours. */
const SESSION_TTL_SECONDS = 60 * 60 * 8;

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
}

export const PENDING_MESSAGE = 'Your account is pending Superadmin approval.';

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Password policy. Enforced server-side; the UI mirrors it for UX only.
 * Returns an error string, or null when the password is acceptable.
 */
export function validatePasswordStrength(plain: string): string | null {
  if (plain.length < 8) return 'Password must be at least 8 characters.';
  if (plain.length > 200) return 'Password must be under 200 characters.';
  if (!/[a-zA-Z]/.test(plain)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(plain)) return 'Password must contain at least one number.';
  return null;
}

/** Usernames go into URLs, logs and a spreadsheet column. Keep them boring. */
export function validateUsername(username: string): string | null {
  if (username.length < 3) return 'Username must be at least 3 characters.';
  if (username.length > 50) return 'Username must be under 50 characters.';
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    return 'Username may only contain letters, numbers, dot, underscore and hyphen.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// JWT session
// ---------------------------------------------------------------------------

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'SESSION_SECRET is missing or shorter than 32 characters. Generate one with: openssl rand -base64 48',
    );
  }
  return new TextEncoder().encode(secret);
}

/**
 * Sign the session token.
 *
 * `status` is embedded so middleware can reject a pending/rejected account
 * without a database round trip on every navigation.
 */
export async function signSession(user: SessionUser): Promise<string> {
  return new SignJWT({
    username: user.username,
    role: user.role,
    status: user.status,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecret());
}

/** Verify and decode. Returns null for any invalid/expired token. */
export async function verifySession(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] });

    if (!payload.sub) return null;

    const role = payload.role as Role;
    const status = payload.status as UserStatus;

    // Do not trust the token's shape blindly -- a valid signature on garbage
    // claims should still fail closed.
    if (!['user', 'admin', 'superadmin'].includes(role)) return null;
    if (!['pending', 'approved', 'rejected'].includes(status)) return null;
    if (typeof payload.username !== 'string') return null;

    return {
      id: payload.sub,
      username: payload.username,
      role,
      status,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

/**
 * Cookie attributes are fixed here so every write path is identical.
 *
 * httpOnly  -- JS cannot read it, so XSS cannot exfiltrate the session.
 * sameSite  -- 'lax' blocks cross-site POST/CSRF while keeping normal
 *              top-level navigation working.
 * secure    -- production only, so plain-HTTP localhost dev still works.
 */
export async function setSessionCookie(user: SessionUser): Promise<void> {
  const token = await signSession(user);
  const store = await cookies();

  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
}

/** Read + verify the current session. Null when absent, expired, or invalid. */
export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

/**
 * Re-read the user from the database and return null if they are no longer
 * usable.
 *
 * The JWT keeps `role`/`status` for 8 hours. If a superadmin demotes or
 * rejects someone, that change must take effect immediately, so any
 * *privileged* operation calls this instead of trusting the token.
 */
export async function getFreshSession(): Promise<SessionUser | null> {
  const session = await getSession();
  if (!session) return null;

  const { data } = await getSupabaseAdmin()
    .from('users')
    .select('id, username, role, status')
    .eq('id', session.id)
    .maybeSingle<Pick<UserRow, 'id' | 'username' | 'role' | 'status'>>();

  if (!data) return null;
  if (data.status !== 'approved') return null;

  return {
    id: data.id,
    username: data.username,
    role: data.role,
    status: data.status,
  };
}

// ---------------------------------------------------------------------------
// Guards -- throw to be caught by the route's error handler
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Any logged-in, approved account. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getFreshSession();
  if (!user) throw new AuthError('Not authenticated.', 401);
  return user;
}

/** admin or superadmin. */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== 'admin' && user.role !== 'superadmin') {
    throw new AuthError('Administrator access required.', 403);
  }
  return user;
}

/** superadmin only. */
export async function requireSuperadmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== 'superadmin') {
    throw new AuthError('Superadmin access required.', 403);
  }
  return user;
}

// ---------------------------------------------------------------------------
// Standard JSON responses -- keeps route handlers uniform
// ---------------------------------------------------------------------------

export function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

/** Wrap a handler so thrown AuthError becomes a clean JSON response. */
export async function handleRoute(
  fn: () => Promise<Response>,
): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonError(err.message, err.status);
    }
    console.error('[api] unhandled error:', err);
    return jsonError('Internal server error.', 500);
  }
}
