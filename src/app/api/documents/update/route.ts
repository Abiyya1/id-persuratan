import { getSupabaseAdmin, type DocumentRow } from '@/lib/supabase';
import { requireAdmin, jsonError, handleRoute } from '@/lib/auth';
import { writeAudit, AuditAction } from '@/lib/audit';
import { appendIdChangeRow, appendDocumentRow, describeSheetsError } from '@/lib/google-sheets';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_TITLE_LENGTH = 300;

/**
 * Admin edit of a document's title, metadata, or ID.
 *
 * Two paths depending on what changed:
 *   - title/metadata only -> row stays 'synced'; the Sheets row is left alone
 *     (it is an append-only log, see the ID-change note below).
 *   - ID changed          -> marked 'pending' and re-queued, and an explicit
 *     ID-correction row is appended to the sheet.
 */
export async function PATCH(req: Request) {
  return handleRoute(async () => {
    const admin = await requireAdmin();

    const body = await readBody(req);
    if (!body) return jsonError('Invalid request body.', 400);

    const documentId = Number(body.id);
    if (!Number.isInteger(documentId) || documentId <= 0) {
      return jsonError('A valid document id is required.', 400);
    }

    const supabase = getSupabaseAdmin();

    const { data: existing, error: fetchError } = await supabase
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .maybeSingle<DocumentRow>();

    if (fetchError) {
      console.error('[documents/update] fetch failed:', fetchError.message);
      return jsonError('Could not load the document.', 500);
    }

    if (!existing) return jsonError('Document not found.', 404);

    // ---- Build the patch ----------------------------------------------------
    const patch: Record<string, unknown> = {};

    if (typeof body.title === 'string') {
      const title = body.title.trim();
      if (!title) return jsonError('Title cannot be empty.', 400);
      if (title.length > MAX_TITLE_LENGTH) {
        return jsonError(`Title must be under ${MAX_TITLE_LENGTH} characters.`, 400);
      }
      patch.title = title;
    }

    if (body.metadata !== undefined) {
      patch.metadata = sanitiseMetadata(body.metadata);
    }

    // ---- ID change ----------------------------------------------------------
    let idChanged = false;
    let newId = documentId;

    if (body.id !== undefined && Number(body.id) !== documentId) {
      const candidate = Number(body.id);

      if (!Number.isInteger(candidate) || candidate <= 0) {
        return jsonError('Document id must be a positive integer.', 400);
      }

      // Never let an edit collide with the counter's high-water mark, or the
      // next generated ID would overwrite this row.
      const { data: counter } = await supabase
        .from('id_counter')
        .select('current_val')
        .eq('id', 1)
        .maybeSingle<{ current_val: number }>();

      if (counter && candidate <= counter.current_val) {
        return jsonError(
          `ID must be greater than ${counter.current_val}. That range has already been issued.`,
          409,
        );
      }

      const { data: clash } = await supabase
        .from('documents')
        .select('id')
        .eq('id', candidate)
        .maybeSingle<{ id: number }>();

      if (clash) return jsonError(`ID ${candidate} is already in use.`, 409);

      newId = candidate;
      idChanged = true;

      // Re-queue: the sheet holds the old ID, so this document is out of sync
      // by definition until the correction row lands.
      patch.sync_status = 'pending';
      patch.last_sync_error = null;
    }

    if (Object.keys(patch).length === 0) {
      return jsonError('Nothing to update.', 400);
    }

    // ---- Apply --------------------------------------------------------------
    if (idChanged) {
      // Re-keying a primary key is a delete + insert, not an UPDATE.
      const { error: deleteError } = await supabase
        .from('documents')
        .delete()
        .eq('id', documentId);

      if (deleteError) {
        console.error('[documents/update] old row delete failed:', deleteError.message);
        return jsonError('Could not change the document ID.', 500);
      }

      const { data: reinserted, error: insertError } = await supabase
        .from('documents')
        .insert({
          ...existing,
          ...patch,
          id: newId,
        })
        .select('*')
        .single<DocumentRow>();

      if (insertError) {
        console.error('[documents/update] re-insert failed:', insertError.message);

        // Roll the delete back so the document is not lost from the table.
        await supabase.from('documents').insert(existing);
        return jsonError('Could not change the document ID. No changes were made.', 500);
      }

      await writeAudit({
        userId: admin.id,
        action: AuditAction.EDIT_ID,
        targetId: newId,
        details: { from: documentId, to: newId, changedBy: admin.username },
      });

      // ---- Re-sync after the ID change ---------------------------------------
      let syncStatus: 'synced' | 'failed' = 'failed';
      let syncError: string | null = null;

      try {
        await appendIdChangeRow(reinserted, admin.username, documentId, admin.username);
        syncStatus = 'synced';
      } catch (err) {
        syncError = describeSheetsError(err);
        console.error(`[documents/update] ID-change sync failed for ${newId}:`, syncError);
      }

      await supabase
        .from('documents')
        .update({
          sync_status: syncStatus,
          last_sync_error: syncStatus === 'synced' ? null : syncError,
        })
        .eq('id', newId);

      return Response.json({
        message: `Document ID changed from ${documentId} to ${newId}.`,
        document: reinserted,
        syncWarning: syncStatus === 'failed' ? syncError : null,
      });
    }

    // ---- Plain metadata / title edit ----------------------------------------
    const { data: updated, error: updateError } = await supabase
      .from('documents')
      .update(patch)
      .eq('id', documentId)
      .select('*')
      .single<DocumentRow>();

    if (updateError) {
      console.error('[documents/update] update failed:', updateError.message);
      return jsonError('Could not update the document.', 500);
    }

    await writeAudit({
      userId: admin.id,
      action: AuditAction.EDIT_DOC,
      targetId: documentId,
      details: {
        changedFields: Object.keys(patch),
        before: { title: existing.title, metadata: existing.metadata },
        after: { title: updated.title, metadata: updated.metadata },
      },
    });

    // A metadata edit leaves the appended sheet row stale. Re-append so the
    // sheet reflects current state, then report whether that worked.
    let syncWarning: string | null = null;

    if (updated.sync_status === 'synced') {
      try {
        await appendDocumentRow(updated, null);
      } catch (err) {
        syncWarning = describeSheetsError(err);
        // Not fatal: Postgres is the source of truth and the document is
        // already correct there. Do not flip a synced row to failed for a
        // cosmetic re-append.
        console.error(`[documents/update] re-append failed for ${documentId}:`, syncWarning);
      }
    }

    return Response.json({
      message: `Document ${documentId} updated.`,
      document: updated,
      syncWarning,
    });
  });
}

function sanitiseMetadata(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};

  const entries = Object.entries(input as Record<string, unknown>).slice(0, 40);
  const result: Record<string, unknown> = {};

  for (const [key, value] of entries) {
    const cleanKey = String(key).slice(0, 100);
    if (!cleanKey) continue;

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
