import { randomUUID } from 'node:crypto';
import { google, sheets_v4 } from 'googleapis';
import { getSupabaseAdmin, type DocumentRow } from './supabase';
import { REGISTER_MONTHS, REGISTER_YEAR, buildRegisterProjection, normalizeRegisterNumber, registerNumberCellFormat, parseClassifications, parseRegisterHeading, parseRegisterHeadingRow, parseRegisterRows, type ImportedRegisterRow, type RegisterDay, type RegisterDocument, type RegisterSlot, type RegisterCell } from './register-sheet';
import { buildRegisterFillRequests, parseSheetRegister, type SheetRegisterMonth } from './sheet-register';

let cachedClient: sheets_v4.Sheets | null = null;
const REQUEST_OPTIONS = { timeout: 8_000, retry: false } as const;
// Outlive Google's 180-second processing limit after an uncertain client timeout.
const LEASE_SECONDS = 240;
// ponytail: cache is per process; use a shared cache only if multi-instance Google traffic needs it.
const sheetRegisterCache = new Map<number, { expiresAt: number; revision: string | null; promise: Promise<SheetRegisterMonth> }>();

function sheetsConfig() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const missing = [!email && 'GOOGLE_SERVICE_ACCOUNT_EMAIL', !rawKey && 'GOOGLE_PRIVATE_KEY', !sheetId && 'GOOGLE_SHEET_ID'].filter(Boolean);
  if (missing.length) throw new Error(`Konfigurasi Google Sheets belum lengkap: ${missing.join(', ')}. Lihat pengaturan lingkungan di README.`);
  return { email: email as string, privateKey: (rawKey as string).replace(/\\n/g, '\n'), sheetId: sheetId as string };
}

function getSheets(): sheets_v4.Sheets {
  if (!cachedClient) {
    const { email, privateKey } = sheetsConfig();
    cachedClient = google.sheets({ version: 'v4', auth: new google.auth.JWT({ email, key: privateKey, scopes: ['https://www.googleapis.com/auth/spreadsheets'] }) });
  }
  return cachedClient;
}

export function describeSheetsError(err: unknown): string {
  if (typeof err === 'string') return err.slice(0, 500);
  if (err && typeof err === 'object') {
    const e = err as { message?: string; code?: number | string; errors?: Array<{ message?: string }>; response?: { data?: { error?: { message?: string; status?: string } } } };
    const message = e.response?.data?.error?.message ?? e.errors?.[0]?.message ?? e.message;
    if (message) { const code = e.response?.data?.error?.status ?? e.code; return (code ? `${code}: ${message}` : message).slice(0, 500); }
  }
  return 'Kesalahan Google Sheets tidak diketahui.';
}

/** External provider diagnostics stay in server logs, not end-user responses. */
export function sheetsUserMessage(err: unknown): string {
  const detail = describeSheetsError(err);
  let code: unknown;
  if (err && typeof err === 'object') {
    if ('code' in err) code = err.code;
    if ('response' in err && err.response && typeof err.response === 'object' && 'status' in err.response) code = err.response.status ?? code;
  }
  if (code === 401 || /UNAUTHENTICATED|invalid_grant|invalid credentials|invalid.*jwt|unauthorized/i.test(detail)) return 'Autentikasi Google Sheets gagal. Periksa kredensial akun layanan.';
  if (code === 403 || /PERMISSION_DENIED|forbidden|permission|access denied/i.test(detail)) return 'Akses Google Sheets ditolak. Pastikan lembar kerja dibagikan kepada akun layanan.';
  if (code === 404 || /NOT_FOUND|not found/i.test(detail)) return 'Lembar kerja Google Sheets tidak ditemukan. Periksa ID lembar kerja.';
  if (code === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(detail)) return 'Batas permintaan Google Sheets tercapai. Silakan coba lagi nanti.';
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || /timeout|timed out|socket hang up/i.test(detail)) return 'Koneksi Google Sheets terputus atau melewati batas waktu. Silakan coba lagi.';
  if (typeof code === 'number' && code >= 500 || /UNAVAILABLE|INTERNAL|backend error/i.test(detail)) return 'Layanan Google Sheets sedang bermasalah. Silakan coba lagi nanti.';
  if (err instanceof Error && !('response' in err) && !('errors' in err) && !('code' in err) && /^(Konfigurasi|Bulan|Nomor|Tanggal|Judul|Klasifikasi|Uraian|Dokumen|Slot|Register|Templat|Target|Sinkronisasi|Penulis|Hanya|Catatan)/.test(err.message)) return err.message.slice(0, 500);
  return 'Google Sheets belum dapat diproses. Silakan coba lagi.';
}

