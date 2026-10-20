import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('../src/lib/letter-fields.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { validateLetterInput, getRegisterToday } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const valid = { kdSurat: '600.1.1', kdSatker: 'Pusdatin', hal: 'Surat uji', tujuanSurat: 'Sekretariat', ket: 'MANUAL', date: '2026-10-06', month: 10 };
const parsed = validateLetterInput(valid);
assert.equal(parsed.hal, 'Surat uji');
assert.equal(parsed.metadata.kdSurat, '600.1.1');
assert.equal(parsed.emergency, false);
for (const patch of [
 { date: '2026-02-30', month: 2 }, { date: '2026-02-29', month: 2 },
 { date: '2027-01-01', month: 1 }, { date: '2026-10-06', month: 9 },
 { kdSurat: '600 invalid' }, { kdSatker: ' ' }, { hal: ' ' },
 { ket: 'OTHER' }, { emergency: 'true' }, { emergency: true },
]) assert.throws(() => validateLetterInput({ ...valid, ...patch }));
assert.equal(validateLetterInput({ ...valid, emergency: true, emergencyReason: 'Cadangan habis' }).emergencyReason, 'Cadangan habis');
for (const destination of ['', '   ', undefined, null]) {
  assert.throws(() => validateLetterInput({ ...valid, tujuanSurat: destination }));
}
for (const destination of [123, false, {}, [], 'x'.repeat(501)]) {
  assert.throws(() => validateLetterInput({ ...valid, tujuanSurat: destination }));
}
assert.equal(validateLetterInput({ ...valid, tujuanSurat: '  Tujuan pilihan  ' }).metadata.tujuanSurat, 'Tujuan pilihan');
assert.throws(() => validateLetterInput({ ...valid, ket: '' }));
const today = '2026-10-06';
assert.throws(() => validateLetterInput({ ...valid, ket: 'CAT' }, today));
for (const ket of ['SRIKANDI', 'EOFFICE', 'MANUAL']) {
  assert.equal(validateLetterInput({ ...valid, ket }, today).metadata.ket, ket);
}
for (const date of ['2026-10-05', '2026-10-07']) {
  assert.equal(validateLetterInput({ ...valid, date }, today).metadata.ket, 'MANUAL');
  for (const ket of ['CAT', 'SRIKANDI', 'EOFFICE']) {
    assert.throws(() => validateLetterInput({ ...valid, date, ket }, today));
  }
}
assert.equal(getRegisterToday(new Date('2026-10-06T16:59:59.999Z')), '2026-10-06');
assert.equal(getRegisterToday(new Date('2026-10-06T17:00:00.000Z')), '2026-10-07');
console.log('PASS letter fields: required destination, CAT rejected, explicit Ket, non-today MANUAL, WIB midnight, validation and emergency boundaries');
