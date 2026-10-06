/**
 * Authorization probes against a running server.
 *
 * The important case here is the "ghost" token: a correctly signed JWT for a
 * user id that does not exist in Postgres. It must be rejected by the API
 * even though the signature verifies, because getFreshSession() re-reads the
 * database rather than trusting the cookie.
 *
 *   node scripts/authz-test.mjs http://localhost:3111
 */
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:3111';

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')];
    }),
);

const key = new TextEncoder().encode(env.SESSION_SECRET);

// A UUID that will not exist in the database.
const GHOST = '99999999-9999-9999-9999-999999999999';

async function mint(role, status) {
  return new SignJWT({ username: 'ghost', role, status })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(GHOST)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

const tokens = {
  user: await mint('user', 'approved'),
  admin: await mint('admin', 'approved'),
  superadmin: await mint('superadmin', 'approved'),
  pending: await mint('user', 'pending'),
};

const J = { 'Content-Type': 'application/json' };

let pass = 0;
let fail = 0;

async function probe(label, path, token, opts = {}, expected) {
  const r = await fetch(base + path, {
    ...opts,
    headers: { ...J, ...(token ? { Cookie: `dlms_session=${token}` } : {}), ...(opts.headers ?? {}) },
    redirect: 'manual',
  });
  const body = (await r.text()).slice(0, 110);
  const ok = r.status === expected;
  if (ok) pass += 1;
  else fail += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${String(r.status).padEnd(4)} want=${expected}  ${body}`,
  );
}

console.log('\n-- Ghost session (valid signature, absent from DB) --');
// All must be 401: the signature is real but the account is not.
await probe('ghost user -> generate', '/api/documents/generate', tokens.user,
  { method: 'POST', body: JSON.stringify({ title: 'Ghost' }) }, 401);
await probe('ghost user -> list', '/api/documents/list', tokens.user, {}, 401);
await probe('ghost admin -> list', '/api/documents/list', tokens.admin, {}, 401);
await probe('ghost admin -> resync', '/api/documents/resync', tokens.admin,
  { method: 'POST', body: JSON.stringify({ id: 1 }) }, 401);
await probe('ghost super -> users', '/api/superadmin/users', tokens.superadmin, {}, 401);
await probe('ghost super -> audit', '/api/audit/list', tokens.superadmin, {}, 401);
await probe('ghost user -> export', '/api/documents/export', tokens.user, {}, 401);
await probe('ghost user -> profile', '/api/profile/update', tokens.user,
  { method: 'PATCH', body: JSON.stringify({ username: 'newname' }) }, 401);

console.log('\n-- No token at all --');
for (const [label, path] of [
  ['anon -> list', '/api/documents/list'],
  ['anon -> export', '/api/documents/export'],
  ['anon -> audit', '/api/audit/list'],
  ['anon -> users', '/api/superadmin/users'],
  ['anon -> resync GET', '/api/documents/resync'],
]) {
  await probe(label, path, null, {}, 401);
}

console.log('\n-- Malformed tokens --');
await probe('garbage token', '/api/documents/list', 'not.a.jwt', {}, 401);
await probe('empty token', '/api/documents/list', '', {}, 401);

console.log('\n-- Cron secret --');
await probe('cron, no header', '/api/cron/resync', null, {}, 401);
await probe('cron, wrong secret', '/api/cron/resync', null,
  { headers: { Authorization: 'Bearer wrongsecretwrongsecretwrong' } }, 401);
await probe('cron, truncated secret', '/api/cron/resync', null,
  { headers: { Authorization: `Bearer ${env.CRON_SECRET.slice(0, 10)}` } }, 401);
await probe('cron, missing Bearer', '/api/cron/resync', null,
  { headers: { Authorization: env.CRON_SECRET } }, 401);

console.log('\n-- Method guards (405 expected, no body) --');
for (const [label, path, method] of [
  ['GET on generate', '/api/documents/generate', 'GET'],
  ['POST on list', '/api/documents/list', 'POST'],
  ['POST on cron', '/api/cron/resync', 'POST'],
  ['GET on logout', '/api/auth/logout', 'GET'],
]) {
  await probe(label, path, tokens.admin, { method }, 405);
}

console.log('\n-- Input validation (runs before any DB call) --');
await probe('register, 2-char username', '/api/auth/register', null,
  { method: 'POST', body: JSON.stringify({ username: 'ab', password: 'Passw0rd1' }) }, 400);
await probe('register, weak password', '/api/auth/register', null,
  { method: 'POST', body: JSON.stringify({ username: 'alice', password: 'abc' }) }, 400);
await probe('register, illegal chars', '/api/auth/register', null,
  { method: 'POST', body: JSON.stringify({ username: 'a b!', password: 'Passw0rd1' }) }, 400);
await probe('register, not JSON', '/api/auth/register', null,
  { method: 'POST', body: 'not json' }, 400);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