function quoteSheet(name: string) { return `'${name.replace(/'/g, "''")}'`; }

export async function fetchClassifications(): Promise<{ code: string; description: string }[]> {
  const response = await getSheets().spreadsheets.values.get({ spreadsheetId: sheetsConfig().sheetId, range: "'Acuan No Surat'!A:E", valueRenderOption: 'FORMATTED_VALUE' }, REQUEST_OPTIONS);
  return parseClassifications(response.data.values ?? []);
}

async function sheetReadRevision(month: number): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin().from('register_state').select('initialized').eq('id', 1).maybeSingle<{ initialized: boolean }>();
  if (error || !data) throw new Error('Register surat belum tersedia. Periksa migrasi Supabase.');
  if (!data.initialized) return null;
  const { days } = await loadMonth(month);
  if (days.some((day) => String(day.revision) !== String(day.synced_revision))) {
    throw new Error('Register bulan ini sedang menunggu sinkronisasi Google Sheets. Muat ulang setelah antrean selesai.');
  }
  return JSON.stringify(days.map((day) => [day.letter_date, String(day.revision)]));
}

export async function readSheetRegisterMonth(month: number): Promise<SheetRegisterMonth> {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('Bulan register tidak valid.');
  const revision = await sheetReadRevision(month);
  const cached = sheetRegisterCache.get(month);
  if (cached && cached.expiresAt > Date.now() && cached.revision === revision) {
    const register = await cached.promise;
    if (await sheetReadRevision(month) !== revision) throw new Error('Register berubah saat dibaca. Muat ulang untuk melihat nomor terbaru.');
    return register;
  }

  const promise: Promise<SheetRegisterMonth> = (async () => {
    const sheets = getSheets();
    const spreadsheetId = sheetsConfig().sheetId;
    const title = REGISTER_MONTHS[month - 1];
    let spreadsheet: sheets_v4.Schema$Spreadsheet;
    try {
      const response = await sheets.spreadsheets.get({
        spreadsheetId,
        ranges: [`${quoteSheet(title)}!B:M`],
        includeGridData: true,
        fields: 'properties(defaultFormat,spreadsheetTheme.themeColors),sheets(properties(title,gridProperties),merges,data(startRow,startColumn,rowMetadata.pixelSize,columnMetadata.pixelSize,rowData.values(formattedValue,effectiveValue,userEnteredValue,effectiveFormat,dataValidation)))',
      }, REQUEST_OPTIONS);
      spreadsheet = response.data;
    } catch (err) {
      if (!/Unable to parse range:/i.test(describeSheetsError(err))) throw err;
      const metadata = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' }, REQUEST_OPTIONS);
      const titles = metadata.data.sheets?.map((sheet) => sheet.properties?.title);
      if (!titles || titles.some((name) => typeof name !== 'string') || titles.includes(title)) throw err;
      spreadsheet = metadata.data;
    }
    if (await sheetReadRevision(month) !== revision) throw new Error('Register berubah saat dibaca. Muat ulang untuk melihat nomor terbaru.');
    const register = parseSheetRegister(spreadsheet, month);
    register.fetchedAt = new Date().toISOString();
    return register;
  })().then((register) => {
    const entry = sheetRegisterCache.get(month);
    if (entry?.promise === promise) entry.expiresAt = Date.now() + 10_000;
    return register;
  }).catch((err) => {
    if (sheetRegisterCache.get(month)?.promise === promise) sheetRegisterCache.delete(month);
    throw err;
  });
  sheetRegisterCache.set(month, { expiresAt: Infinity, revision, promise });
  return promise;
}

