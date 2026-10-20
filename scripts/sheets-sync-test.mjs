import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the actual shared coordinator; replace only DB/Sheets boundaries.
const source = ts.createSourceFile('google-sheets.ts', readFileSync(new URL('../src/lib/google-sheets.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const coordinator = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'syncMonths');
assert.ok(coordinator, 'Shared Sheets coordinator must exist');
const compiled = ts.transpileModule(`export default function create(getSupabaseAdmin, randomUUID, writeMonth, describeSheetsError, console, LEASE_SECONDS, REGISTER_YEAR) { ${coordinator.getText(source)}; return syncMonths; }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { default: create } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

function fixture(write, release, acquire = { data: true, error: null }, retiring = [], days = []) {
  let locked = false;
  const db = {
    from(table) {
      const result = { data: table === 'letter_slots' ? retiring : days, error: null };
      const query = { select: () => query, eq: () => query, limit: async () => result, order: async () => result };
      return query;
    },
    rpc: async (name) => {
      if (name === 'acquire_register_sync') { locked = acquire.data === true; return acquire; }
      const result = await release();
      if (!result.error) locked = false;
      return result;
    },
  };
  return { sync: create(() => db, () => 'isolated-owner', write, (err) => String(err), { error() {} }, 120, 2026), locked: () => locked };
}

for (const primary of [new Error('writer failed'), undefined, null, 0]) {
  for (const release of [async () => ({ error: { message: 'release failed' } }), async () => { throw new Error('release rejected'); }]) {
    const run = fixture(async () => { throw primary; }, release);
    let rejected = false;
    try { await run.sync([10]); } catch (error) { rejected = true; assert.equal(error, primary); }
    assert.equal(rejected, true, 'A writer rejection must not become success or a cleanup error');
  }
}
const uncertain = fixture(async (_month, _owner, markMutation) => { markMutation(); throw new Error('uncertain Google write'); }, async () => ({ error: null }));
await assert.rejects(uncertain.sync([10]), /uncertain Google write/);
assert.equal(uncertain.locked(), true, 'An uncertain remote write must retain its lease');

const laterFailure = new Error('later month failed before mutation');
const later = fixture(async (month, _owner, markMutation) => { if (month === 10) markMutation(); else throw laterFailure; }, async () => ({ error: null }));
await assert.rejects(later.sync([10, 11]), (error) => error === laterFailure);
assert.equal(later.locked(), false, 'A completed write must clear uncertainty before the next month');

const releaseOnly = fixture(async () => {}, async () => ({ error: { message: 'release-only failure' } }));
await assert.rejects(releaseOnly.sync([10]), /release-only failure/);
const releaseRejected = fixture(async () => {}, async () => { throw new Error('release-only rejection'); });
await assert.rejects(releaseRejected.sync([10]), /release-only rejection/);
const acquisition = fixture(async () => { throw new Error('must not write'); }, async () => { throw new Error('must not release'); }, { data: false, error: { message: 'acquisition failed' } });
await assert.rejects(acquisition.sync([10]), /acquisition failed/);
const months = [];
const tail = fixture(async (month) => { months.push(month); }, async () => ({ error: null }), { data: true, error: null }, [{ number: '6226' }], [
  { letter_date: '2026-10-08', revision: 2, synced_revision: 1 },
  { letter_date: '2026-11-03', revision: 2, synced_revision: 1 },
  { letter_date: '2026-12-02', revision: 2, synced_revision: 1 },
  { letter_date: '2026-09-01', revision: 2, synced_revision: 2 },
]);
await tail.sync([11]);
assert.deepEqual(months, [10, 11, 12], 'A single deletion sync clears every dirty tail month, including empty future days');
console.log('PASS Sheets coordinator: original errors, falsy rejections, release failures and uncertain-write lease safety');
