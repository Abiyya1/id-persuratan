import { google, sheets_v4 } from 'googleapis';
import type { DocumentRow, UserRow } from './supabase';

// ---------------------------------------------------------------------------
// Google Sheets client (Service Account auth -- no user login involved)
// ---------------------------------------------------------------------------

// The OAuth2 client is stateless and expensive to construct (it parses a key
// and buffers it), so we cache it on the module. On Vercel a warm lambda
// reuses it across invocations.
let cachedClient: sheets_v4.Sheets | null = null;

/** How long a single Sheets call may take before we call it a failure. */
const SHEETS_TIMEOUT_MS = 8_000;

/**
 * Environment variables this module needs. Collected up front so a
 * misconfigured deploy fails with one clear message instead of a stack trace
 * from deep inside googleapis.
 */
function sheetsConfig() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  const sheetId = process.env.GOOGLE_SHEET_ID;

  const missing = [
    !email && 'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    !rawKey && 'GOOGLE_PRIVATE_KEY',
    !sheetId && 'GOOGLE_SHEET_ID',
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `Missing Google Sheets env vars: ${missing.join(', ')}. ` +
        'See .env.example.',
    );
  }

  // A .env file cannot hold literal newlines, so the PEM arrives with the
  // two-character sequence \n. Vercel's env UI mangles real newlines the
  // same way. Un-escape here, once, at the boundary.
  //
  // If the key somehow DOES contain real newlines (set via a secret manager
  // that preserves them), this replace is a no-op and nothing breaks.
  const privateKey = (rawKey as string).replace(/\\n/g, '\n');

  return {
    email: email as string,
    privateKey,
    sheetId: sheetId as string,
    sheetName: process.env.GOOGLE_SHEET_NAME || 'Sheet1',
  };
}

function getSheets(): sheets_v4.Sheets {
  if (cachedClient) return cachedClient;

  const { email, privateKey } = sheetsConfig();

  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  cachedClient = google.sheets({ version: 'v4', auth });
  return cachedClient;
}

/** AOT: every append is wrapped in this so a hung request cannot hang a route. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Google Sheets request timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Turn googleapis' nested error shape into one readable line for the DB. */
export function describeSheetsError(err: unknown): string {
  if (typeof err === 'string') return err.slice(0, 500);
  if (err instanceof Error) return err.message.slice(0, 500);

  if (err && typeof err === 'object') {
    const e = err as {
      message?: string;
      code?: number | string;
      errors?: Array<{ message?: string }>;
      response?: { data?: { error?: { message?: string; status?: string } } };
    };

    const apiMessage =
      e.response?.data?.error?.message ?? e.errors?.[0]?.message ?? e.message;

    if (apiMessage) {
      const code = e.response?.data?.error?.status ?? e.code;
      return code ? `${code}: ${apiMessage}`.slice(0, 500) : apiMessage.slice(0, 500);
    }
  }

  return 'Unknown Google Sheets error';
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/** Header row written by ensureHeaderRow(). Column order must not change. */
export const SHEET_HEADERS = [
  'Document ID',
  'Title',
  'Created By',
  'Created At',
  'Sync Timestamp',
  'Metadata (JSON)',
] as const;

/** Flatten metadata JSON into a single readable cell. */
function stringifyMetadata(metadata: Record<string, unknown> | null): string {
  if (!metadata || Object.keys(metadata).length === 0) return '';
  try {
    return JSON.stringify(metadata);
  } catch {
    return '[unserializable metadata]';
  }
}

/** Format an ISO timestamp as something readable in a spreadsheet. */
function formatTimestamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Sheet locale is ambiguous, so use an unambiguous sortable form.
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function buildRow(doc: DocumentRow, creatorName: string | null): (string | number)[] {
  return [
    doc.id,
    doc.title,
    creatorName ?? (doc.created_by ? doc.created_by.slice(0, 8) : 'unknown'),
    formatTimestamp(doc.created_at),
    formatTimestamp(new Date().toISOString()),
    stringifyMetadata(doc.metadata),
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the target sheet exists and has a header row.
 *
 * Called on demand rather than at startup: a Vercel function may never run
 * before the first append, and a fresh Google Sheet is completely empty.
 * Idempotent -- it reads the first row and only writes when nothing is there.
 */
export async function ensureHeaderRow(): Promise<void> {
  const sheets = getSheets();
  const { sheetId, sheetName } = sheetsConfig();
  const range = `'${sheetName}'!A1`;

  const existing = await withTimeout(
    sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range }),
    SHEETS_TIMEOUT_MS,
  );

  const firstRow = existing.data.values?.[0];
  const hasHeader =
    Array.isArray(firstRow) && String(firstRow[0] ?? '').trim() === SHEET_HEADERS[0];

  if (hasHeader) return;

  await withTimeout(
    sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [[...SHEET_HEADERS]] },
    }),
    SHEETS_TIMEOUT_MS,
  );
}

/**
 * Append one document as a new row.
 *
 * Resolves on success, REJECTS on any failure -- callers decide how to handle
 * it (writeAudit.recordSyncResult + a 'failed' status) rather than swallowing
 * the error here.
 *
 * `creatorName` is passed in rather than looked up so this function does not
 * need a database round trip on the hot path.
 */
export async function appendDocumentRow(
  doc: DocumentRow,
  creatorName: string | null,
): Promise<void> {
  const sheets = getSheets();
  const { sheetId, sheetName } = sheetsConfig();

  await ensureHeaderRow();

  await withTimeout(
    sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'${sheetName}'!A:F`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [buildRow(doc, creatorName)] },
    }),
    SHEETS_TIMEOUT_MS,
  );
}

/** Human-readable username for a document's creator. */
export async function fetchCreatorName(userId: string | null): Promise<string | null> {
  if (!userId) return null;

  const { getSupabaseAdmin } = await import('./supabase');
  const { data } = await getSupabaseAdmin()
    .from('users')
    .select('username')
    .eq('id', userId)
    .maybeSingle<UserPick>();

  return (data as { username: string } | null)?.username ?? null;
}

type UserPick = { username: string };

/**
 * Append a row describing an ID change.
 *
 * Editing a document's ID after it is already in the sheet cannot rewrite
 * history safely (the old row would need deleting, and row positions shift),
 * so we append an audit-style correction row instead.
 */
export async function appendIdChangeRow(
  doc: DocumentRow,
  creatorName: string | null,
  oldId: number,
  changedBy: string | null,
): Promise<void> {
  const sheets = getSheets();
  const { sheetId, sheetName } = sheetsConfig();

  await ensureHeaderRow();

  const note = `ID CORRECTION: ${oldId} -> ${doc.id} by ${changedBy ?? 'admin'}`;

  await withTimeout(
    sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'${sheetName}'!A:F`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [
          [
            doc.id,
            `${doc.title}  (${note})`,
            creatorName ?? 'unknown',
            formatTimestamp(doc.created_at),
            formatTimestamp(new Date().toISOString()),
            stringifyMetadata(doc.metadata),
          ],
        ],
      },
    }),
    SHEETS_TIMEOUT_MS,
  );
}

/** Exported for the admin health check. Never throws. */
export async function checkSheetsConfig(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { sheetId, sheetName } = sheetsConfig();
    return { ok: true, detail: `Configured for sheet ${sheetId} / "${sheetName}"` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export type { UserRow };
