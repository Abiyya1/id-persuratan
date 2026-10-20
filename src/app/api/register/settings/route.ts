import { handleRoute, jsonError, requireAdmin } from '@/lib/auth';
import { getRegisterToday } from '@/lib/letter-fields';
import { getSupabaseAdmin } from '@/lib/supabase';
import { validateRegisterDefaults, validateRegisterDayDate, validateRegisterDayTarget, validateRegisterSettings } from '@/lib/register-settings';

const MAX_BODY_BYTES = 64 * 1024;
const MIGRATION_MESSAGE = 'Jalankan supabase/migrations/20261009_register_settings.sql pada Supabase untuk mengaktifkan pengaturan nomor surat.';

async function readBody(req: Request): Promise<unknown> {
  if (Number(req.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) throw new Error('Isi permintaan terlalu besar (maksimal 64 KiB).');
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) throw new Error('Isi permintaan terlalu besar (maksimal 64 KiB).');
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error('Isi permintaan harus berupa JSON yang valid.'); }
}

async function settingsRoute(req?: Request, method = 'GET') {
  const response = await handleRoute(async () => {
    const user = await requireAdmin();
    let rpc = 'get_register_settings';
    let args: Record<string, unknown> = {};
    if (req) {
      try {
        const body = await readBody(req);
        if (method === 'PUT') {
          const defaults = validateRegisterDefaults(body);
          rpc = 'save_register_defaults';
          args = { p_user_id: user.id, p_closing_unused_minimum: defaults.closingUnusedMinimum, p_future_daily_total: defaults.futureDailyTotal };
        } else if (method === 'POST') {
          const target = validateRegisterDayTarget(body, getRegisterToday());
          rpc = 'set_register_day_target';
          args = { p_user_id: user.id, p_date: target.date, p_total: target.total };
        } else {
          const target = validateRegisterDayDate(body);
          rpc = 'delete_register_day_target';
          args = { p_user_id: user.id, p_date: target.date };
        }
      } catch (error) {
        return jsonError(error instanceof Error ? error.message : 'Isi permintaan tidak valid.', 400);
      }
    }
    let result;
    try {
      result = await getSupabaseAdmin().rpc(rpc, args);
    } catch (error) {
      console.error('[register/settings] connection failed:', error);
      return jsonError('Pengaturan belum dapat diproses. Muat ulang untuk memastikan keadaan terbaru sebelum mencoba lagi.', 503);
    }
    const { data, error } = result;
    if (error) {
      if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(error.code)) return jsonError(MIGRATION_MESSAGE, 503);
      if (error.message.startsWith('FORBIDDEN')) return jsonError('Akses administrator yang disetujui diperlukan.', 403);
      if (error.message.startsWith('INVALID_INPUT')) return jsonError(error.message.replace(/^INVALID_INPUT:\s*/, ''), 400);
      if (error.message.startsWith('TARGET_LOCKED')) return jsonError('Tanggal ini terkunci karena sudah lewat, ditutup, ditetapkan, atau terdapat rentang nomor pada tanggal setelahnya. Nomor yang sudah ada tidak dapat diubah.', 409);
      if (error.message.startsWith('TARGET_TOO_SMALL') || error.message.startsWith('REGISTER_CONFLICT')) return jsonError('Rencana bertentangan dengan rentang nomor yang sudah tersedia. Total tidak boleh lebih kecil dari jumlah nomor biasa yang sudah ada dan nomor tidak dapat diubah.', 409);
      console.error('[register/settings] RPC failed:', error.message);
      return jsonError('Pengaturan belum dapat diproses. Muat ulang untuk memastikan keadaan terbaru sebelum mencoba lagi.', 503);
    }
    try { return Response.json(validateRegisterSettings(data)); }
    catch (error) {
      console.error('[register/settings] invalid RPC response:', error);
      return jsonError('Respons pengaturan tidak valid. Muat ulang untuk memastikan keadaan terbaru; keberhasilan penyimpanan belum dapat dikonfirmasi.', 503);
    }
  });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export async function GET() { return settingsRoute(); }
export async function PUT(req: Request) { return settingsRoute(req, 'PUT'); }
export async function POST(req: Request) { return settingsRoute(req, 'POST'); }
export async function DELETE(req: Request) { return settingsRoute(req, 'DELETE'); }
