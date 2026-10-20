import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';

function load(file, dependencies = {}) {
  const source = readFileSync(new URL(`../src/lib/${file}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function('require', 'exports', 'process', compiled)((name) => {
    assert.ok(name in dependencies, `Unexpected isolated import ${name}`);
    return dependencies[name];
  }, exports, { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'fixture@example.invalid', GOOGLE_PRIVATE_KEY: 'isolated-fixture', GOOGLE_SHEET_ID: 'isolated-sheet' } });
  return exports;
}
const register = load('register-sheet');
const native = load('sheet-register', { './register-sheet': register });
const days = [8, 9, 10, 11].map((month) => ({ letter_date: `2026-${String(month).padStart(2, '0')}-${month === 10 ? '08' : '01'}`, revision: 2, synced_revision: 1, tail_trimmed: true }));
let retiring = true;
const written = [];
const liveValues = [1, '000', '/', '5057', '/', 'ORG', 'Live letter', 'Recipient', true, false, false, false];
const liveSlot = { number: '5057', letter_date: '2026-10-08', base_number: 5057, suffix_index: 0, document_id: 57, values: liveValues };
const liveDocument = { id: 57, title: 'Live letter', surat_number: '5057', letter_date: '2026-10-08', metadata: {} };
const db = {
  from: (table) => {
    const query = {
      select: () => query, eq: () => query, order: () => query, limit: () => query,
      maybeSingle: async () => ({ data: { initialized: true }, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: table === 'letter_slots' ? (retiring ? [{ number: '6226' }] : []) : days, error: null }).then(resolve, reject),
    };
    return query;
  },
  rpc: async (name, args) => {
    if (name === 'get_register_month') return { data: { days: structuredClone(days.filter((day) => Number(day.letter_date.slice(5, 7)) === args.p_month)), slots: args.p_month === 10 ? [liveSlot] : [], documents: args.p_month === 10 ? [liveDocument] : [] }, error: null };
    if (name === 'acknowledge_register_days') {
      for (const projected of args.p_days) days.find((day) => day.letter_date === projected.letter_date).synced_revision = projected.revision;
      retiring = days.some((day) => day.revision !== day.synced_revision);
    }
    return { data: true, error: null };
  },
};
const originalStyle = { backgroundColor: { red: 0.8, green: 0.2, blue: 0.1 }, borders: { bottom: { style: 'SOLID' } }, textFormat: { bold: true }, numberFormat: { type: 'TEXT' } };
const checkbox = { condition: { type: 'BOOLEAN' }, strict: true, showCustomUi: true };
const row = (values) => ({ values: Array.from({ length: 12 }, (_, column) => ({
  formattedValue: String(values[column] ?? ''), userEnteredValue: { stringValue: String(values[column] ?? '') },
  userEnteredFormat: structuredClone(originalStyle), ...(column >= 8 ? { dataValidation: structuredClone(checkbox) } : {}),
  note: 'Retired note',
})) });
const nativeCondition = { ranges: [{ startColumnIndex: 0, endColumnIndex: 26 }], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=TRUE' }] }, format: { backgroundColor: { red: 1 }, textFormat: { bold: true } } } };
const sheets = [8, 9, 10, 11].map((month) => ({
  properties: { sheetId: month, title: register.REGISTER_MONTHS[month - 1], gridProperties: { rowCount: 20, columnCount: 26 } },
  merges: [], conditionalFormats: [{ ...structuredClone(nativeCondition), ranges: [{ ...nativeCondition.ranges[0], sheetId: month }] }],
  unmanaged: { A: 'Keep A', 'O:Z': { text: 'Keep other register', format: structuredClone(originalStyle), validation: checkbox } },
  data: [{ startRow: 0, startColumn: 1, rowData: [
    row([`${month === 10 ? '8' : '1'} ${register.REGISTER_MONTHS[month - 1]} 2026`]), row(['Header']), row(['Kolom']),
    row(month === 10 ? liveValues : [1, '', '/', month === 11 ? '6226' : '6100', '/']),
    ...Array.from({ length: 16 }, (_, index) => row([index + 2, '', '/', String(6300 + index), '/'])),
  ] }],
}));
const octoberRows = sheets[2].data[0].rowData;
[octoberRows[3], octoberRows[10]] = [octoberRows[10], octoberRows[3]];
octoberRows[10].values[3].note = 'Live 5057 note';
delete octoberRows[10].values[4].note;
const unmanagedBefore = structuredClone(sheets.map((sheet) => sheet.unmanaged));
for (const sheet of sheets) sheet.conditionalFormats.unshift(...native.buildRegisterFillRequests(sheet.properties.sheetId, Array.from({ length: 20 }, () => [1, '', '/', '6999', '/', '', '', '', false, false, false, false])).map((request) => request.addConditionalFormatRule.rule));
let readGate = null;
const provider = { spreadsheets: {
  get: async (args) => {
    assert.ok(!args.ranges?.some((range) => range.includes('E1:E0')), 'Empty month must not produce an invalid native range');
    const selected = args.ranges ? sheets.filter((sheet) => sheet.properties.title === args.ranges[0].split('!')[0].replaceAll("'", '')) : sheets;
    const result = { data: { properties: { defaultFormat: { textFormat: { foregroundColor: { red: 0, green: 0, blue: 0 } } } }, sheets: structuredClone(selected) } };
    if (readGate && args.ranges?.[0] === "'NOVEMBER'!B:M") { readGate.ready(); await readGate.wait; }
    return result;
  },
  batchUpdate: async ({ requestBody }) => {
    for (const request of requestBody.requests) {
      assert.ok(!request.deleteDimension && !request.insertDimension, 'Cleanup must not shift physical rows');
      const deleted = request.deleteConditionalFormatRule;
      if (deleted) sheets.find((sheet) => sheet.properties.sheetId === deleted.sheetId).conditionalFormats.splice(deleted.index, 1);
      const changed = request.updateConditionalFormatRule;
      if (changed) sheets.find((sheet) => sheet.properties.sheetId === changed.sheetId).conditionalFormats[changed.index] = structuredClone(changed.rule);
      const added = request.addConditionalFormatRule;
      if (added) sheets.find((sheet) => sheet.properties.sheetId === added.rule.ranges[0].sheetId).conditionalFormats.splice(added.index, 0, structuredClone(added.rule));
      const update = request.updateCells;
      if (!update) continue;
      const sheet = sheets.find((item) => item.properties.sheetId === (update.range?.sheetId ?? update.start?.sheetId));
      assert.ok(sheet);
      const rows = sheet.data[0].rowData;
      if (update.range) {
        assert.equal(update.range.startColumnIndex, 1);
        assert.equal(update.range.endColumnIndex, 13, 'Clearing must not touch unmanaged columns');
        if (update.fields === 'userEnteredValue') written.push(sheet.properties.sheetId);
        for (let index = update.range.startRowIndex ?? 0; index < update.range.endRowIndex; index++) {
          for (const cell of rows[index]?.values ?? []) for (const field of update.fields.split(',')) {
            delete cell[field];
            if (field === 'userEnteredValue') delete cell.formattedValue;
          }
        }
      }
      if (update.rows) for (let index = 0; index < update.rows.length; index++) {
        const target = update.start.rowIndex + index;
        rows[target] ??= { values: [] };
        update.rows[index].values.forEach((cell, column) => {
          const current = rows[target].values[column] ??= {};
          for (const field of update.fields.split(',')) {
            if (cell[field] === undefined) delete current[field];
            else current[field] = structuredClone(cell[field]);
          }
          if (update.fields.includes('userEnteredValue')) current.formattedValue = String(cell.userEnteredValue?.stringValue ?? cell.userEnteredValue?.numberValue ?? cell.userEnteredValue?.boolValue ?? '');
        });
      }
    }
    return { data: {} };
  },
} };
const writer = load('google-sheets', {
  'node:crypto': { randomUUID }, googleapis: { google: { auth: { JWT: class {} }, sheets: () => provider } },
  './supabase': { getSupabaseAdmin: () => db }, './register-sheet': register, './sheet-register': native,
});
await writer.syncRegisterMonth(11);
assert.deepEqual(written, [8, 9, 10, 11], 'August clearing must not prevent later months from completing');
assert.equal(retiring, false);
const august = sheets[0].data[0].rowData;
assert.equal(register.parseRegisterHeadingRow(august[0].values.map((cell) => cell.formattedValue), 8), '2026-08-01');
assert.ok(august[3].values.some((cell) => cell.userEnteredFormat?.numberFormat?.type === 'TEXT'), 'Blank template data prototype must survive native grid truncation');
assert.ok(august[3].values.every((cell) => cell.note === undefined), 'Blank August prototype must not retain retired notes');
assert.ok(!sheets.flatMap((sheet) => sheet.data[0].rowData.flatMap((entry) => entry.values)).some((cell) => ['6100', '6226'].includes(cell.formattedValue)), 'Retired numbers must not remain in template or later months');
assert.deepEqual(sheets.map((sheet) => sheet.unmanaged), unmanagedBefore, 'A and O:Z must remain untouched');
assert.deepEqual(sheets[2].data[0].rowData[3].values[6].userEnteredFormat, originalStyle, 'Moved live non-number cell must retain its complete native style');
const liveNumberFormat = sheets[2].data[0].rowData[3].values[3].userEnteredFormat;
for (const field of ['textFormat', 'borders', 'numberFormat']) assert.deepEqual(liveNumberFormat[field], originalStyle[field], `Moved live number must preserve native ${field}`);
const occupiedFill = { red: 1, green: 229 / 255, blue: 153 / 255 };
assert.deepEqual(liveNumberFormat.backgroundColor, occupiedFill, 'Moved occupied number must use official #FFE599 fill');
assert.deepEqual(liveNumberFormat.backgroundColorStyle, { rgbColor: occupiedFill });
assert.deepEqual(sheets[2].data[0].rowData[3].values[8].dataValidation, checkbox, 'Live checkbox must remain intact');
assert.equal(sheets[2].data[0].rowData[3].values[3].note, 'Live 5057 note', 'Moved live note must survive clearing its retired source row');
assert.equal(sheets[2].data[0].rowData[3].values[4].note, undefined, 'An unnoted moved live cell must clear the stale destination note');
for (const sheet of sheets) {
  const tailStart = sheet.properties.sheetId === 8 || sheet.properties.sheetId === 10 ? 4 : 0;
  for (const retiredRow of sheet.data[0].rowData.slice(tailStart)) for (const cell of retiredRow.values) {
    for (const field of ['userEnteredValue', 'userEnteredFormat', 'dataValidation', 'note']) assert.equal(cell[field], undefined, `Retired ${sheet.properties.title} cells must clear ${field}`);
  }
  for (const rule of sheet.conditionalFormats) for (const range of rule.ranges) {
    assert.ok((range.endRowIndex ?? Infinity) <= tailStart || (range.endColumnIndex ?? Infinity) <= 1 || (range.startColumnIndex ?? 0) >= 13, 'Native and app conditional fills must not reach the retired B:M tail');
  }
  assert.ok(sheet.conditionalFormats.some((rule) => rule.ranges.some((range) => range.startColumnIndex === 13 && range.endColumnIndex === 26)), 'Native conditions on unmanaged columns must survive');
}
days[3].revision++;
await writer.syncRegisterMonth(11);
assert.equal(days[3].revision, days[3].synced_revision, 'Subsequent writes must still use the empty August template');
let ready;
const readyPromise = new Promise((resolve) => { ready = resolve; });
let release;
readGate = { ready, wait: new Promise((resolve) => { release = resolve; }) };
const lateRead = writer.readSheetRegisterMonth(11);
await readyPromise;
days[3].revision++;
days[3].synced_revision = days[3].revision;
release();
await assert.rejects(lateRead, /Register berubah saat dibaca/, 'A native response captured before cleanup must not become fresh after finalization');
readGate = null;
days[3].revision++;
await assert.rejects(writer.readSheetRegisterMonth(11), /menunggu sinkronisasi/, 'Dirty month must not expose obsolete native numbers');
console.log('PASS actual writer: blank styled/validated/noted retired tail, preserved live5057/native conditions/unmanaged cells, reusable August prototype and dirty native-read rejection');
