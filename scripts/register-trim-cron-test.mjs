import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/app/api/cron/resync/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const events = [];
let pending = true;
let closingError = null;
class AuthError extends Error { constructor(message, status) { super(message); this.status = status; } }
const imports = {
  '@/lib/auth': { AuthError, handleRoute: (run) => run() },
  '@/lib/supabase': { getSupabaseAdmin: () => ({ rpc: async () => {
    events.push('close');
    return { error: closingError ?? (pending ? { message: 'REGISTER_TRIM_PENDING: clearing required' } : null) };
  } }) },
  '@/lib/audit': { writeAudit: async () => {}, AuditAction: { CRON_RESYNC: 'CRON_RESYNC' } },
  '@/lib/resync': { retryFailedDocuments: async () => [], countUnsynced: async () => ({ failed: 0, pending: 0 }) },
  '@/lib/google-sheets': {
    checkSheetsConfig: async () => ({ ok: true }),
    syncRegisterCalendar: async () => { events.push('clear'); pending = false; },
    describeSheetsError: String, sheetsUserMessage: String,
  },
  '@/lib/letter-register': { ensureLetterRegister: async () => {} },
  '@/lib/letter-fields': { getRegisterToday: () => '2026-10-07' },
};
const exports = {};
new Function('require', 'exports', 'process', compiled)((name) => {
  assert.ok(name in imports, `Unexpected fixture import: ${name}`);
  return imports[name];
}, exports, { env: { CRON_SECRET: 'isolated-cron-fixture' } });
const request = () => new Request('http://isolated/cron/resync', { headers: { authorization: 'Bearer isolated-cron-fixture' } });
const deferred = await exports.GET(request());
assert.equal(deferred.status, 200, 'A pending trim must not prevent automatic Sheets clearing');
assert.equal((await deferred.json()).closingDeferred, true);
assert.deepEqual(events, ['close', 'clear']);
const recovered = await exports.GET(request());
assert.equal(recovered.status, 200);
assert.equal((await recovered.json()).closingDeferred, false, 'The next run must retry ordinary day closure');
assert.deepEqual(events, ['close', 'clear', 'close', 'clear']);
closingError = { message: 'REGISTER_CONFLICT: preserved range' };
const conflict = await exports.GET(request());
assert.equal(conflict.status, 409, 'Only the pending-tail hold may defer closure');
assert.deepEqual(events, ['close', 'clear', 'close', 'clear', 'close']);
console.log('PASS actual cron: pending trim clears automatically, subsequent closure resumes, real conflicts remain blocked');
