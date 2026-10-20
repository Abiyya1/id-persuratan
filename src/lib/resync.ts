import { getSupabaseAdmin, type DocumentRow } from '@/lib/supabase';
import { syncDocumentRow, syncRegisterMonth, describeSheetsError, sheetsUserMessage } from '@/lib/google-sheets';

export interface SyncOutcome {
  documentId: number;
  ok: boolean;
  error?: string;
  code?: 'LEGACY_READ_ONLY';
  attempts: number;
  statusPersisted: boolean;
  document?: DocumentRow;
}

export interface RetryOptions {
  /** Limit how many unsynced rows one pass touches. */
  batchSize?: number;
  /** Omit only for administrator/cron operations. */
  createdBy?: string;
}

const DEFAULT_BATCH_SIZE = 25;

/** Synchronize the saved version, then persist the result without overwriting a newer edit. */
export async function syncDocument(doc: DocumentRow): Promise<SyncOutcome> {
  if (!doc.letter_date) {
    return {
      documentId: doc.id,
      ok: false,
      code: 'LEGACY_READ_ONLY',
      error: 'Arsip lama berada di luar register bulanan dan tidak dapat disinkronkan ulang.',
      attempts: doc.sync_attempts,
      statusPersisted: false,
    };
  }
  const supabase = getSupabaseAdmin();
  let ok = true;
  let error: string | undefined;
  let persistedDocument: DocumentRow;
  try {
    await syncDocumentRow(doc);
  } catch (err) {
    ok = false;
    error = sheetsUserMessage(err);
    console.error(`[resync] document ${doc.id} failed:`, describeSheetsError(err));
  }

  try {
    const { data, error: rpcError } = await supabase.rpc('bump_sync_attempts_and_set_status', {
      p_document_id: doc.id,
      p_status: ok ? 'synced' : 'failed',
      p_error: ok ? null : (error ?? 'Sinkronisasi gagal tanpa rincian kesalahan.'),
      p_expected_updated_at: doc.updated_at,
    });
    if (rpcError) {
      console.error('[resync] status persistence failed:', rpcError.message);
      throw new Error('Tidak dapat menyimpan status sinkronisasi.');
    }
    if (!data) throw new Error('Surat berubah saat sinkronisasi berlangsung; versi terbaru tetap dalam antrean.');
    persistedDocument = data as DocumentRow;
    if (persistedDocument.id !== doc.id || typeof persistedDocument.sync_attempts !== 'number') {
      throw new Error('Hasil penyimpanan status sinkronisasi tidak valid.');
    }
  } catch (err) {
    const persistenceError = err instanceof Error ? err.message : 'Tidak dapat menyimpan status sinkronisasi.';
    console.error(`[resync] status for document ${doc.id} failed:`, persistenceError);
    return {
      documentId: doc.id,
      ok: false,
      error: error ? `${error} ${persistenceError}` : persistenceError,
      attempts: doc.sync_attempts,
      statusPersisted: false,
    };
  }
  return {
    documentId: doc.id,
    ok,
    error,
    attempts: persistedDocument.sync_attempts,
    statusPersisted: true,
    document: persistedDocument,
  };
}

/** Private numeric addressing is distinct from the official string number. */
export async function resyncDocumentById(id: number, createdBy?: string): Promise<SyncOutcome | null> {
  let query = getSupabaseAdmin().from('documents').select('*').eq('id', id);
  if (createdBy) query = query.eq('created_by', createdBy);
  const { data, error } = await query.maybeSingle<DocumentRow>();
  if (error) {
    console.error('[resync] document query failed:', error.message);
    throw new Error('Tidak dapat memuat surat untuk sinkronisasi.');
  }
  if (!data) return null;
  return syncDocument(data);
}

/** Retry both pending creates/edits and failed synchronization attempts. */
export async function retryFailedDocuments(options: RetryOptions = {}): Promise<SyncOutcome[]> {
  const { batchSize = DEFAULT_BATCH_SIZE, createdBy } = options;
  let query = getSupabaseAdmin().from('documents').select('*')
    .not('letter_date', 'is', null).in('sync_status', ['pending', 'failed']);
  if (createdBy) query = query.eq('created_by', createdBy);
  const { data, error } = await query.order('updated_at', { ascending: true }).limit(batchSize);
  if (error) {
    console.error('[resync] queue query failed:', error.message);
    throw new Error('Tidak dapat memuat antrean sinkronisasi.');
  }

  // Sequential projection respects the per-spreadsheet quota and the Sheets lease.
  const outcomes: SyncOutcome[] = [];
  for (const doc of (data ?? []) as DocumentRow[]) {
    outcomes.push(await syncDocument(doc));
  }
  return outcomes;
}

/** Retry deleted letters through the same month writer, including months with no documents left. */
export async function retryPendingDeletions(createdBy?: string): Promise<{ month: number; ok: boolean; error?: string }[]> {
  const months = new Set<number>();
  for (let offset = 0; ; offset += 1000) {
    let query = getSupabaseAdmin().from('letter_slots').select('letter_date')
      .eq('release_pending', true).order('number');
    if (createdBy) query = query.eq('release_requested_by', createdBy);
    const { data, error } = await query.range(offset, offset + 999);
    if (error) {
      console.error('[resync] deletion queue failed:', error.message);
      throw new Error('Tidak dapat memuat antrean penghapusan surat.');
    }
    for (const slot of data ?? []) months.add(Number(slot.letter_date.slice(5, 7)));
    if ((data?.length ?? 0) < 1000) break;
  }
  const outcomes: { month: number; ok: boolean; error?: string }[] = [];
  for (const month of [...months].sort((a, b) => a - b)) {
    try {
      await syncRegisterMonth(month);
      outcomes.push({ month, ok: true });
    } catch (err) {
      const error = sheetsUserMessage(err);
      console.error(`[resync] pending deletion month ${month} failed:`, describeSheetsError(err));
      outcomes.push({ month, ok: false, error });
    }
  }
  return outcomes;
}

/** All queue counts are scoped to the actor; cron/admin omit createdBy. */
export async function countUnsynced(createdBy?: string): Promise<{ failed: number; pending: number; deleting: number }> {
  const supabase = getSupabaseAdmin();
  let failedQuery = supabase.from('documents').select('id', { count: 'exact', head: true })
    .not('letter_date', 'is', null).eq('sync_status', 'failed');
  let pendingQuery = supabase.from('documents').select('id', { count: 'exact', head: true })
    .not('letter_date', 'is', null).eq('sync_status', 'pending');
  let deletingQuery = supabase.from('letter_slots').select('number', { count: 'exact', head: true })
    .eq('release_pending', true);
  if (createdBy) {
    failedQuery = failedQuery.eq('created_by', createdBy);
    pendingQuery = pendingQuery.eq('created_by', createdBy);
    deletingQuery = deletingQuery.eq('release_requested_by', createdBy);
  }
  const [failed, pending, deleting] = await Promise.all([failedQuery, pendingQuery, deletingQuery]);
  if (failed.error || pending.error || deleting.error) {
    console.error('[resync] queue count failed:', failed.error?.message ?? pending.error?.message ?? deleting.error?.message);
    throw new Error('Tidak dapat menghitung antrean sinkronisasi.');
  }
  return { failed: failed.count ?? 0, pending: pending.count ?? 0, deleting: deleting.count ?? 0 };
}
