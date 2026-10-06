import { getSupabaseAdmin, type DocumentRow } from '@/lib/supabase';
import { requireUser, jsonError, handleRoute } from '@/lib/auth';
import type { SyncStatus } from '@/lib/supabase';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

interface ListParams {
  page: number;
  pageSize: number;
  search: string;
  syncStatus: SyncStatus | 'all';
  /** Restrict to one creator. Dashboard 1 passes the current user. */
  createdBy?: string;
}

function parseParams(url: URL): ListParams {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const rawSize = Number(url.searchParams.get('pageSize') ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE;

  const statusParam = url.searchParams.get('syncStatus') ?? 'all';

  return {
    page,
    pageSize: Math.min(Math.max(1, rawSize), MAX_PAGE_SIZE),
    search: (url.searchParams.get('search') ?? '').trim().slice(0, 100),
    syncStatus:
      statusParam === 'synced' || statusParam === 'pending' || statusParam === 'failed'
        ? statusParam
        : 'all',
    createdBy: url.searchParams.get('createdBy') ?? undefined,
  };
}

/**
 * Paginated document list.
 *
 * Available to any approved user. Dashboard 1 passes createdBy=<their id> and
 * sees only their own documents; Dashboard 2 omits it and sees everything.
 *
 * The anon key also has SELECT on documents for Realtime, so document titles
 * are readable by anyone who has the anon key regardless of this endpoint.
 */
export async function GET(req: Request) {
  return handleRoute(async () => {
    await requireUser();

    const url = new URL(req.url);
    const params = parseParams(url);
    const supabase = getSupabaseAdmin();

    let query = supabase
      .from('documents')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (params.syncStatus !== 'all') {
      query = query.eq('sync_status', params.syncStatus);
    }

    if (params.createdBy) {
      query = query.eq('created_by', params.createdBy);
    }

    if (params.search) {
      // Numeric input means "search by ID"; anything else searches the title.
      // ilike, not like, so the search is case-insensitive.
      const asNumber = Number(params.search);
      if (Number.isInteger(asNumber) && asNumber > 0) {
        query = query.eq('id', asNumber);
      } else {
        // Escape LIKE metacharacters so a literal % or _ does not act as a
        // wildcard. Backslash is the default escape char in Postgres LIKE.
        const escaped = params.search.replace(/[\\%_]/g, (c) => `\\${c}`);
        query = query.ilike('title', `%${escaped}%`);
      }
    }

    const from = (params.page - 1) * params.pageSize;
    const { data, error, count } = await query.range(from, from + params.pageSize - 1);

    if (error) {
      console.error('[documents/list] query failed:', error.message);
      return jsonError('Could not load documents.', 500);
    }

    const total = count ?? 0;

    return Response.json({
      documents: (data ?? []) as DocumentRow[],
      pagination: {
        page: params.page,
        pageSize: params.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
      },
    });
  });
}
