import { getSupabaseAdmin, type DocumentRow } from '@/lib/supabase';
import { requireUser, jsonError, handleRoute } from '@/lib/auth';
import { writeAudit, AuditAction } from '@/lib/audit';
import { appendDocumentRow, describeSheetsError } from '@/lib/google-sheets';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TITLE_LENGTH = 300;
const MAX_METADATA_KEYS = 40;

/**
 * Create a document with an atomically generated ID, then attempt an immediate
 * Google Sheets append.
 *
 * Ordering matters: the database write happens FIRST and is never rolled back
 * by a Sheets failure. A Google outage must cost you a sync, not a document.
 * The row lands as 'pending', the append is attempted, and the status is then
 * corrected to 'synced' or 'failed'. Either way the document exists and the
 * cron job can retry the failed ones.
 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const user = await requireUser();

    const body = await readBody(req);
    if (!body) return jsonError('Invalid request body.', 400);

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return jsonError('Title is required.', 400);
    if (title.length > MAX_TITLE_LENGTH) {
      return jsonError(`Title must be under ${MAX_TITLE_LENGTH} characters.`, 400);
    }

    const metadata = sanitiseMetadata(body.metadata);

    const supabase = getSupabaseAdmin();

    // ---- 1. Reserve the ID -------------------------------------------------
    // get_next_document_id() takes a row lock on id_counter, so concurrent
    // callers serialize and cannot receive the same number.
    const { data: rawId, error: idError } = await supabase.rpc('get_next_document_id');

    if (idError || typeof rawId !== 'number') {
      console.error('[documents/generate] ID reservation failed:', idError?.message);
      return jsonError('Could not allocate a document ID. Try again.', 500);
    }

    const documentId = rawId;

    // ---- 2. Persist --------------------------------------------------------
    // A collision here is impossible given the lock above, but a PK violation
    // is still handled rather than surfacing as an unhandled 500.
    const { data: doc, error: insertError } = await supabase
      .from('documents')
      .insert({
        id: documentId,
        title,
        metadata,
        created_by: user.id,
        sync_status: 'pending',
        sync_attempts: 0,
      })
      .select('*')
      .single<DocumentRow>();

    if (insertError) {
      console.error(
        `[documents/generate] insert failed for id ${documentId}:`,
        insertError.message,
      );
      return jsonError('Could not save the document. Try again.', 500);
    }

    // ---- 3. Audit ----------------------------------------------------------
    await writeAudit({
      userId: user.id,
      action: AuditAction.CREATE_DOC,
      targetId: documentId,
      details: { title, metadata },
    });

    // ---- 4. Attempt the Sheets append --------------------------------------
    // Failures are caught and recorded, never rethrown. The user's document
    // is already safe in Postgres.
    let syncStatus: 'synced' | 'failed' = 'failed';
    let syncError: string | null = null;

    try {
      await appendDocumentRow(doc, user.username);
      syncStatus = 'synced';
    } catch (err) {
      syncError = describeSheetsError(err);
      console.error(`[documents/generate] Sheets append failed for id ${documentId}:`, syncError);
    }

    const { error: statusError } = await supabase
      .from('documents')
      .update({
        sync_status: syncStatus,
        sync_attempts: 1,
        last_sync_error: syncStatus === 'synced' ? null : syncError,
      })
      .eq('id', documentId);

    if (statusError) {
      // The document is saved either way; the cron job will pick it up because
      // it is still 'pending'.
      console.error(
        `[documents/generate] status update failed for id ${documentId}:`,
        statusError.message,
      );
    }

    return Response.json(
      {
        document: {
          id: documentId,
          title: doc.title,
          metadata: doc.metadata,
          created_at: doc.created_at,
          sync_status: syncStatus,
        },
        // Distinct messages: the user should know whether to expect their row
        // in the sheet now or after the next retry.
        message:
          syncStatus === 'synced'
            ? `Document ${documentId} created and synced to Google Sheets.`
            : `Document ${documentId} created, but the Google Sheets sync failed. ` +
              'It is queued for automatic retry every 5 minutes.',
        syncWarning: syncStatus === 'failed' ? syncError : null,
      },
      { status: 201 },
    );
  });
}

/**
 * Validate free-form metadata.
 *
 * Metadata lands in a JSONB column, a spreadsheet cell and a CSV export, so it
 * must not be able to be enormous, deeply nested, or carry non-string keys.
 */
function sanitiseMetadata(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};

  const entries = Object.entries(input as Record<string, unknown>).slice(0, MAX_METADATA_KEYS);
  const result: Record<string, unknown> = {};

  for (const [key, value] of entries) {
    const cleanKey = String(key).slice(0, 100);
    if (!cleanKey) continue;

    // Allow only primitives and one level of array, flattened to a string.
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      result[cleanKey] = value;
    } else if (Array.isArray(value)) {
      result[cleanKey] = value.slice(0, 50).map((v) => String(v).slice(0, 500));
    } else {
      result[cleanKey] = JSON.stringify(value).slice(0, 2000);
    }
  }

  return result;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const length = Number(req.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) return null;

  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
