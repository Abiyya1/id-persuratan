import { AuthError, handleRoute } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { writeAudit, AuditAction } from '@/lib/audit';
import { retryFailedDocuments, countUnsynced } from '@/lib/resync';
import { checkSheetsConfig, syncRegisterCalendar, describeSheetsError, sheetsUserMessage } from '@/lib/google-sheets';
import { ensureLetterRegister } from '@/lib/letter-register';
import { getRegisterToday } from '@/lib/letter-fields';

/** Five-minute cron closes elapsed WIB days and retries the persisted projection queue. */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
      console.error('[cron/resync] CRON_SECRET is not configured.');
      return Response.json({ error: 'Penjadwal sinkronisasi belum dikonfigurasi.' }, { status: 500 });
    }
    if (!timingSafeEqual(req.headers.get('authorization') ?? '', `Bearer ${secret}`)) {
      return Response.json({ error: 'Akses tidak diizinkan.' }, { status: 401 });
    }

    const startedAt = Date.now();
    try {
      await ensureLetterRegister();
      // Vercel's daily UTC16:59 trigger is WIB23:59; delayed runs use normal catchup.
      const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
      const closeToday = new URL(req.url).searchParams.get('closeDay') === '1' && clock === '23:59';
      const tomorrow = new Date(`${getRegisterToday()}T00:00:00Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const { error: closeError } = await getSupabaseAdmin().rpc('close_letter_days', closeToday ? { p_today: tomorrow.toISOString().slice(0, 10) } : {});
      const closingDeferred = closeError?.message.startsWith('REGISTER_TRIM_PENDING:') ?? false;
      if (closeError && !closingDeferred) {
        console.error('[cron/resync] day closing failed:', closeError.message);
        if (closeError.message.startsWith('REGISTER_CONFLICT') || closeError.message.startsWith('TARGET_TOO_SMALL')) {
          throw new AuthError('Rencana jumlah nomor bertentangan dengan rentang register. Administrator perlu meninjau atau menghapus rencana di Pengaturan Nomor Surat; nomor yang sudah ada tidak diubah.', 409);
        }
        throw new Error('Tidak dapat menutup register tanggal yang telah berlalu.');
      }

      // Closing is a DB operation and must not be skipped just because Sheets is unavailable.
      const config = await checkSheetsConfig();
      if (!config.ok) throw new Error(`Google Sheets belum dikonfigurasi: ${config.detail}`);
      let calendarError: string | null = null;
      try {
        await syncRegisterCalendar();
      } catch (err) {
        calendarError = sheetsUserMessage(err);
        console.error('[cron/resync] calendar projection failed:', describeSheetsError(err));
      }
      const outcomes = await retryFailedDocuments({ batchSize: 25 });
      const succeeded = outcomes.filter((outcome) => outcome.ok).length;
      const failed = outcomes.length - succeeded;
      const remaining = await countUnsynced();
      const ok = failed === 0 && calendarError === null;
      const summary = {
        attempted: outcomes.length,
        succeeded,
        failed,
        remainingFailed: remaining.failed,
        remainingPending: remaining.pending,
        calendarError,
        closingDeferred,
        durationMs: Date.now() - startedAt,
      };
      if (outcomes.length > 0 || !ok) {
        await writeAudit({
          userId: null,
          action: AuditAction.CRON_RESYNC,
          targetId: 'batch',
          details: summary,
        });
      }
      console.log('[cron/resync]', JSON.stringify(summary));
      return Response.json({
        ok,
        ...summary,
        failures: outcomes.filter((outcome) => !outcome.ok).slice(0, 10)
          .map((outcome) => ({ id: outcome.documentId, error: outcome.error })),
      }, { status: ok ? 200 : 500 });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Pembaruan register tertunda gagal.';
      console.error('[cron/resync]', error);
      await writeAudit({
        userId: null,
        action: AuditAction.CRON_RESYNC,
        targetId: 'batch',
        details: { error, durationMs: Date.now() - startedAt },
      });
      return Response.json({ ok: false, error }, { status: err instanceof AuthError ? err.status : 500 });
    }
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
