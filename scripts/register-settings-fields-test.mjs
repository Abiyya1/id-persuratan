import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../src/lib/register-settings.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { validateRegisterDefaults, validateRegisterDayTarget, validateRegisterDayDate, validateRegisterSettings } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const today = '2026-10-10';
const defaults = { closingUnusedMinimum: 15, futureDailyTotal: 45 };
assert.deepEqual(validateRegisterDefaults(defaults), defaults);
assert.deepEqual(validateRegisterDefaults({ closingUnusedMinimum: 50, futureDailyTotal: 150 }), { closingUnusedMinimum: 50, futureDailyTotal: 150 });
assert.deepEqual(validateRegisterDefaults({ closingUnusedMinimum: 1, futureDailyTotal: 1 }), { closingUnusedMinimum: 1, futureDailyTotal: 1 });
for (const key of Object.keys(defaults)) {
  const max = key === 'closingUnusedMinimum' ? 50 : 150;
  for (const value of [undefined, null, '15', true, 0, -1, 1.5, max + 1, NaN, Infinity, {}, []]) {
    assert.throws(() => validateRegisterDefaults({ ...defaults, [key]: value }));
  }
}
for (const input of [null, [], 15, 'settings', { ...defaults, unexpected: true }]) assert.throws(() => validateRegisterDefaults(input));
for (const total of [1, 400]) assert.deepEqual(validateRegisterDayTarget({ date: today, total }, today), { date: today, total });
assert.equal(validateRegisterDayTarget({ date: '2026-12-31', total: 200 }, today).total, 200);
for (const total of [0, 401, -1, 1.5, '400', null, true, NaN, Infinity]) assert.throws(() => validateRegisterDayTarget({ date: today, total }, today));
assert.throws(() => validateRegisterDayTarget({ date: '2026-10-09', total: 200 }, today));
assert.deepEqual(validateRegisterDayDate({ date: '2026-10-09' }), { date: '2026-10-09' });
for (const date of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-01', '2026-10-00', '2027-01-01', '2025-12-31', '2026-1-10', ' 2026-10-10', null, 20261010]) {
  assert.throws(() => validateRegisterDayTarget({ date, total: 200 }, today));
  assert.throws(() => validateRegisterDayDate({ date }));
}
assert.deepEqual(validateRegisterDayDate({ date: today }, today), { date: today });
assert.throws(() => validateRegisterDayDate({ date: today, total: 1 }, today));
assert.throws(() => validateRegisterDayTarget({ date: today, total: 10, locked: false }, today));
const settings = { ...defaults, today, year: 2026, dayTargets: [{ date: '2026-10-01', total: 400, locked: true }, { date: '2026-10-12', total: 200, locked: false }] };
assert.deepEqual(validateRegisterSettings(settings), settings);
assert.equal(validateRegisterSettings({ ...settings, today: '2027-01-01' }).today, '2027-01-01');
for (const patch of [{ today: '2026-02-30' }, { year: 2027 }, { dayTargets: null }, { dayTargets: [{ date: today, total: 401, locked: false }] }, { dayTargets: [{ date: today, total: 1, locked: 'false' }] }, { dayTargets: [settings.dayTargets[0], settings.dayTargets[0]] }]) assert.throws(() => validateRegisterSettings({ ...settings, ...patch }));
console.log('PASS register settings: strict bodies, integer caps, calendar/year/past dates, delete fields, server settings and locked plans');
