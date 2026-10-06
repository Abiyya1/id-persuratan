import { requireAdmin, jsonError, handleRoute } from '@/lib/auth';
import { writeAudit, AuditAction } from '@/lib/audit';
import { resyncDocumentById, retryFailedDocuments, countUnsynced } from '@/lib/resync';

/**
 * Manual "Re-sync to Sheet" trigger for Dashboard 2.
 *
 * Two modes:
 *   POST { id: 101 }              -> retry that one document
 *   POST { id: 0, batch: true }   -> retry every failed document (same engine
 *                                    the cron job uses)
 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const admin = await requireAdmin();

    let body: Record<string, unknown> = {};
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return jsonError('Invalid request body.', 400);
    }

    const batch = body.batch === true;

    // ---- Single document ----------------------------------------------------
    if (!batch) {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) {
        return jsonError('A valid document id is required.', 400);
      }

      const outcome = await resyncDocumentById(id);

      if (!outcome) return jsonError('Document not found.', 404);

      await writeAudit({
        userId: admin.id,
        action: AuditAction.RESYNC_DOC,
        targetId: id,
        details: { outcome: outcome.ok ? 'success' : 'failed', error: outcome.error ?? null },
      });

      return Response.json({
        outcome,
        message: outcome.ok
          ? `Document ${id} synced to Google Sheets.`
          : `Document ${id} could not be synced. It remains queued for retry.`,
      });
    }

    // ---- Batch --------------------------------------------------------------
    const outcomes = await retryFailedDocuments({ batchSize: 25 });
    const succeeded = outcomes.filter((o) => o.ok).length;
    const failed = outcomes.length - succeeded;

    await writeAudit({
      userId: admin.id,
      action: AuditAction.RESYNC_DOC,
      targetId: 'batch',
      details: { attempted: outcomes.length, succeeded, failed },
    });

    const remaining = await countUnsynced();

    return Response.json({
      summary: { attempted: outcomes.length, succeeded, failed },
      remaining,
      outcomes,
      message:
        failed === 0
          ? `Re-synced ${succeeded} document${succeeded === 1 ? '' : 's'}.`
          : `Re-synced ${succeeded}, ${failed} still failing. They will retry automatically.`,
    });
  });
}

/** GET reports queue depth so the admin UI can show a live badge. */
export async function GET() {
  return handleRoute(async () => {
    await requireAdmin();
    const counts = await countUnsynced();

    return Response.json({
      ...counts,
      message:
        counts.failed === 0
          ? 'All documents are synced.'
          : `${counts.failed} document${counts.failed === 1 ? '' : 's'} awaiting retry.`,
    });
  });
}
