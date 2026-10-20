import { requireUser, jsonError, handleRoute } from '@/lib/auth';
import { writeAudit, AuditAction } from '@/lib/audit';
import { resyncDocumentById, retryFailedDocuments, retryPendingDeletions, countUnsynced } from '@/lib/resync';

const MAX_BODY_BYTES = 64 * 1024;

/** Retry one authorized letter, or the actor's pending letters and held deletions. */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const user = await requireUser();
    const createdBy = user.role === 'user' ? user.id : undefined;

    if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) {
      return jsonError('Isi permintaan tidak valid.', 400);
    }
    let body: Record<string, unknown>;
    try {
      const bytes = await req.arrayBuffer();
      if (bytes.byteLength > MAX_BODY_BYTES) return jsonError('Isi permintaan tidak valid.', 400);
      const text = new TextDecoder().decode(bytes);
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return jsonError('Isi permintaan tidak valid.', 400);
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return jsonError('Isi permintaan tidak valid.', 400);
    }

    const batch = body.batch === true;

    // ---- Single document ----------------------------------------------------
    if (!batch) {
      const id = Number(body.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return jsonError('ID surat harus valid.', 400);
      }

      const outcome = await resyncDocumentById(id, createdBy);

      if (!outcome) return jsonError('Surat tidak ditemukan.', 404);

      await writeAudit({
        userId: user.id,
        action: AuditAction.RESYNC_DOC,
        targetId: id,
        details: {
          outcome: outcome.ok ? 'success' : 'failed',
          error: outcome.error ?? null,
          statusPersisted: outcome.statusPersisted,
        },
      });
      if (outcome.code === 'LEGACY_READ_ONLY') {
        return Response.json({ code: outcome.code, error: outcome.error, outcome }, { status: 409 });
      }

      return Response.json({
        outcome,
        message: outcome.ok
          ? `Surat dengan ID ${id} disinkronkan ke Google Sheets.`
          : outcome.statusPersisted
            ? `Surat dengan ID ${id} gagal disinkronkan dan tetap dalam antrean untuk dicoba kembali.`
            : `Hasil sinkronisasi surat dengan ID ${id} belum dapat dikonfirmasi.`,
      });
    }

    // ---- Batch --------------------------------------------------------------
    const deletions = await retryPendingDeletions(createdBy);
    const outcomes = await retryFailedDocuments({ batchSize: 25, createdBy });
    const succeeded = outcomes.filter((o) => o.ok).length;
    const failed = outcomes.length - succeeded;
    const syncWarning = deletions.filter((item) => !item.ok).map((item) => item.error).join(' ') || null;

    await writeAudit({
      userId: user.id,
      action: AuditAction.RESYNC_DOC,
      targetId: 'batch',
      details: { attempted: outcomes.length, succeeded, failed, deletionMonths: deletions.length, syncWarning },
    });

    const remaining = await countUnsynced(createdBy);

    return Response.json({
      summary: { attempted: outcomes.length, succeeded, failed },
      remaining,
      outcomes,
      syncWarning,
      message: `${succeeded} surat berhasil disinkronkan; ${failed} gagal. ${remaining.deleting} nomor masih ditahan menunggu pengosongan Sheets.`,
    });
  });
}

/** Fresh-authorized, owner-scoped counts include numbers held for pending clearing. */
export async function GET() {
  return handleRoute(async () => {
    const user = await requireUser();
    const counts = await countUnsynced(user.role === 'user' ? user.id : undefined);

    return Response.json({
      ...counts,
      message:
        counts.failed + counts.pending + counts.deleting === 0
          ? 'Semua surat telah disinkronkan.'
          : `${counts.failed + counts.pending} surat menunggu sinkronisasi; ${counts.deleting} nomor belum tersedia karena pengosongan belum dikonfirmasi.`,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  });
}
