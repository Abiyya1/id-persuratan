import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';

const moduleUrl = new URL('../src/lib/sheet-register.ts', import.meta.url);
let parseSheetRegister, buildRegisterFillRequests;
if (existsSync(moduleUrl)) {
  const compile = (file) => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const registerUrl = `data:text/javascript;base64,${Buffer.from(compile(new URL('../src/lib/register-sheet.ts', import.meta.url))).toString('base64')}`;
  const compiled = compile(moduleUrl).replace(/from ['"]\.\/register-sheet['"]/g, `from ${JSON.stringify(registerUrl)}`);
  ({ parseSheetRegister, buildRegisterFillRequests } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`));
}
assert.equal(typeof parseSheetRegister, 'function', 'Spreadsheet-shaped register reader is not implemented');

const text = (value, effectiveFormat) => ({ formattedValue: value, effectiveValue: { stringValue: value }, effectiveFormat });
const boolean = (value) => ({ formattedValue: String(value).toUpperCase(), effectiveValue: { boolValue: value }, dataValidation: { condition: { type: 'BOOLEAN' } } });
const row = (...values) => ({ values });
const source = {
  properties: { defaultFormat: { textFormat: { fontFamily: 'Arial', fontSize: 11 } }, spreadsheetTheme: { themeColors: [{ colorType: 'ACCENT1', color: { rgbColor: { red: 1, green: 0.8980392, blue: 0.6 } } }] } },
  sheets: [{
    properties: { title: 'AGUSTUS', gridProperties: { rowCount: 20, columnCount: 26 } },
    merges: [
      { startRowIndex: 5, endRowIndex: 6, startColumnIndex: 2, endColumnIndex: 5 },
      { startRowIndex: 6, endRowIndex: 8, startColumnIndex: 4, endColumnIndex: 5 },
      { startRowIndex: 5, endRowIndex: 6, startColumnIndex: 14, endColumnIndex: 26 },
    ],
    data: [{ startRow: 5, startColumn: 1,
      columnMetadata: Array.from({ length: 12 }, (_, i) => ({ pixelSize: i === 6 ? 300 : 75 })),
      rowMetadata: [{ pixelSize: 30 }, {}, {}, { pixelSize: 42 }],
      rowData: [
        row(text(''), text('SENIN, 3 AGUSTUS 2026')),
        row(text('NO'), text('KD SURAT'), text('/'), text('NOMOR SURAT')),
        row(text(''), text(''), text(''), text(''), text(''), text(''), text(''), text(''), text('CAT'), text('SRIKANDI'), text('EOFFICE'), text('MANUAL')),
        row(text('1'), text('600.1'), text('/'), text('.3939.1', { backgroundColorStyle: { themeColor: 'ACCENT1' }, horizontalAlignment: 'CENTER' }), text('/'), text('Pusdatin'), text('Rapat 4 AGUSTUS 2026'), text('Sekretariat'), boolean(false), boolean(true), text('tomo'), boolean(false)),
        row(text('2'), text(''), text('/'), text('3939.aa'), text('/'), text('Pusdatin'), text(''), text(''), boolean(false), boolean(false), boolean(false), boolean(false)),
        row(text(''), text(".'SELASA, 4 AGUSTUS 2026")),
        row(text('NO')),
        row(text('CAT')),
        row(text('1'), text(''), text('/'), text('3940'), text('/'), text('Pusdatin'), text(''), text(''), boolean(false)),
        row(), row(),
      ],
    }],
  }],
};
const month = parseSheetRegister(source, 8);
assert.deepEqual(month.days.map((day) => day.date), ['2026-08-03', '2026-08-04']);
const first = month.days[0];
assert.equal(first.rows.length, 5, 'A date mentioned in Hal must not split the day');
assert.equal(first.rows[3].cells[3].text, '.3939.1');
assert.equal(first.rows[4].cells[3].text, '3939.aa');
assert.equal(first.rows[3].cells[8].checked, false);
assert.equal(first.rows[3].cells[9].checked, true);
assert.equal(first.rows[3].cells[10].checked, null);
assert.equal(first.rows[3].cells[10].text, 'tomo');
assert.equal(first.rows[0].cells[1].colSpan, 3);
assert.equal(first.rows[0].cells[2].covered, true);
assert.equal(first.rows[1].cells[3].rowSpan, 2);
assert.equal(first.rows[2].cells[3].covered, true);
assert.equal(first.rows[0].cells[11].covered, undefined, 'O:Z merges must not affect B:M');
assert.equal(first.rows[3].cells[3].style.backgroundColor, '#FFE599');
assert.equal(first.rows[4].cells[3].style.backgroundColor, '#EA9999');
assert.equal(first.rows[4].cells[5].text, 'Pusdatin');
assert.equal(first.rows[4].cells[5].style.backgroundColor, '#ffffff');
assert.equal(first.rows[1].cells[3].style.backgroundColor, '#ffffff');
assert.equal(first.rows[3].cells[3].style.textAlign, 'center');
assert.equal(first.rows[3].cells[3].style.fontSize, '11pt');
assert.equal(first.rows[3].height, 42);
assert.equal(first.rows[3].sheetRow, 9);
assert.equal(month.widths[6], 300);
assert.equal(month.days[1].rows.length, 4, 'Trailing formatting-only rows must not extend the displayed day');
const mergedTail = structuredClone(source);
mergedTail.sheets[0].data[0].rowData[8].values[6] = text('Isi sel vertikal');
mergedTail.sheets[0].merges.push({ startRowIndex: 13, endRowIndex: 16, startColumnIndex: 7, endColumnIndex: 8 });
const mergedDay = parseSheetRegister(mergedTail, 8).days[1];
assert.equal(mergedDay.rows.length, 6, 'Blank rows inside a populated vertical merge must retain their source height');
assert.equal(mergedDay.rows[4].cells[6].covered, true);
assert.equal(mergedDay.rows[5].cells[6].covered, true);
mergedTail.sheets[0].data[0].rowData.splice(9);
assert.equal(parseSheetRegister(mergedTail, 8).days[1].rows.length, 6, 'Google may omit empty rowData covered by a merge');
assert.equal(parseSheetRegister({ sheets: [] }, 8).available, false);
assert.throws(() => parseSheetRegister(source, 0), /bulan/i);
const annotationOnly = structuredClone(source);
annotationOnly.sheets[0].data[0].rowData[4].values[11] = text('catatan');
assert.equal(parseSheetRegister(annotationOnly, 8).days[0].rows[4].cells[3].style.backgroundColor, '#FFE599');
annotationOnly.sheets[0].data[0].rowData[4].values[11] = text('FALSE');
assert.equal(parseSheetRegister(annotationOnly, 8).days[0].rows[4].cells[3].style.backgroundColor, '#EA9999');
annotationOnly.sheets[0].data[0].rowData[4].values[6] = text('Nomor digunakan kembali');
assert.equal(parseSheetRegister(annotationOnly, 8).days[0].rows[4].cells[3].style.backgroundColor, '#FFE599');
const sourceBefore = structuredClone(source);
parseSheetRegister(source, 8);
assert.deepEqual(source, sourceBefore, 'Reader colors must not mutate provider values or formats');
const fillRows = [['JUDUL'], ['NO', '', '', 'NOMOR SURAT'], [], [1, '', '/', '100', '/', 'Pusdatin'], [2, '', '/', '101', '/', '', '', '', false, false, false, 'catatan'], [3, '', '/', '102', '/', '', 'Surat']];
const existingRule = { ranges: [{ sheetId: 7, startColumnIndex: 1, endColumnIndex: 26 }], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=TRUE' }] }, format: { backgroundColor: { blue: 1 }, textFormat: { bold: true } } } };
const fillRequests = buildRegisterFillRequests(7, fillRows, [existingRule]);
assert.equal(fillRequests.length, 2);
const fillRules = fillRequests.map((request) => request.addConditionalFormatRule.rule);
assert.deepEqual(fillRules.flatMap((rule) => rule.ranges).sort((a, b) => a.startRowIndex - b.startRowIndex), [
  { sheetId: 7, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 4, endColumnIndex: 5 },
  { sheetId: 7, startRowIndex: 4, endRowIndex: 6, startColumnIndex: 4, endColumnIndex: 5 },
]);
assert.deepEqual(fillRules[0].booleanRule.format.backgroundColor, { red: 1, green: 229 / 255, blue: 153 / 255 });
assert.deepEqual(fillRules[1].booleanRule.format.backgroundColor, { red: 234 / 255, green: 153 / 255, blue: 153 / 255 });
assert.deepEqual(existingRule.booleanRule.format, { backgroundColor: { blue: 1 }, textFormat: { bold: true } });
const repeatedRequests = buildRegisterFillRequests(7, fillRows, [...fillRules, existingRule]);
assert.deepEqual(repeatedRequests.slice(0, 2), [{ deleteConditionalFormatRule: { sheetId: 7, index: 1 } }, { deleteConditionalFormatRule: { sheetId: 7, index: 0 } }]);
assert.deepEqual(repeatedRequests.slice(2), fillRequests);
const clearedRequests = buildRegisterFillRequests(7, [fillRows[3]], fillRules);
assert.equal(clearedRequests.at(-1).addConditionalFormatRule.rule.booleanRule.format.backgroundColor.red, 234 / 255);
const unrelatedNumberRule = { ranges: fillRules[0].ranges, booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=TRUE' }] }, format: fillRules[0].booleanRule.format } };
assert.deepEqual(buildRegisterFillRequests(7, fillRows, [unrelatedNumberRule]), fillRequests, 'An imported E-only rule with the same color is not ours to delete');
assert.deepEqual(buildRegisterFillRequests(7, fillRows.slice(0, 3)), []);
assert.equal(buildRegisterFillRequests(7, [fillRows[5]], fillRules).at(-1).addConditionalFormatRule.rule.booleanRule.format.backgroundColor.red, 1);
const plainNumberText = { bold: false, italic: false, strikethrough: false, foregroundColor: { red: 0, green: 0, blue: 0 } };
const conditionalNumberText = { bold: true, italic: true, strikethrough: true, foregroundColorStyle: { rgbColor: { red: 0.2, green: 0.4, blue: 0.6 } }, fontFamily: 'Arial', fontSize: 14, underline: true };
const effectiveText = [undefined, undefined, undefined, plainNumberText, conditionalNumberText, conditionalNumberText];
const effectiveBefore = structuredClone(effectiveText);
const styledRequests = buildRegisterFillRequests(7, fillRows, [], effectiveText);
const styledRules = styledRequests.map((request) => request.addConditionalFormatRule.rule);
const occupiedStyled = styledRules.find((rule) => rule.booleanRule.format.backgroundColor.red === 1);
assert.deepEqual(occupiedStyled.ranges, [{ sheetId: 7, startRowIndex: 4, endRowIndex: 6, startColumnIndex: 4, endColumnIndex: 5 }]);
assert.deepEqual(occupiedStyled.booleanRule.format.textFormat, { bold: true, italic: true, strikethrough: true, foregroundColorStyle: { rgbColor: { red: 0.2, green: 0.4, blue: 0.6 } } });
assert.deepEqual(styledRules.find((rule) => rule.booleanRule.format.backgroundColor.red !== 1).booleanRule.format.textFormat, plainNumberText);
assert.deepEqual(effectiveText, effectiveBefore);
const mixedText = [...effectiveText];
mixedText[5] = plainNumberText;
const mixedRules = buildRegisterFillRequests(7, fillRows, [], mixedText).map((request) => request.addConditionalFormatRule.rule);
assert.equal(mixedRules.length, 3, 'Same occupancy with distinct native text styles needs separate grouped rules');
const inactiveRules = buildRegisterFillRequests(7, fillRows, styledRules, Array(fillRows.length).fill(plainNumberText));
const inactiveOccupied = inactiveRules.filter((request) => request.addConditionalFormatRule).map((request) => request.addConditionalFormatRule.rule).find((rule) => rule.booleanRule.format.backgroundColor.red === 1);
assert.deepEqual(inactiveOccupied.booleanRule.format.textFormat, plainNumberText, 'A native condition turning false must not leave sticky bold/italic/foreground');
assert.deepEqual(buildRegisterFillRequests(7, [], styledRules), [{ deleteConditionalFormatRule: { sheetId: 7, index: 1 } }, { deleteConditionalFormatRule: { sheetId: 7, index: 0 } }]);
console.log('PASS source dates, suffixes, Boolean/text cells, theme colors, offsets/merges and blank-row bounds');
