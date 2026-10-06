import { getSupabaseAdmin, type AuditLogRow } from '@/lib/supabase';
import { requireAdmin, handleRoute } from '@/lib/auth';

/**
 * Paginated audit log for Dashboard 2's Audit Log tab.
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

    const supabase = getSupabaseAdmin();

    let query = supabase
      .from('audit_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (actionFilter) query = query.eq('action', actionFilter);

    const from = (page - 1) * pageSize;
    const { data, error, count } = await query.range(from, from + pageSize - 1);

    if (error) {
      console.error('[audit] query failed:', error.message);
      return Response.json({ error: 'Could not load the audit log.' }, { status: 500 });
    }

    const total = count ?? 0;

    return Response.json({
      logs: (data ?? []) as AuditLogRow[],
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  });
}
