import { requireAdmin, jsonError, handleRoute } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { writeAudit } from '@/lib/audit';

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: Request) {
  return handleRoute(async () => {
    const admin = await requireAdmin();
    if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) {
      return jsonError('Isi permintaan tidak valid.', 400);
    }
    let body: unknown;
    try {
      const bytes = await req.arrayBuffer();
      if (bytes.byteLength > MAX_BODY_BYTES) return jsonError('Isi permintaan tidak valid.', 400);
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return jsonError('Isi permintaan tidak valid.', 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonError('Isi permintaan tidak valid.', 400);
    }
    const value = (body as Record<string, unknown>).name;
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
      return jsonError('Nama satker wajib diisi, maksimal 100 karakter, dan tidak boleh mengandung karakter kontrol.', 400);
    }
    const { data: satker, error } = await getSupabaseAdmin()
      .from('satkers').insert({ name }).select('id,name').single();
    if (error) {
      if (error.code === '23505') return jsonError('Satker ini sudah terdaftar.', 409);
      console.error('[satkers] insert failed:', error.message);
      return jsonError('Tidak dapat menyimpan satker.', 500);
    }
    await writeAudit({
      userId: admin.id,
      action: 'CREATE_SATKER',
      targetId: satker.id,
      details: { name: satker.name },
    });
    return Response.json({ satker, message: 'Satker ditambahkan.' }, { status: 201 });
  });
}
