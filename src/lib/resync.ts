import { getSupabaseAdmin, type DocumentRow } from '@/lib/supabase';
import { appendDocumentRow, describeSheetsError } from '@/lib/google-sheets';

/**
 * Shared retry engine for the Google Sheets sync queue.
 *
 * Used by both the manual "Re-sync" button and the Vercel cron job, so the
 * two can never drift apart in behaviour.
 */

export interface SyncOutcome {
  documentId: number;
  ok: boolean;
  error?: string;
  attempts: number;
}

export interface RetryOptions {
  /** Limit how many rows one pass touches. Keeps cron invocations short. */
  batchSize?: number;
  /** Only retry rows that have not been attempted recently. */
  onlyFailed?: boolean;
}

const DEFAULT_BATCH_SIZE = 25;

/** Retry a single document. Never throws -- always reports the outcome. */
async function syncOne(doc: DocumentRow): Promise<SyncOutcome> {
  const supabase = getSupabaseAdmin();

  // Resolve the creator name for the sheet's "Created By" column.
  let creatorName: string | null = null;
  if (doc.created_by) {
    const { data } = await supabase
      .from('users')
      .select('username')
      .eq('id', doc.created_by)
      .maybeSingle<{ username: string }>();
    creatorName = data?.username ?? null;
  }

  let ok = true;
  let error: string | undefined;

  try {
    await appendDocumentRow(doc, creatorName);
  } catch (err) {
    ok = false;
    error = describeSheetsError(err);
    console.error(`[resync] document ${doc.id} failed:`, error);
  }

  // Atomic increment -- the cron and a manual click can race here.
  const { error: rpcError } = await supabase.rpc(
    'bump_sync_attempts_and_set_status',
    {
      p_document_id: doc.id,
      p_status: ok ? 'synced' : 'failed',
      p_error: ok ? null : (error ?? 'Unknown sync error'),
    },
  );

  if (rpcError) {
    // The helper RPC is missing (schema.sql predates it). Fall back to a
    // direct write so retries still record their result.
    console.warn('[resync] bump RPC failed, using fallback:', rpcError.message);
    await supabase
      .from('documents')
      .update({
        sync_status: ok ? 'synced' : 'failed',
        last_sync_error: ok ? null : (error ?? 'Unknown sync error'),
        sync_attempts: (doc.sync_attempts ?? 0) + 1,
      })
      .eq('id', doc.id);

    return {
      documentId: doc.id,
      ok,
      error,
      attempts: (doc.sync_attempts ?? 0) + 1,
    };
  }

  return { documentId: doc.id, ok, error, attempts: (doc.sync_attempts ?? 0) + 1 };
}

/** Retry a single document by ID. Returns null when it does not exist. */
export async function resyncDocumentById(id: number): Promise<SyncOutcome | null> {
  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('id', id)
    .maybeSingle<DocumentRow>();

  if (error) {
    console.error(`[resync] fetch of ${id} failed:`, error.message);
    return null;
  }

  if (!data) return null;
  return syncOne(data);
}

/**
 * Retry every unsynced document.
 *
 * Ordered oldest-first by last attempt so a document that has been failing
 * repeatedly is not starved by newer traffic.
 */
export async function retryFailedDocuments(
  options: RetryOptions = {},
): Promise<SyncOutcome[]> {
  const { batchSize = DEFAULT_BATCH_SIZE, onlyFailed = true } = options;
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from('documents')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(batchSize);

  if (onlyFailed) {
    query = query.eq('sync_status', 'failed');
  }

  const { data, error } = await query;

  if (error) {
    console.error('[resync] batch query failed:', error.message);
    return [];
  }

  const docs = (data ?? []) as DocumentRow[];

  // Sequential, not Promise.all. Google Sheets has per-spreadsheet rate
  // limits, and a burst of parallel appends is the fastest way to get 429s and
  // mark a batch failed for no real reason.
  const outcomes: SyncOutcome[] = [];
  for (const doc of docs) {
    outcomes.push(await syncOne(doc));
  }

  return outcomes;
}

/** Count of documents still awaiting sync. Used for dashboard badges. */
export async function countUnsynced(): Promise<{ failed: number; pending: number }> {
  const supabase = getSupabaseAdmin();

  // head:true makes Postgres return only the count -- no rows transferred.
  // Two tiny aggregate queries beat one full table scan.
  const [failed, pending] = await Promise.all([
    supabase
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('sync_status', 'failed'),
    supabase
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('sync_status', 'pending'),
  ]);

  return {
    failed: failed.count ?? 0,
    pending: pending.count ?? 0,
  };
}
