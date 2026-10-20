import { requireUser, jsonError, handleRoute } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { syncRegisterMonth, describeSheetsError, sheetsUserMessage } from '@/lib/google-sheets';

const MAX_BODY_BYTES = 64 * 1024;
const MIGRATION_MESSAGE = 'Jalankan supabase/migrations/20261012_register_tail_trim.sql pada Supabase untuk mengaktifkan penghapusan surat dan pembersihan sisa nomor kosong.';

/** Release or trim numbers only after the deletion receipt confirms Sheets clearing. */
export async function DELETE(req: Request) {
  const response = await handleRoute(async () => {
    const user = await requireUser();
    let id: unknown;
    try {
      if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) return jsonError('Isi permintaan tidak valid.', 400);
      const bytes = await req.arrayBuffer();
      if (bytes.byteLength > MAX_BODY_BYTES) return jsonError('Isi permintaan tidak valid.', 400);
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('Isi permintaan tidak valid.', 400);
      id = (body as Record<string, unknown>).id;
    } catch {
      return jsonError('Isi permintaan tidak valid.', 400);
    }
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return jsonError('ID surat harus valid.', 400);

    const db = getSupabaseAdmin();
    const { error: capabilityError } = await db.rpc('get_document_deletion_status', {
      p_user_id: user.id, p_document_id: id,
    });
    if (capabilityError && !capabilityError.message.startsWith('NOT_FOUND')) {
      if (capabilityError.code === 'PGRST202' || capabilityError.code === '42883') return jsonError(MIGRATION_MESSAGE, 503);
      if (capabilityError.message.startsWith('FORBIDDEN')) return jsonError('Penghapusan surat tidak diizinkan.', 403);
      console.error('[documents/delete] capability check failed:', capabilityError.message);
      return jsonError('Tidak dapat memeriksa kesiapan penghapusan. Isi surat dan nomor belum diubah.', 500);
    }
    const { data, error } = await db.rpc('delete_registered_document', { p_user_id: user.id, p_document_id: id });
    if (error) {
      if (error.code === 'PGRST202' || error.code === '42883') return jsonError(MIGRATION_MESSAGE, 503);
      if (error.message.startsWith('NOT_FOUND')) return jsonError('Surat tidak ditemukan.', 404);
      if (error.message.startsWith('FORBIDDEN')) return jsonError('Penghapusan surat tidak diizinkan.', 403);
      if (error.message.startsWith('LEGACY_READ_ONLY')) return Response.json({ code: 'LEGACY_READ_ONLY', error: 'Arsip lama tanpa tanggal hanya dapat dibaca dan tidak dapat dihapus.' }, { status: 409 });
      console.error('[documents/delete] transaction failed:', error.message);
      return jsonError('Tidak dapat menghapus surat. Isi surat dan nomor belum diubah.', 500);
    }
    const deleted = data as { suratNumber: string; letterDate: string };
    let syncWarning: string | null = null;
    try {
      await syncRegisterMonth(Number(deleted.letterDate.slice(5, 7)));
    } catch (err) {
      syncWarning = sheetsUserMessage(err);
      console.error('[documents/delete] clearing remains queued:', describeSheetsError(err));
    }
    const { data: status, error: statusError } = await db.rpc('get_document_deletion_status', {
      p_user_id: user.id, p_document_id: id,
    });
    if (statusError?.code === 'PGRST202' || statusError?.code === '42883') {
      syncWarning = [syncWarning, MIGRATION_MESSAGE].filter(Boolean).join(' ');
    }
    const receipt = status as { releasePending?: unknown; trimmed?: unknown } | null;
    const statusConfirmed = !statusError && typeof receipt?.releasePending === 'boolean' && typeof receipt?.trimmed === 'boolean';
    const releasePending = !statusConfirmed || receipt?.releasePending !== false;
    const trimmed = statusConfirmed && !releasePending && receipt?.trimmed === true;
    if (!statusConfirmed) {
      console.error('[documents/delete] receipt could not be confirmed:', statusError?.message ?? 'Invalid deletion receipt');
      syncWarning = [syncWarning, 'Surat sudah dihapus, tetapi status pengosongan nomor belum dapat dikonfirmasi. Muat ulang antrean sinkronisasi.'].filter(Boolean).join(' ');
    }
    return Response.json({
      ...deleted,
      releasePending,
      trimmed,
      syncWarning,
      message: releasePending
        ? `Surat ${deleted.suratNumber} dihapus. Nomor masih ditahan sampai seluruh pengosongan terkait di Google Sheets dikonfirmasi; gunakan Sinkronkan ulang semua untuk mencoba lagi.`
        : trimmed
          ? `Surat ${deleted.suratNumber} dihapus. Seluruh sisa nomor kosong setelah nomor terpakai terakhir telah dihapus dari register dan Google Sheets. Nomor surat lain tidak berubah; alokasi berikutnya melanjutkan nomor terpakai terakhir.`
          : `Surat ${deleted.suratNumber} dihapus dan isinya di Google Sheets dikosongkan. Nomor dikembalikan ke register tanggal ${deleted.letterDate} untuk digunakan ulang.`,
    }, { status: releasePending ? 202 : 200 });
  });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
