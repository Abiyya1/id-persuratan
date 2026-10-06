import { clearSessionCookie, getSession, handleRoute } from '@/lib/auth';
import { writeAudit, AuditAction } from '@/lib/audit';

/**
 * Logout.
 *
 * Clears the cookie and records the event. Idempotent -- calling it without a
 * session still returns 200, since "already logged out" is a valid outcome.
 */
export async function POST() {
  return handleRoute(async () => {
    const session = await getSession();

    if (session) {
      await writeAudit({
        userId: session.id,
        action: AuditAction.LOGOUT,
        targetId: session.id,
      });
    }

    await clearSessionCookie();
    return Response.json({ message: 'Signed out.' });
  });
}
