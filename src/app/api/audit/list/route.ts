import { getSupabaseAdmin, type AuditLogRow } from '@/lib/supabase';
import { requireAdmin, handleRoute } from '@/lib/auth';

/**
 * Paginated audit log for the Audit Log page at /admin/audit.
 *
 * Admin-only: the log contains usernames and internal actions.
 */
export async function GET(req: Request) {
  return handleRoute(async () => {
    await requireAdmin();

    const url = new URL(req.url);

    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    const rawSize = Number(url.searchParams.get('pageSize') ?? '50') || 50;
    const pageSize = Math.min(Math.max(1, rawSize), 100);

    const actionFilter = (url.searchParams.get('action') ?? '').trim().slice(0, 50);
    const search = (url.searchParams.get('search') ?? '').trim().slice(0, 100);

    const supabase = getSupabaseAdmin();

    let query = supabase
      .from('audit_logs')
      .select(`*, actor:users!audit_logs_user_id_fkey(username)${search ? ', actor_search:users!audit_logs_user_id_fkey()' : ''}`, { count: 'exact' })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });

    if (actionFilter) query = query.eq('action', actionFilter);

    if (search) {
      const pattern = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const quoted = `"${pattern.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      query = query.filter('actor_search.username', 'imatch', pattern)
        .or(`actor_search.not.is.null,target_id.imatch.${quoted},details->>surat_number.imatch.${quoted}`);
    }

    const from = (page - 1) * pageSize;
    const { data, error, count } = await query.range(from, from + pageSize - 1)
      .overrideTypes<(AuditLogRow & { actor: { username: string } | null })[], { merge: false }>();

    if (error) {
      console.error('[audit] query failed:', error.message);
      return Response.json({ error: 'Tidak dapat memuat riwayat audit.' }, { status: 500 });
    }

    const total = count ?? 0;

    return Response.json({
      logs: data ?? [],
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  });
}
