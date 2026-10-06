import { handleRoute } from '@/lib/auth';
import { writeAudit, AuditAction } from '@/lib/audit';
import { retryFailedDocuments, countUnsynced } from '@/lib/resync';
import { checkSheetsConfig } from '@/lib/google-sheets';

/**
 * Vercel Cron entry point -- runs every 5 minutes (see vercel.json).
 *
 * Authenticated with CRON_SECRET, NOT a session cookie. Vercel sends the
 * secret as `Authorization: Bearer <CRON_SECRET>`; anything else gets 401.
 * This exclusion is why middleware.ts skips the /api/* prefix -- there is no
 * cookie to check here.
 */
export async function GET(req: Request) {
  return handleRoute(async () => {
    // ---- Auth ---------------------------------------------------------------
    const secret = process.env.CRON_SECRET;

    if (!secret) {
      console.error('[cron/resync] CRON_SECRET is not configured.');
      return Response.json({ error: 'Cron is not configured.' }, { status: 500 });
    }

    const authHeader = req.headers.get('authorization') ?? '';
    const expected = `Bearer ${secret}`;

    // Constant-time compare so the secret cannot be recovered by timing the
    // endpoint.
    if (!timingSafeEqual(authHeader, expected)) {
      return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    // ---- Preflight ----------------------------------------------------------
    // Fail fast and loudly if Sheets is unconfigured, rather than burning
    // through the batch marking every row failed for the same reason.
    const config = await checkSheetsConfig();
    if (!config.ok) {
      console.error('[cron/resync] Google Sheets is not configured:', config.detail);
      return Response.json(
        { error: 'Google Sheets is not configured.', detail: config.detail },
        { status: 500 },
      );
    }

    // ---- Retry --------------------------------------------------------------
    const startedAt = Date.now();
    const outcomes = await retryFailedDocuments({ batchSize: 25 });

    const succeeded = outcomes.filter((o) => o.ok).length;
    const failed = outcomes.length - succeeded;
    const remaining = await countUnsynced();

    const summary = {
      attempted: outcomes.length,
      succeeded,
      failed,
      remainingFailed: remaining.failed,
      durationMs: Date.now() - startedAt,
    };

    // Log one summary line per run. A run with nothing to do is normal and
    // should not fill the audit table.
    if (outcomes.length > 0) {
      await writeAudit({
        userId: null, // System-initiated, no acting user.
        action: AuditAction.CRON_RESYNC,
        targetId: 'batch',
        details: summary,
      });
    }

    console.log('[cron/resync]', JSON.stringify(summary));

    return Response.json({
      ok: true,
      ...summary,
      // Surfaced so a partially-failing queue is visible in the Vercel logs
      // even when every individual append failed.
      failures: outcomes
        .filter((o) => !o.ok)
        .slice(0, 10)
        .map((o) => ({ id: o.documentId, error: o.error })),
    });
  });
}

/** Length-safe, constant-time string comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}
