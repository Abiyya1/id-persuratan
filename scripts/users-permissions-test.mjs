import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as jose from 'jose';
import bcrypt from 'bcryptjs';

function load(path, dependencies) {
  const source = readFileSync(new URL(`../src/${path}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports = {};
  new Function('require', 'exports', 'process', compiled)((name) => {
    assert.ok(name in dependencies, `Unexpected isolated import ${name}`);
    return dependencies[name];
  }, exports, { env: { SESSION_SECRET: 'isolated-account-permission-secret-32-characters', NEXT_PUBLIC_SUPABASE_URL: 'https://isolated.invalid', SUPABASE_SERVICE_ROLE_KEY: 'isolated-only' } });
  return exports;
}
const ids = {
  root: '10000000-0000-0000-0000-000000000001',
  admin: '10000000-0000-0000-0000-000000000002',
  pending: '10000000-0000-0000-0000-000000000003',
  ordinary: '10000000-0000-0000-0000-000000000004',
  rejected: '10000000-0000-0000-0000-000000000005',
  pendingAdmin: '10000000-0000-0000-0000-000000000006',
  ghost: '10000000-0000-0000-0000-000000000007',
};
const row = (id, role, status) => ({ id, username: `user_${id.slice(-3)}`, password_hash: 'private-password-hash', role, status, created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z' });
const rows = [row(ids.root, 'superadmin', 'approved'), row(ids.admin, 'admin', 'approved'), row(ids.pending, 'user', 'pending'), row(ids.ordinary, 'user', 'approved'), row(ids.rejected, 'user', 'rejected'), row(ids.pendingAdmin, 'admin', 'pending')];
let cookie;
const rpcCalls = [];
let rpcError = null;
const db = {
  from(table) {
    assert.equal(table, 'users');
    const filters = [];
    const query = {
      select: () => query,
      order: () => query,
      eq: (key, value) => { filters.push([key, value]); return query; },
      maybeSingle: async () => ({ data: structuredClone(rows.find((user) => filters.every(([key, value]) => user[key] === value)) ?? null), error: null }),
      then: (resolve, reject) => Promise.resolve({ data: structuredClone(rows.filter((user) => filters.every(([key, value]) => user[key] === value))), error: null }).then(resolve, reject),
    };
    return query;
  },
  async rpc(name, args) {
    rpcCalls.push({ name, args });
    if (rpcError) return { data: null, error: rpcError };
    const user = name === 'create_managed_user_account'
      ? row('20000000-0000-0000-0000-000000000001', args.p_role, 'approved')
      : { ...rows.find((user) => user.id === args.p_target_id), ...args.p_changes };
    const { password_hash, delete: deleted, ...publicUser } = user;
    void password_hash;
    return { data: { user: publicUser, deleted: deleted === true }, error: null };
  },
};
const supabase = load('lib/supabase', { '@supabase/supabase-js': { createClient: () => db } });
const auth = load('lib/auth', { 'server-only': {}, 'next/headers': { cookies: async () => ({ get: () => cookie ? { value: cookie } : undefined }) }, jose, bcryptjs: bcrypt, './supabase': supabase });
const route = load('app/api/admin/users/route', { '@/lib/auth': auth, '@/lib/supabase': supabase });
let registered;
const registrationDb = { from: () => {
  const query = {
    select: () => query, ilike: () => query,
    maybeSingle: async () => ({ data: null, error: null }),
    insert: (values) => { registered = values; return query; },
    single: async () => ({ data: { ...registered, id: ids.pending }, error: null }),
  };
  return query;
} };
const registration = load('app/api/auth/register/route', {
  '@/lib/auth': auth, '@/lib/supabase': { ...supabase, getSupabaseAdmin: () => registrationDb },
  '@/lib/audit': { writeAudit: async () => {}, AuditAction: { REGISTER: 'REGISTER' } },
});
const registeredResponse = await registration.POST(new Request('http://isolated.invalid/api/auth/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'new_registration', password: 'Passw0rd1', role: 'superadmin', status: 'approved' }),
}));
assert.equal(registeredResponse.status, 201);
assert.equal(registered.role, 'user', 'Registration must ignore client privilege claims');
assert.equal(registered.status, 'pending');
assert.equal((await registeredResponse.json()).pending, true);
async function login(id, role = 'superadmin', status = 'approved') {
  cookie = id ? await auth.signSession({ id, username: 'old_claim', role, status }) : undefined;
}
async function request(method, body, query = '') {
  const req = new Request(`http://isolated.invalid/api/admin/users${query}`, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const response = await route[method](req);
  return { status: response.status, body: await response.json() };
}

for (const id of [null, ids.ghost, ids.pending, ids.rejected, ids.pendingAdmin]) {
  await login(id);
  for (const method of ['GET', 'POST', 'PATCH']) {
    assert.equal((await request(method, method === 'GET' ? undefined : {})).status, 401, 'Missing or newly unapproved principals cannot use any user-management method');
  }
}
await login(ids.ordinary, 'admin');
for (const method of ['GET', 'POST', 'PATCH']) assert.equal((await request(method, method === 'GET' ? undefined : {})).status, 403, 'A stale privileged JWT cannot grant a live ordinary account management access');
await login(ids.admin, 'superadmin');
let response = await request('GET', undefined, '?status=approved&role=superadmin');
assert.equal(response.status, 200);
assert.deepEqual(response.body.users.map((user) => user.id), [ids.pending], 'Administrator list scope cannot be overridden by URL filters or stale root claims');
assert.deepEqual(response.body.counts, { total: 1, pending: 1, approved: 0, rejected: 0 });
assert.ok(response.body.users.every((user) => !('password_hash' in user)));
assert.equal((await request('POST', { username: 'created_admin', password: 'Passw0rd1', role: 'admin' })).status, 403);

for (const payload of [
  { role: 'admin', status: 'approved' }, { role: 'superadmin', status: 'approved' },
  { username: 'rename', status: 'approved' }, { password: 'Passw0rd1', status: 'approved' },
  { action: 'approve', status: 'approved' }, { delete: true, status: 'approved' },
  { delete: false, status: 'approved' }, { status: 'pending' }, { status: null }, {},
]) {
  const before = rpcCalls.length;
  assert.equal((await request('PATCH', { userId: ids.pending, ...payload })).status, 400);
  assert.equal(rpcCalls.length, before, 'Forbidden administrator payloads must not reach a mutation');
}
for (const status of ['approved', 'rejected']) {
  response = await request('PATCH', { userId: ids.pending, status });
  assert.equal(response.status, 200);
  assert.equal(response.body.user.role, 'user');
  assert.equal(response.body.user.status, status);
  assert.ok(!('password_hash' in response.body.user));
  assert.deepEqual(rpcCalls.at(-1), { name: 'update_managed_user_account', args: { p_actor_id: ids.admin, p_target_id: ids.pending, p_changes: { status } } });
}
rpcError = { code: '42501', message: 'FORBIDDEN: approved administrator required' };
assert.equal((await request('PATCH', { userId: ids.pending, status: 'approved' })).status, 403, 'A mutation-time permission loss must not report success');
rpcError = { code: '23514', message: 'PENDING_REGISTRATION_REQUIRED' };
assert.equal((await request('PATCH', { userId: ids.pending, status: 'approved' })).status, 409, 'A competing registration decision must not report success');
rpcError = { code: '40001', message: 'could not serialize access due to concurrent update' };
assert.equal((await request('PATCH', { userId: ids.pending, status: 'approved' })).status, 409, 'A serializable account race must remain an explicit conflict');
rpcError = null;

await login(ids.root, 'user');
response = await request('GET');
assert.equal(response.status, 200);
assert.equal(response.body.users.length, 6, 'A fresh root can list every role and status despite an old user JWT');
assert.ok(response.body.users.every((user) => !('password_hash' in user)));
response = await request('GET', undefined, '?status=approved&role=admin');
assert.deepEqual(response.body.users.map((user) => user.id), [ids.admin], 'Root list filters remain available');
for (const payload of [{ role: 'superadmin' }, { role: 'invalid' }, { role: null }]) {
  const before = rpcCalls.length;
  assert.equal((await request('POST', { username: 'never_root', password: 'Passw0rd1', ...payload })).status, 400);
  assert.equal(rpcCalls.length, before);
}
for (const payload of [{ role: 'superadmin' }, { delete: true, role: 'user' }, { username: 'rename' }, { status: 'invalid' }]) {
  const before = rpcCalls.length;
  assert.equal((await request('PATCH', { userId: ids.pending, ...payload })).status, 400);
  assert.equal(rpcCalls.length, before);
}
for (const role of ['user', 'admin']) {
  response = await request('POST', { username: `manual_${role}`, password: 'Passw0rd1', role });
  assert.equal(response.status, 201);
  assert.equal(response.body.user.role, role);
  assert.equal(response.body.user.status, 'approved');
  assert.ok(!('password_hash' in response.body.user));
  assert.equal(rpcCalls.at(-1).args.p_actor_id, ids.root);
  assert.ok(await bcrypt.compare('Passw0rd1', rpcCalls.at(-1).args.p_password_hash));
}
response = await request('PATCH', { userId: ids.ordinary, role: 'admin' });
assert.equal(response.status, 200);
assert.equal(response.body.user.role, 'admin');
response = await request('PATCH', { userId: ids.ordinary, delete: true });
assert.equal(response.status, 200);
assert.ok(!('user' in response.body));
rpcError = { code: '23514', message: 'SUPERADMIN_PROTECTED' };
for (const payload of [{ role: 'admin' }, { status: 'rejected' }, { delete: true }]) {
  assert.equal((await request('PATCH', { userId: ids.root, ...payload })).status, 409);
}
rpcError = null;
for (const body of [[], {}, { userId: 'not-a-uuid', status: 'approved' }]) assert.equal((await request('PATCH', body)).status, 400);
console.log('PASS actual account route/auth: fresh JWT permissions, forced admin scope, sanitized counts, exact pending decisions, forbidden root escalation, root user/admin creation and management, mutation-time denial/conflict');
