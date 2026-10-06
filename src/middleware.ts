import { NextResponse, type NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

// ---------------------------------------------------------------------------
// Runs on the Edge runtime before any protected page renders.
//
// Two jobs:
//   1. Redirect unauthenticated users away from protected routes.
//   2. Block non-approved accounts (the "pending approval" rule).
//
// This is a coarse first gate, NOT the security boundary. A JWT can be
// revoked or a role changed server-side long before this token expires, so
// every API route re-verifies against Postgres via getFreshSession().
// Middleware exists to stop pointless renders and give fast redirects, not to
// be the only thing standing between a user and admin data.
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'dlms_session';

const PUBLIC_PATHS = new Set(['/', '/login', '/register']);

/** Routes requiring admin or superadmin. */
const ADMIN_PREFIXES = ['/admin'];

/** Routes requiring superadmin. */
const SUPERADMIN_PREFIXES = ['/api/superadmin'];

function getSecret(): Uint8Array | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  return new TextEncoder().encode(secret);
}

interface TokenClaims {
  sub: string;
  username: string;
  role: 'user' | 'admin' | 'superadmin';
  status: 'pending' | 'approved' | 'rejected';
}

async function readSession(req: NextRequest): Promise<TokenClaims | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const secret = getSecret();
  if (!token || !secret) return null;

  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (!payload.sub) return null;

    const role = payload.role;
    const status = payload.status;
    if (role !== 'user' && role !== 'admin' && role !== 'superadmin') return null;
    if (status !== 'pending' && status !== 'approved' && status !== 'rejected') return null;
    if (typeof payload.username !== 'string') return null;

    return {
      sub: payload.sub,
      username: payload.username,
      role,
      status,
    };
  } catch {
    return null;
  }
}

/** Send to /login with a reason, preserving the page they were trying to reach. */
function redirectToLogin(req: NextRequest, reason: string) {
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  if (reason) url.searchParams.set('reason', reason);
  if (req.nextUrl.pathname !== '/') {
    url.searchParams.set('next', req.nextUrl.pathname);
  }
  return NextResponse.redirect(url);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const session = await readSession(req);

  // ---- Auth pages -----------------------------------------------------------
  // Only a fully approved account is bounced away from /login and /register.
  //
  // A pending or rejected account MUST be allowed to render these pages --
  // that is where the "pending approval" banner is read. Redirecting them to
  // a portal, which would redirect them right back here, is an infinite loop.
  if (pathname === '/login' || pathname === '/register') {
    if (!session || session.status !== 'approved') return NextResponse.next();
    return NextResponse.redirect(
      new URL(session.role === 'user' ? '/dashboard' : '/admin', req.url),
    );
  }

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  // ---- Protected routes -----------------------------------------------------
  if (!session) return redirectToLogin(req, '');

  // "Your account is pending Superadmin approval."
  // A rejected account gets its own message so the cause is unambiguous.
  if (session.status === 'pending') {
    return redirectToLogin(req, 'pending');
  }
  if (session.status === 'rejected') {
    return redirectToLogin(req, 'rejected');
  }

  // ---- Role gates -----------------------------------------------------------
  const isAdmin = session.role === 'admin' || session.role === 'superadmin';

  if (SUPERADMIN_PREFIXES.some((p) => pathname.startsWith(p)) && !isAdmin) {
    return NextResponse.json({ error: 'Superadmin access required.' }, { status: 403 });
  }

  // A plain `user` reaching /admin is not an auth failure -- they ARE signed
  // in. Send them to their own portal rather than to /login, which would look
  // like they had been logged out for merely clicking a link.
  if (ADMIN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`)) && !isAdmin) {
    return NextResponse.redirect(new URL('/dashboard', req.url));
  }

  // Mirror image: admins and superadmins have no "My Documents" nav link (see
  // AppNav), so landing on /dashboard is a dead end. Point them at Management.
  if (isAdmin && (pathname === '/dashboard' || pathname.startsWith('/dashboard/'))) {
    return NextResponse.redirect(new URL('/admin', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Page routes: everything except static assets and Next internals.
     *
     * API routes are deliberately EXCLUDED (see the second entry). Auth and
     * cron endpoints cannot have a session cookie yet, so running them
     * through this redirect logic would bounce /api/auth/login to the login
     * page and break sign-in. Every protected API route already calls
     * requireUser()/requireAdmin(), which re-reads Postgres -- a strictly
     * stronger check than inspecting a cookie here.
     */
    '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
