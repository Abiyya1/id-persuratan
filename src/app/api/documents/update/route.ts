import { getSupabaseAdmin, type DocumentRow } from '@/lib/supabase';
import { requireUser, jsonError, handleRoute } from '@/lib/auth';
import { writeAudit, AuditAction } from '@/lib/audit';
import { fetchClassifications } from '@/lib/google-sheets';
import { validateLetterInput, type LetterInput } from '@/lib/letter-fields';
import { syncDocument } from '@/lib/resync';

const MAX_BODY_BYTES = 64 * 1024;

/** Edit contents, never the allocated number, date, or private row key. */
export async function PATCH(req: Request) {
  return handleRoute(async () => {
    const user = await requireUser();
    const isAdmin = user.role === 'admin' || user.role === 'superadmin';
    const body = await readBody(req);
    if (!body) return jsonError('Isi permintaan tidak valid.', 400);
    const documentId = Number(body.id);
    if (!Number.isSafeInteger(documentId) || documentId <= 0) {
      return jsonError('ID surat harus valid.', 400);
    }
    if (['surat_number', 'letter_date', 'date', 'month', 'newId', 'emergency', 'emergencyReason'].some((key) => key in body)) {
      return jsonError('Nomor dan tanggal surat yang telah ditetapkan tidak dapat disunting.', 400);
    }
    if (body.title === undefined && body.metadata === undefined) {
      return jsonError('Tidak ada perubahan untuk disimpan.', 400);
    }

    const supabase = getSupabaseAdmin();
    let fetchQuery = supabase.from('documents').select('*').eq('id', documentId);
    if (!isAdmin) fetchQuery = fetchQuery.eq('created_by', user.id);
    const { data: existing, error: fetchError } = await fetchQuery.maybeSingle<DocumentRow>();
    if (fetchError) {
      console.error('[documents/update] fetch failed:', fetchError.message);
      return jsonError('Tidak dapat memuat surat.', 500);
    }
    if (!existing) return jsonError('Surat tidak ditemukan.', 404);

    if (!existing.letter_date) {
      return Response.json({
        code: 'LEGACY_READ_ONLY',
        error: 'Arsip lama hanya dapat dibaca dan tidak dapat diubah menjadi surat pada register bulanan.',
      }, { status: 409 });
    }
    const fields = body.metadata ?? existing.metadata;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return jsonError('Rincian surat tidak valid.', 400);
    }
    let input: LetterInput;
    try {
      input = validateLetterInput({
        ...(fields as Record<string, unknown>),
        hal: body.title ?? existing.title,
        date: existing.letter_date,
        month: Number(existing.letter_date.slice(5, 7)),
      });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : 'Data surat tidak valid.', 400);
    }
    const [classifications, satker] = await Promise.all([
      fetchClassifications(),
      supabase.from('satkers').select('id').eq('name', input.metadata.kdSatker).maybeSingle(),
    ]);
    if (satker.error) {
      console.error('[documents/update] satker query failed:', satker.error.message);
      return jsonError('Tidak dapat memeriksa katalog satker.', 500);
    }
    if (!classifications.some((item) => item.code === input.metadata.kdSurat)) {
      return jsonError('Pilih KD Surat dari Acuan No Surat.', 400);
    }
    if (!satker.data) return jsonError('Pilih KD Satker yang terdaftar.', 400);
    const patch = {
      title: input.hal,
      metadata: input.metadata,
      sync_status: 'pending',
      last_sync_error: null,
    };
    let updateQuery = supabase.from('documents').update(patch).eq('id', documentId)
      .eq('updated_at', existing.updated_at);
    if (!isAdmin) updateQuery = updateQuery.eq('created_by', user.id);
    const { data: updated, error: updateError } = await updateQuery.select('*').maybeSingle<DocumentRow>();
    if (updateError) {
      console.error('[documents/update] update failed:', updateError.message);
      if (updateError.message.includes('NON_TODAY_MANUAL_ONLY')) return jsonError('Untuk tanggal selain hari ini (WIB), pilih Ket MANUAL.', 400);
      if (updateError.message.includes('INVALID_INPUT')) return jsonError('Data surat tidak valid.', 400);
      return jsonError('Tidak dapat menyimpan perubahan surat.', 500);
    }
    if (!updated) return jsonError('Surat berubah saat disunting. Muat ulang dan coba lagi.', 409);

    await writeAudit({
      userId: user.id,
      action: AuditAction.EDIT_DOC,
      targetId: documentId,
      details: {
        surat_number: updated.surat_number,
        before: { title: existing.title, metadata: existing.metadata },
        after: { title: updated.title, metadata: updated.metadata },
      },
    });
    const outcome = await syncDocument(updated);
    return Response.json({
      document: outcome.document ?? updated,
      message: outcome.ok
        ? `Surat ${updated.surat_number} diperbarui dan disinkronkan ke baris register semula.`
        : outcome.statusPersisted
          ? `Surat ${updated.surat_number} diperbarui. Sinkronisasi Google Sheets masih dalam antrean untuk dicoba kembali.`
          : `Surat ${updated.surat_number} diperbarui, tetapi hasil sinkronisasi belum dapat dikonfirmasi.`,
      syncWarning: outcome.ok ? null : outcome.error,
    });
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
