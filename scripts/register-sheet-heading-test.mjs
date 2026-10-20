import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/register-sheet.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { parseRegisterRows, parseRegisterHeadingRow } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const values = [1, '', '/', '.3915', '/', 'Pusdatin', 'Appointment 4 Juli 2026', '', false, false, false, false];
const august = parseRegisterRows([['', 'Senin, 3 Agustus 2026'], values], 8);
assert.equal(august[0].date, '2026-08-03');
assert.equal(august[0].number, '3915');
assert.deepEqual(august[0].values, values);
assert.equal(parseRegisterRows([['Jumat, 3 Juli 2026'], [1, '', '/', '3338', '/', 'Pusdatin']], 7)[0].date, '2026-07-03');
assert.equal(parseRegisterHeadingRow(['', 'Senin, 3 Agustus 2026'], 8), '2026-08-03');
assert.throws(() => parseRegisterHeadingRow(['Senin, 3 Agustus 2026', 'Selasa, 4 Agustus 2026'], 8));
assert.throws(() => parseRegisterHeadingRow(['', 'Jumat, 3 Juli 2026'], 8));
assert.throws(() => parseRegisterRows([['', 'Senin, 3 Agustus 2026'], values, values], 8));
console.log('Register B/C date heading regressions passed');
