import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../src/lib/register-sheet.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { parseClassifications, parseRegisterRows, normalizeRegisterNumber, buildRegisterProjection, registerNumberFill, registerNumberCellFormat } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
assert.deepEqual(parseClassifications([
 ['600', 'PEMBANGUNAN DAERAH '], ['', '600.1', 'PERUMUSAN KEBIJAKAN'], ['', '', '600.1.1', 'Perumusan kebijakan'],
]), [{ code: '600', description: 'PEMBANGUNAN DAERAH' }, { code: '600.1', description: 'PERUMUSAN KEBIJAKAN' }, { code: '600.1.1', description: 'Perumusan kebijakan' }]);
assert.throws(() => parseClassifications([['600', 'One'], ['600', 'Two']]));
assert.equal(normalizeRegisterNumber('.3939.1'), '3939.1');
assert.equal(normalizeRegisterNumber('3951.aa'), '3951.aa');
assert.equal(normalizeRegisterNumber('3939.0'), null);
const rows = [
 ['', 'Senin, 3 Agustus 2026'],
 [1, '', '/', '3939', '/', 'Pusdatin', '', '', false, false, false, false],
 [2, '', '/', '3939.1', '/', 'Pusdatin', '', '', false, false, false, true],
 [3, '600.1', '/', '3940', '/', 'Pusdatin', '', '', false, false, false, false],
];
const imported = parseRegisterRows(rows, 8);
assert.deepEqual(imported.map((r) => [r.number, r.occupied]), [['3939', false], ['3939.1', true], ['3940', true]]);
assert.equal(parseRegisterRows([rows[0], [4, '', '/', '3941', '/', 'Pusdatin', '', '', false, false, false, 'tomo']], 8)[0].occupied, true);
const day = { letter_date: '2026-08-03', revision: 1, synced_revision: 0, fixed_reservation: false, closed: true };
const slots = imported.map((r) => ({ number: r.number, letter_date: r.date, base_number: Number(r.number.split('.')[0]), suffix_index: r.number.includes('.') ? 1 : 0, document_id: null, values: r.values }));
const doc = { id: 101, surat_number: '3940', letter_date: day.letter_date, title: 'Hal terbaru', metadata: { kdSurat: '600.1.1', kdSatker: 'Pusdatin', tujuanSurat: 'Sekretariat', ket: 'SRIKANDI' } };
slots[2].document_id = doc.id;
const projection = buildRegisterProjection([day], slots, [doc]);
assert.deepEqual(projection.rows[3], rows[1]);
assert.deepEqual(projection.rows[4], rows[2]);
assert.deepEqual(projection.rows[5].slice(1), ['600.1.1', '/', '3940', '/', 'Pusdatin', 'Hal terbaru', 'Sekretariat', false, true, false, false]);
assert.throws(() => buildRegisterProjection([day], slots, []));
const annotated = buildRegisterProjection([day], [{ ...slots[0], number: '3941', base_number: 3941, values: [4, '', '/', '3941', '/', 'Pusdatin', 'Manual annotation', '', '', '', '', 'tomo'] }], []);
assert.deepEqual(annotated.rows[3].slice(8), ['', '', '', 'tomo']);
const importedNumber = buildRegisterProjection([day], [{ ...slots[0], values: [1, '', '/', '.3939', '/', 'Satker lama', '', '', 'FALSE', '', '', 'catatan'] }], []);
assert.deepEqual(importedNumber.rows[3], [1, '', '/', '.3939', '/', 'Satker lama', '', '', 'FALSE', '', '', 'catatan']);
const emptySlot = { ...slots[0], number: '3942', base_number: 3942, values: null };
assert.equal(buildRegisterProjection([day], [emptySlot], []).rows[3][5], '');
assert.equal(buildRegisterProjection([day], [{ ...emptySlot, document_id: 102 }], [{ ...doc, id: 102, surat_number: '3942', metadata: {} }]).rows[3][5], '');
assert.deepEqual(buildRegisterProjection([{ ...day, tail_trimmed: true }], [], []).rows, []);
assert.equal(buildRegisterProjection([{ ...day, tail_trimmed: true }], [emptySlot], []).rows.length, 4);
assert.equal(registerNumberFill(rows[1]), '#EA9999');
assert.equal(registerNumberFill(rows[2]), '#FFE599');
assert.equal(registerNumberFill(['NO', 'KD SURAT', '/', 'NOMOR SURAT']), null);
assert.equal(registerNumberFill([1, '', '/', '3942', '/', 'Pusdatin', '', '', 'FALSE', false, ' false ', '']), '#EA9999');
assert.equal(registerNumberFill([1, '', '/', '3942', '/', 'Pusdatin', '', '', false, false, false, 'catatan']), '#FFE599');
const originalFormat = { backgroundColorStyle: { themeColor: 'ACCENT1' }, backgroundColor: { blue: 1 }, textFormat: { bold: true }, borders: { bottom: { style: 'DOUBLE' } }, horizontalAlignment: 'CENTER', numberFormat: { type: 'TEXT' } };
const emptyFormat = registerNumberCellFormat(originalFormat, rows[1]);
assert.deepEqual(emptyFormat.backgroundColorStyle, { rgbColor: { red: 234 / 255, green: 153 / 255, blue: 153 / 255 } });
assert.deepEqual(emptyFormat.textFormat, originalFormat.textFormat);
assert.deepEqual(emptyFormat.borders, originalFormat.borders);
assert.deepEqual(emptyFormat.numberFormat, originalFormat.numberFormat);
assert.equal(emptyFormat.horizontalAlignment, 'CENTER');
assert.deepEqual(originalFormat.backgroundColorStyle, { themeColor: 'ACCENT1' });
assert.equal(registerNumberCellFormat(originalFormat, ['NOMOR SURAT']), originalFormat);
assert.deepEqual(registerNumberCellFormat(emptyFormat, rows[1]), emptyFormat);
assert.deepEqual(registerNumberCellFormat(emptyFormat, rows[2]).backgroundColorStyle, { rgbColor: { red: 1, green: 229 / 255, blue: 153 / 255 } });
console.log('PASS taxonomy hierarchy, existing numeric suffixes, occupied-slot detection, imported records and current document projection');
