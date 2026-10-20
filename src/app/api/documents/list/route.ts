import { getSupabaseAdmin, type DocumentRow, type SyncStatus } from '@/lib/supabase';
import { requireUser, jsonError, handleRoute } from '@/lib/auth';
import { normalizeRegisterNumber } from '@/lib/register-sheet';
import { parseDocumentSort, type DocumentSortField, type DocumentSortDirection } from '@/lib/document-sort';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const MIGRATION_MESSAGE = 'Jalankan supabase/migrations/20261011_document_sort.sql pada Supabase untuk mengaktifkan pengurutan nomor surat.';
const DOCUMENT_COLUMNS = 'id,surat_number,letter_date,title,metadata,created_by,sync_status,sync_attempts,last_sync_error,created_at,updated_at';

interface ListParams {
  page: number;
  pageSize: number;
  search: string;
  syncStatus: SyncStatus | 'all';
  sortBy: DocumentSortField;
  sortDirection: DocumentSortDirection;
  /** Optional administrator filter; ordinary users are always scoped server-side. */
  createdBy?: string;
}

function parseParams(url: URL): ListParams {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const rawSize = Number(url.searchParams.get('pageSize') ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE;

  const statusParam = url.searchParams.get('syncStatus') ?? 'all';

  return {
    page,
    ...parseDocumentSort(url.searchParams),
    pageSize: Math.min(Math.max(1, rawSize), MAX_PAGE_SIZE),
    search: (url.searchParams.get('search') ?? '').trim().slice(0, 100),
    syncStatus:
      statusParam === 'synced' || statusParam === 'pending' || statusParam === 'failed'
        ? statusParam
        : 'all',
    createdBy: url.searchParams.get('createdBy') ?? undefined,
  };
}

/** Paginated list, scoped to the current user's records unless they are an administrator. */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const user = await requireUser();

    const url = new URL(req.url);
    const params = parseParams(url);
    const supabase = getSupabaseAdmin();
    const isAdmin = user.role === 'admin' || user.role === 'superadmin';
    const createdBy = isAdmin ? params.createdBy : user.id;

    const ascending = params.sortDirection === 'asc';
    let query = supabase
      .from(params.sortBy === 'number' ? 'document_list_sorted' : 'documents')
      .select(DOCUMENT_COLUMNS, { count: 'exact' });

    if (params.sortBy === 'number') {
      query = query
        .order('number_sort_base', { ascending, nullsFirst: false })
        .order('number_sort_kind', { ascending })
        .order('number_sort_suffix', { ascending, nullsFirst: false });
    } else {
      query = query.order(params.sortBy === 'date' ? 'letter_date' : 'created_at', {
        ascending,
        nullsFirst: false,
      });
    }
    query = query.order('id', { ascending: true });

    if (params.syncStatus !== 'all') {
      query = query.eq('sync_status', params.syncStatus);
    }

    if (createdBy) {
      query = query.eq('created_by', createdBy);
    }

    if (params.search) {
      const number = normalizeRegisterNumber(params.search.toLowerCase());
      if (number) {
        query = query.eq('surat_number', number);
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
      if (params.sortBy === 'number' && ['PGRST205', 'PGRST204', '42P01', '42703'].includes(error.code)) {
        return jsonError(MIGRATION_MESSAGE, 503);
      }
      console.error('[documents/list] query failed:', error.message);
      return jsonError('Tidak dapat memuat daftar surat.', 500);
    }

    const total = count ?? 0;

    return Response.json({
      scope: createdBy ?? 'all',
      documents: (data ?? []) as DocumentRow[],
      pagination: {
        page: params.page,
        pageSize: params.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
      },
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  });
}
