import { getSupabaseAdmin, type DocumentRow, type SyncStatus } from '@/lib/supabase';
import { requireUser, jsonError, handleRoute } from '@/lib/auth';

const MAX_EXPORT_ROWS = 50_000;

/**
 * CSV export, honours the same filters as /api/documents/list.
 *
 * Scope depends on role:
 *   admin/superadmin -- may export everything, and may filter by any creator.
 *   user             -- locked to their own documents. The `createdBy` param is
 *                       ignored and overwritten with their id, so a crafted
 *                       request cannot pull someone else's rows.
 */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const user = await requireUser();
    const isAdmin = user.role === 'admin' || user.role === 'superadmin';

    const url = new URL(req.url);
    const search = (url.searchParams.get('search') ?? '').trim().slice(0, 100);
    const statusParam = url.searchParams.get('syncStatus') ?? 'all';
    const createdBy = isAdmin
      ? (url.searchParams.get('createdBy') ?? undefined)
      : user.id;

    const supabase = getSupabaseAdmin();

    let query = supabase.from('documents').select('*').order('created_at', { ascending: false });

    if (statusParam === 'synced' || statusParam === 'pending' || statusParam === 'failed') {
      query = query.eq('sync_status', statusParam as SyncStatus);
    }
    if (createdBy) query = query.eq('created_by', createdBy);

    if (search) {
      const asNumber = Number(search);
      if (Number.isInteger(asNumber) && asNumber > 0) {
        query = query.eq('id', asNumber);
      } else {
        const escaped = search.replace(/[\\%_]/g, (c) => `\\${c}`);
        query = query.ilike('title', `%${escaped}%`);
      }
    }

    // Hard cap so a runaway dataset cannot exhaust serverless memory.
    const { data, error } = await query.limit(MAX_EXPORT_ROWS);

    if (error) {
      console.error('[documents/export] query failed:', error.message);
      return jsonError('Could not export documents.', 500);
    }

    const rows = (data ?? []) as DocumentRow[];

    // ---- CSV construction ---------------------------------------------------
    const headers = [
      'Document ID',
      'Title',
      'Sync Status',
      'Sync Attempts',
      'Last Sync Error',
      'Created By',
      'Created At',
      'Updated At',
      'Metadata (JSON)',
    ];

    const lines = [headers.map(csvCell).join(',')];

    for (const doc of rows) {
      lines.push(
        [
          csvCell(doc.id),
          csvCell(doc.title),
          csvCell(doc.sync_status),
          csvCell(doc.sync_attempts),
          csvCell(doc.last_sync_error ?? ''),
          csvCell(doc.created_by ?? ''),
          csvCell(doc.created_at),
          csvCell(doc.updated_at),
          csvCell(JSON.stringify(doc.metadata ?? {})),
        ].join(','),
      );
    }

    // A BOM makes Excel open the file as UTF-8 instead of mangling non-ASCII
    // titles into mojibake.
    const csv = '\uFEFF' + lines.join('\r\n');

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="documents-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  });
}

/**
 * Quote a single CSV field.
 *
 * Also defuses CSV formula injection: a title starting with =, +, - or @ is
 * executed by Excel/Sheets on open unless it is neutralised. Prefixing with a
 * single quote makes it inert text.
 */
function csvCell(value: unknown): string {
  let str = value === null || value === undefined ? '' : String(value);

  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }

  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}
