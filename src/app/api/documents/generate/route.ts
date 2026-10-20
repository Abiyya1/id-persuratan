import { getSupabaseAdmin, type DocumentRow } from '@/lib/supabase';
import { requireUser, jsonError, handleRoute } from '@/lib/auth';
import { writeAudit, AuditAction } from '@/lib/audit';
import { fetchClassifications } from '@/lib/google-sheets';
import { ensureLetterRegister } from '@/lib/letter-register';
import { validateLetterInput, type LetterInput } from '@/lib/letter-fields';
import { syncDocument } from '@/lib/resync';

const MAX_BODY_BYTES = 64 * 1024;

/** PostgreSQL allocates and persists first; a Sheets outage never loses a letter. */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const user = await requireUser();
    const body = await readBody(req);
    if (!body) return jsonError('Isi permintaan tidak valid.', 400);
    // Neither the official number nor the private row key is caller-allocated.
    if ('id' in body || 'surat_number' in body || 'number' in body) {
      return jsonError('Nomor surat ditetapkan secara otomatis.', 400);
    }

    let input: LetterInput;
    try {
      input = validateLetterInput(body);
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : 'Data surat tidak valid.', 400);
    }
    if (input.emergency && user.role !== 'admin' && user.role !== 'superadmin') {
      return jsonError('Nomor darurat hanya dapat dibuat oleh administrator.', 403);
    }

    const supabase = getSupabaseAdmin();
    const [classifications, satker] = await Promise.all([
      fetchClassifications(),
      supabase.from('satkers').select('id').eq('name', input.metadata.kdSatker).maybeSingle(),
    ]);
    if (satker.error) {
      console.error('[documents/generate] satker query failed:', satker.error.message);
      return jsonError('Tidak dapat memeriksa katalog satker.', 500);
    }
    if (!classifications.some((item) => item.code === input.metadata.kdSurat)) {
      return jsonError('Pilih KD Surat dari Acuan No Surat.', 400);
    }
    if (!satker.data) return jsonError('Pilih KD Satker yang terdaftar.', 400);

    await ensureLetterRegister();
    const { data, error } = await supabase.rpc('create_registered_document', {
      p_user_id: user.id,
      p_date: input.date,
      p_title: input.hal,
      p_metadata: input.metadata,
      p_emergency: input.emergency,
      p_reason: input.emergencyReason,
    });
    if (error) {
      console.error('[documents/generate] allocation failed:', error.message);
      if (error.message.startsWith('REGISTER_TRIM_PENDING:')) {
        return Response.json({
          code: 'REGISTER_TRIM_PENDING',
          error: 'Pembersihan sisa nomor di Google Sheets masih menunggu konfirmasi. Gunakan Sinkronkan ulang semua sebelum menambah rentang nomor. Nomor belum dialokasikan.',
        }, { status: 409 });
      }
      if (error.message.startsWith('REGISTER_RESTORE_CONFLICT:')) {
        return Response.json({
          code: 'REGISTER_RESTORE_CONFLICT',
          error: 'Sisa nomor harian setelah pemangkasan belum dapat dipulihkan karena sudah ada rentang tanggal berikutnya. Hubungi administrator untuk meninjau surat terakhir yang dibuat setelah pemangkasan; bila surat itu dihapus, sinkronkan ulang semua lalu buat ulang. Nomor surat yang sudah dipakai tidak diubah dan nomor baru belum dialokasikan.',
        }, { status: 409 });
      }
      if (error.message.includes('DAY_FULL')) {
        return Response.json({
          code: 'DAY_FULL',
          error: 'Tidak ada nomor kosong pada tanggal ini. Administrator dapat mengonfirmasi nomor darurat dengan mengisi alasan.',
        }, { status: 409 });
      }
      if (error.message.includes('DAY_MISSING')) {
        return jsonError('Tanggal lampau ini tidak memiliki rentang register. Pilih tanggal yang tersedia atau hari ini.', 409);
      }
      if (error.message.startsWith('REGISTER_CONFLICT') || error.message.startsWith('TARGET_TOO_SMALL')) {
        return Response.json({ code: 'REGISTER_CONFLICT', error: 'Rencana jumlah nomor bertentangan dengan rentang yang sudah tersedia. Hubungi administrator untuk meninjau atau menghapus rencana di Pengaturan Nomor Surat. Nomor belum dialokasikan.' }, { status: 409 });
      }
      if (error.message.includes('FORBIDDEN')) return jsonError('Pembuatan nomor ini tidak diizinkan.', 403);
      if (error.message.includes('NON_TODAY_MANUAL_ONLY')) return jsonError('Untuk tanggal selain hari ini (WIB), pilih Ket MANUAL.', 400);
      if (error.message.includes('INVALID_INPUT')) return jsonError('Data surat tidak valid.', 400);
      return jsonError('Tidak dapat membuat nomor dan menyimpan surat. Coba lagi.', 500);
    }
    const doc = data as DocumentRow | null;
    if (!doc || typeof doc.id !== 'number' || typeof doc.surat_number !== 'string') {
      return jsonError('Register mengembalikan data surat yang tidak valid.', 500);
    }

    await writeAudit({
      userId: user.id,
      action: AuditAction.CREATE_DOC,
      targetId: doc.id,
      details: {
        surat_number: doc.surat_number,
        date: input.date,
        title: input.hal,
        metadata: input.metadata,
        emergency: input.emergency,
        emergencyReason: input.emergencyReason,
      },
    });
    const outcome = await syncDocument(doc);
    return Response.json({
      document: outcome.document ?? doc,
      message: outcome.ok
        ? `Surat ${doc.surat_number} dibuat dan disinkronkan ke Google Sheets.`
        : outcome.statusPersisted
          ? `Surat ${doc.surat_number} tersimpan. Sinkronisasi Google Sheets masih dalam antrean untuk dicoba kembali.`
          : `Surat ${doc.surat_number} tersimpan, tetapi hasil sinkronisasi belum dapat dikonfirmasi.`,
      syncWarning: outcome.ok ? null : outcome.error,
    }, { status: 201 });
  });
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const length = Number(req.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) return null;
  try {
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength > MAX_BODY_BYTES) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