export async function readExistingRegister(): Promise<ImportedRegisterRow[]> {
  const sheets = getSheets();
  const spreadsheetId = sheetsConfig().sheetId;
  const metadata = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' }, REQUEST_OPTIONS);
  const result: ImportedRegisterRow[] = [];
  const numbers = new Set<string>();
  for (let month = 1; month <= 12; month++) {
    const name = REGISTER_MONTHS[month - 1];
    if (!metadata.data.sheets?.some((sheet) => sheet.properties?.title === name)) continue;
    // Keep Boolean checkboxes/raw cells while requesting date-formatted headings.
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${quoteSheet(name)}!B:M`, valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' }, REQUEST_OPTIONS);
    for (const row of parseRegisterRows(response.data.values ?? [], month)) {
      if (numbers.has(row.number)) throw new Error(`Nomor surat ${row.number} muncul pada lebih dari satu register bulanan.`);
      numbers.add(row.number);
      result.push(row);
    }
  }
  return result;
}

function cellValue(value: RegisterCell): sheets_v4.Schema$ExtendedValue {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return { numberValue: value };
  return { stringValue: String(value ?? '') };
}

async function loadMonth(month: number): Promise<{ days: RegisterDay[]; slots: RegisterSlot[]; documents: RegisterDocument[] }> {
  // One MVCC snapshot; separate offset queries can skip slots during concurrent inserts.
  const { data, error } = await getSupabaseAdmin().rpc('get_register_month', { p_month: month });
  if (error) throw new Error(error.message);
  if (!data || !Array.isArray(data.days) || !Array.isArray(data.slots) || !Array.isArray(data.documents)) throw new Error('Register bulanan tidak memiliki data yang valid.');
  return data;
}

/** Two bounded atomic batches hold one lease; no row insertion/deletion can shift JULI's O:Z register. */
async function writeMonth(month: number, owner: string, markMutation: () => void) {
  const sheets = getSheets();
  const spreadsheetId = sheetsConfig().sheetId;
  const name = REGISTER_MONTHS[month - 1];
  const { days, slots, documents } = await loadMonth(month);
  if (!days.length || days.every((day) => String(day.revision) === String(day.synced_revision))) return;
  const projection = buildRegisterProjection(days, slots, documents);
  const metadata = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties,merges,conditionalFormats)' }, REQUEST_OPTIONS);
  const templateData = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: true, ranges: ["'AGUSTUS'!B:M"], fields: 'sheets(properties,merges,data(startRow,startColumn,rowData.values(userEnteredValue,userEnteredFormat,dataValidation,note,formattedValue),rowMetadata.pixelSize,columnMetadata.pixelSize))' }, REQUEST_OPTIONS);
  const template = templateData.data.sheets?.find((sheet) => sheet.properties?.title === 'AGUSTUS');
  if (!template?.properties?.sheetId && template?.properties?.sheetId !== 0) throw new Error('Templat register AGUSTUS tidak ditemukan.');
  const grid = template.data?.[0];
  const templateRows = grid?.rowData ?? [];
  const headingIndex = templateRows.findIndex((row) => parseRegisterHeadingRow((row.values ?? []).map((cell) => cell.formattedValue), 8));
  if (headingIndex < 0 || !templateRows[headingIndex + 3]) throw new Error('Templat AGUSTUS tidak memiliki tabel bertanggal dengan dua baris judul.');
  const headingColumn = templateRows[headingIndex].values!.findIndex((cell) => parseRegisterHeading(cell.formattedValue, 8) !== null);
  const preserveTemplate = name === 'AGUSTUS' && !projection.blocks.length;
  if (preserveTemplate) {
    // Retain reusable headers; the blank data-format prototype below never retains letter contents.
    const date = parseRegisterHeadingRow((templateRows[headingIndex].values ?? []).map((cell) => cell.formattedValue), 8)!;
    projection.rows.push(...templateRows.slice(headingIndex, headingIndex + 3).map((row) => Array.from({ length: 12 }, (_, column) => row.values?.[column]?.formattedValue ?? '')));
    projection.blocks.push({ date, headingRow: 0, headerRow: 1, dataRow: 3, count: 0 });
  }
  const target = metadata.data.sheets?.find((sheet) => sheet.properties?.title === name);
  const targetData = target ? name === 'AGUSTUS' ? template : (await sheets.spreadsheets.get({
    spreadsheetId, includeGridData: true, ranges: [`${quoteSheet(name)}!B:M`],
    fields: 'sheets(properties,merges,data(startRow,startColumn,rowData.values(userEnteredValue,userEnteredFormat,dataValidation,note,formattedValue),rowMetadata.pixelSize,columnMetadata.pixelSize))',
  }, REQUEST_OPTIONS)).data.sheets?.find((sheet) => sheet.properties?.title === name) : undefined;
  const targetGrid = targetData?.data?.[0];
  const targetRows = targetGrid?.rowData ?? [];
  const existingNumbers = new Map<string, number>();
  const existingHeadings = new Map<string, number>();
  targetRows.forEach((row, index) => {
    const values = (row.values ?? []).map((cell) => cell.formattedValue);
    const number = normalizeRegisterNumber(values[3]);
    if (number) existingNumbers.set(number, index);
    else {
      const date = parseRegisterHeadingRow(values, month);
      if (date) existingHeadings.set(date, index);
    }
  });
  const sourceRows = new Map<number, number>();
  const firstHeading = Math.min(...existingHeadings.values());
  const prefixCount = Number.isFinite(firstHeading) ? firstHeading + (targetGrid?.startRow ?? 0) : 0;
  if (prefixCount) {
    const prefix: RegisterCell[][] = [];
    for (let index = 0; index < prefixCount; index++) {
      const sourceIndex = index - (targetGrid?.startRow ?? 0);
      sourceRows.set(index, sourceIndex);
      prefix.push(Array.from({ length: 12 }, (_, column) => targetRows[sourceIndex]?.values?.[column]?.formattedValue ?? ''));
    }
    projection.rows.unshift(...prefix);
    for (const block of projection.blocks) {
      block.headingRow += prefixCount;
      block.headerRow += prefixCount;
      block.dataRow += prefixCount;
    }
  }
  for (const block of projection.blocks) {
    const oldHeading = existingHeadings.get(block.date);
    if (oldHeading !== undefined) for (let offset = 0; offset < 3; offset++) sourceRows.set(block.headingRow + offset, oldHeading + offset);
    for (let index = block.dataRow; index < block.dataRow + block.count; index++) {
      const sourceIndex = existingNumbers.get(normalizeRegisterNumber(projection.rows[index][3]) ?? '');
      if (sourceIndex !== undefined) sourceRows.set(index, sourceIndex);
    }
  }
  let sameLayout = sourceRows.size === projection.rows.length;
  for (const [next, previous] of sourceRows) {
    if (next !== previous + (targetGrid?.startRow ?? 0)) { sameLayout = false; break; }
  }
  const targetId = target?.properties?.sheetId ?? Math.max(0, ...(metadata.data.sheets ?? []).map((sheet) => sheet.properties?.sheetId ?? 0)) + 1;
  const oldCount = target?.properties?.gridProperties?.rowCount ?? 0;
  const rowCount = Math.max(oldCount, projection.rows.length, preserveTemplate ? prefixCount + 4 : 1);
  const tailStart = Math.max(projection.rows.length, preserveTemplate ? prefixCount + 4 : 0);
  const requests: sheets_v4.Schema$Request[] = [];
  if (!target) requests.push({ addSheet: { properties: { sheetId: targetId, title: name, gridProperties: { rowCount, columnCount: 13 } } } });
  else if (oldCount < rowCount) requests.push({ updateSheetProperties: { properties: { sheetId: targetId, gridProperties: { rowCount } }, fields: 'gridProperties.rowCount' } });
  if (target && (target.properties?.gridProperties?.columnCount ?? 0) < 13) requests.push({ updateSheetProperties: { properties: { sheetId: targetId, gridProperties: { columnCount: 13 } }, fields: 'gridProperties.columnCount' } });
  for (const merge of target?.merges ?? []) {
    if ((merge.startColumnIndex ?? 0) >= 13 || (merge.endColumnIndex ?? 0) <= 1) continue;
    if ((merge.startColumnIndex ?? 0) < 1 || (merge.endColumnIndex ?? 0) > 13) throw new Error('Target memiliki gabungan sel yang melintasi batas register B–M.');
    if (!sameLayout) requests.push({ unmergeCells: { range: { ...merge, sheetId: targetId } } });
  }
  requests.push({ updateCells: { range: { sheetId: targetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 1, endColumnIndex: 13 }, fields: 'userEnteredValue' } });
  if (tailStart < rowCount) requests.push({ updateCells: {
    range: { sheetId: targetId, startRowIndex: tailStart, endRowIndex: rowCount, startColumnIndex: 1, endColumnIndex: 13 },
    fields: 'userEnteredValue,userEnteredFormat,dataValidation,note',
  } });
  for (let column = 0; column < 12; column++) {
    const width = grid?.columnMetadata?.[column]?.pixelSize;
    if (!target && width) requests.push({ updateDimensionProperties: { range: { sheetId: targetId, dimension: 'COLUMNS', startIndex: column + 1, endIndex: column + 2 }, properties: { pixelSize: width }, fields: 'pixelSize' } });
  }
  const cells: sheets_v4.Schema$RowData[] = Array.from({ length: prefixCount }, (_, index) => ({
    values: Array.from({ length: 12 }, (_, column) => {
      const original = targetRows[sourceRows.get(index)!]?.values?.[column];
      return { userEnteredValue: original?.userEnteredValue ?? cellValue(projection.rows[index][column]) };
    }),
  }));
  const formatUpdates: sheets_v4.Schema$Request[] = [];
  if (preserveTemplate) formatUpdates.push({ updateCells: {
    start: { sheetId: targetId, rowIndex: prefixCount + 3, columnIndex: 1 },
    rows: [{ values: Array.from({ length: 12 }, (_, column) => {
      const original = templateRows[headingIndex + 3].values?.[column];
      return {
        userEnteredFormat: column === 3 ? { ...original?.userEnteredFormat, numberFormat: { type: 'TEXT' } } : original?.userEnteredFormat,
        dataValidation: original?.dataValidation,
      };
    }) }],
    fields: 'userEnteredFormat,dataValidation,note',
  } });
  for (const block of projection.blocks) {
    for (let relative = 0; relative < block.count + 3; relative++) {
      const index = block.headingRow + relative;
      const sourceIndex = headingIndex + Math.min(relative, 3);
      const oldIndex = sourceRows.get(index);
      const source = oldIndex === undefined ? templateRows[sourceIndex] : targetRows[oldIndex];
      const actualHeadingColumn = relative === 0 ? source?.values?.findIndex((cell) => parseRegisterHeading(cell.formattedValue, oldIndex === undefined ? 8 : month) !== null) ?? headingColumn : headingColumn;
      cells.push({ values: projection.rows[index].map((value, column) => {
        const original = source?.values?.[column];
        const actualValue = relative === 0
          ? column === (actualHeadingColumn >= 0 ? actualHeadingColumn : headingColumn) ? projection.rows[index][0] : original?.formattedValue ?? ''
          : relative === 1 || relative === 2 ? original?.formattedValue ?? value : value;
        return { userEnteredValue: relative < 3 && oldIndex !== undefined && original?.userEnteredValue ? original.userEnteredValue : cellValue(actualValue) };
      }) });
      if (oldIndex === undefined || oldIndex + (targetGrid?.startRow ?? 0) !== index) {
        formatUpdates.push({ updateCells: {
          start: { sheetId: targetId, rowIndex: index, columnIndex: 1 },
          rows: [{ values: projection.rows[index].map((value, column) => {
            const original = source?.values?.[column];
            return {
              userEnteredFormat: relative >= 3 && column === 3 ? registerNumberCellFormat(original?.userEnteredFormat, projection.rows[index]) : original?.userEnteredFormat,
              dataValidation: oldIndex !== undefined ? original?.dataValidation : relative >= 3 && column >= 8
                ? typeof value === 'boolean' ? (original?.dataValidation ?? { condition: { type: 'BOOLEAN' }, strict: true, showCustomUi: true }) : undefined
                : original?.dataValidation,
              note: oldIndex === undefined ? undefined : original?.note,
            };
          }) }],
          fields: 'userEnteredFormat,dataValidation,note',
        } });
      }
    }
    // JULI row heights also affect O:Z, so preserve existing heights there.
    if (!target || name !== 'JULI') {
      for (let relative = 0; relative < block.count + 3; relative++) {
        const index = block.headingRow + relative;
        const oldIndex = sourceRows.get(index);
        if (oldIndex !== undefined && oldIndex + (targetGrid?.startRow ?? 0) === index) continue;
        const height = oldIndex === undefined ? grid?.rowMetadata?.[headingIndex + Math.min(relative, 3)]?.pixelSize : targetGrid?.rowMetadata?.[oldIndex]?.pixelSize;
        if (height) requests.push({ updateDimensionProperties: { range: { sheetId: targetId, dimension: 'ROWS', startIndex: index, endIndex: index + 1 }, properties: { pixelSize: height }, fields: 'pixelSize' } });
      }
    }
    if (!existingHeadings.has(block.date)) for (const merge of template.merges ?? []) {
      if ((merge.startRowIndex ?? 0) < headingIndex || (merge.endRowIndex ?? 0) > headingIndex + 3 || (merge.startColumnIndex ?? 0) < 1 || (merge.endColumnIndex ?? 0) > 13) continue;
      requests.push({ mergeCells: { range: { ...merge, sheetId: targetId, startRowIndex: block.headingRow + (merge.startRowIndex ?? 0) - headingIndex, endRowIndex: block.headingRow + (merge.endRowIndex ?? 0) - headingIndex }, mergeType: 'MERGE_ALL' } });
    }
  }
  const projectedRows = sameLayout ? null : new Map([...sourceRows].map(([next, previous]) => [previous + (targetGrid?.startRow ?? 0), next]));
  if (projectedRows) for (const merge of target?.merges ?? []) {
    if ((merge.startColumnIndex ?? 0) < 1 || (merge.endColumnIndex ?? 0) > 13) continue;
    const top = merge.startRowIndex ?? 0;
    const bottom = merge.endRowIndex ?? 0;
    const mappedTop = projectedRows.get(top);
    const mappedBottom = projectedRows.get(bottom - 1);
    if (mappedTop !== undefined && mappedBottom !== undefined && mappedBottom - mappedTop === bottom - top - 1) {
      requests.push({ mergeCells: { range: { ...merge, sheetId: targetId, startRowIndex: mappedTop, endRowIndex: mappedBottom + 1 }, mergeType: 'MERGE_ALL' } });
    }
  }
  const rules = target?.conditionalFormats ?? [];
  const appRuleDeletes = new Set(buildRegisterFillRequests(targetId, [], rules).map((request) => request.deleteConditionalFormatRule!.index));
  // Keep native conditions on live rows and unmanaged columns, never on the retired B:M tail.
  for (let index = rules.length - 1; index >= 0; index--) {
    if (appRuleDeletes.has(index)) {
      requests.push({ deleteConditionalFormatRule: { sheetId: targetId, index } });
      continue;
    }
    let changed = false;
    const ranges: sheets_v4.Schema$GridRange[] = [];
    for (const range of rules[index].ranges ?? []) {
      const top = range.startRowIndex ?? 0;
      const bottom = range.endRowIndex ?? Infinity;
      const left = range.startColumnIndex ?? 0;
      const right = range.endColumnIndex ?? Infinity;
      if (bottom <= tailStart || right <= 1 || left >= 13) { ranges.push(range); continue; }
      changed = true;
      if (top < tailStart) ranges.push({ ...range, endRowIndex: tailStart });
      const retiredTop = Math.max(top, tailStart);
      if (left < 1) ranges.push({ ...range, startRowIndex: retiredTop, endColumnIndex: 1 });
      if (right > 13) ranges.push({ ...range, startRowIndex: retiredTop, startColumnIndex: 13 });
    }
    if (!changed) continue;
    if (ranges.length) requests.push({ updateConditionalFormatRule: { sheetId: targetId, index, rule: { ...rules[index], ranges } } });
    else requests.push({ deleteConditionalFormatRule: { sheetId: targetId, index } });
  }
  if (cells.length) requests.push({ updateCells: { start: { sheetId: targetId, rowIndex: 0, columnIndex: 1 }, rows: cells, fields: 'userEnteredValue' } });
  requests.push(...formatUpdates);
  const db = getSupabaseAdmin();
  const renewed = await db.rpc('renew_register_sync', { p_owner: owner, p_seconds: LEASE_SECONDS });
  if (renewed.error || renewed.data !== true) {
    if (renewed.error) console.error('[sheets/renew]', describeSheetsError(renewed.error));
    throw new Error('Sinkronisasi register melewati batas waktu penguncian; percobaan ulang masih tertunda.');
  }
  markMutation();
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }, REQUEST_OPTIONS);
  // Read native conditions after new values land, with our priority rules absent.
  if (projection.rows.length) {
    const native = await sheets.spreadsheets.get({
      spreadsheetId, includeGridData: true, ranges: [`${quoteSheet(name)}!E1:E${projection.rows.length}`],
      fields: 'properties.defaultFormat.textFormat,sheets(properties.sheetId,data(startRow,startColumn,rowData.values.effectiveFormat.textFormat))',
    }, REQUEST_OPTIONS);
    const nativeSheet = native.data.sheets?.find((sheet) => sheet.properties?.sheetId === targetId);
    const nativeGrid = nativeSheet?.data?.[0];
    if (!nativeGrid) throw new Error('Register tidak memiliki data format nomor setelah pembaruan.');
    const nativeText = projection.rows.map((_, row): sheets_v4.Schema$TextFormat => ({
      ...native.data.properties?.defaultFormat?.textFormat,
      ...nativeGrid.rowData?.[row - (nativeGrid.startRow ?? 0)]?.values?.[4 - (nativeGrid.startColumn ?? 0)]?.effectiveFormat?.textFormat,
    }));
    const fillRequests = buildRegisterFillRequests(targetId, projection.rows, [], nativeText);
    if (fillRequests.length) {
      const renewedFill = await db.rpc('renew_register_sync', { p_owner: owner, p_seconds: LEASE_SECONDS });
      if (renewedFill.error || renewedFill.data !== true) {
        if (renewedFill.error) console.error('[sheets/renew-fill]', describeSheetsError(renewedFill.error));
        throw new Error('Sinkronisasi register melewati batas waktu penguncian; percobaan ulang masih tertunda.');
      }
      markMutation();
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: fillRequests } }, REQUEST_OPTIONS);
    }
  }
  sheetRegisterCache.delete(month);
  const acknowledgement = await db.rpc('acknowledge_register_days', { p_owner: owner, p_days: days.map((day) => ({ letter_date: day.letter_date, revision: day.revision })) });
  if (acknowledgement.error || acknowledgement.data !== true) {
    if (acknowledgement.error) console.error('[sheets/acknowledge]', describeSheetsError(acknowledgement.error));
    throw new Error('Sinkronisasi register belum dapat dikonfirmasi; percobaan ulang masih tertunda.');
  }
}

async function syncMonths(months: number[]): Promise<void> {
  for (const month of months) if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('Bulan register tidak valid.');
  const db = getSupabaseAdmin();
  const retiring = await db.from('letter_slots').select('number').eq('retiring', true).limit(1);
  if (retiring.error) throw new Error('Register penghapusan nomor terakhir belum tersedia. Jalankan supabase/migrations/20261012_register_tail_trim.sql pada Supabase.');
  if (retiring.data?.length) {
    const dirty = await db.from('register_days').select('letter_date,revision,synced_revision').order('letter_date');
    if (dirty.error) throw new Error(dirty.error.message);
    const affected = new Set(months);
    for (const day of (dirty.data ?? []) as RegisterDay[]) {
      if (!day.letter_date.startsWith(`${REGISTER_YEAR}-`)) throw new Error('Hanya register Google Sheets tahun 2026 yang dapat ditulis.');
      if (String(day.revision) !== String(day.synced_revision)) affected.add(Number(day.letter_date.slice(5, 7)));
    }
    months = [...affected].sort((a, b) => a - b);
  }
  const owner = randomUUID();
  const acquired = await db.rpc('acquire_register_sync', { p_owner: owner, p_seconds: LEASE_SECONDS });
  if (acquired.error) throw new Error(acquired.error.message);
  if (acquired.data !== true) throw new Error('Penulis register sedang digunakan; sinkronisasi masih tertunda.');
  let uncertainMutation = false;
  let writeFailed = false;
  let writeError: unknown;
  try {
    for (const month of months) {
      await writeMonth(month, owner, () => { uncertainMutation = true; });
      uncertainMutation = false;
    }
  } catch (err) {
    writeFailed = true;
    writeError = err;
  }
  // A timed-out HTTP mutation might still reach Google; never unlock early in that case.
  if (!uncertainMutation) {
    try {
      const released = await db.rpc('release_register_sync', { p_owner: owner });
      if (released.error) throw new Error(released.error.message);
    } catch (err) {
      if (!writeFailed) throw err;
      console.error('[sheets/release]', describeSheetsError(err));
    }
  }
  if (writeFailed) throw writeError;
}

export async function syncRegisterMonth(month: number): Promise<void> { await syncMonths([month]); }

export async function syncRegisterCalendar(): Promise<void> {
  const db = getSupabaseAdmin();
  const months = new Set<number>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db.from('register_days').select('letter_date,revision,synced_revision').order('letter_date').range(offset, offset + 999);
    if (error) throw new Error(error.message);
    for (const day of (data ?? []) as RegisterDay[]) {
      if (!day.letter_date.startsWith(`${REGISTER_YEAR}-`)) throw new Error('Hanya register Google Sheets tahun 2026 yang dapat ditulis.');
      if (String(day.revision) !== String(day.synced_revision)) months.add(Number(day.letter_date.slice(5, 7)));
    }
    if ((data?.length ?? 0) < 1000) break;
  }
  if (months.size) await syncMonths([...months].sort((a, b) => a - b));
}

/** A successful monthly projection already includes every unchanged document in that month. */
export async function syncDocumentRow(doc: DocumentRow): Promise<void> {
  if (!doc.letter_date) throw new Error('Catatan lama tanpa tanggal hanya dapat dibaca.');
  if (!doc.letter_date.startsWith(`${REGISTER_YEAR}-`)) throw new Error('Hanya register Google Sheets tahun 2026 yang dapat ditulis.');
  await syncRegisterMonth(Number(doc.letter_date.slice(5, 7)));
}


export async function checkSheetsConfig(): Promise<{ ok: boolean; detail: string }> {
  try { const { sheetId } = sheetsConfig(); return { ok: true, detail: `Register bulanan tahun 2026 telah dikonfigurasi pada lembar kerja ${sheetId}.` }; }
  catch (err) { console.error('[sheets/config]', describeSheetsError(err)); return { ok: false, detail: sheetsUserMessage(err) }; }
}
