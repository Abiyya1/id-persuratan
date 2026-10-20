import { requireUser, jsonError, handleRoute } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { fetchClassifications } from '@/lib/google-sheets';
import { getRegisterToday, REGISTER_YEAR } from '@/lib/letter-fields';

export async function GET() {
  return handleRoute(async () => {
    await requireUser();
    const [classifications, satkers] = await Promise.all([
      fetchClassifications(),
      getSupabaseAdmin().from('satkers').select('id,name').order('name'),
    ]);
    if (satkers.error) {
      console.error('[documents/options] catalog query failed:', satkers.error.message);
      return jsonError('Tidak dapat memuat katalog satker.', 500);
    }
    return Response.json({
      classifications,
      satkers: satkers.data ?? [],
      today: getRegisterToday(),
      year: REGISTER_YEAR,
    }, { headers: { 'Cache-Control': 'no-store' } });
  });
}
