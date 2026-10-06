/**
 * Verifies the database is provisioned and the Sheets key is well-formed.
 * Run before `npm run dev` so setup problems surface as messages, not 500s.
 *
 *   node scripts/check-env.mjs
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// --- Parse .env.local the way Next.js does -------------------------------
const raw = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const env = {};
for (const line of raw.split('\n')) {
  if (!line.trim() || line.trim().startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  const key = line.slice(0, i).trim();
  let val = line.slice(i + 1).trim();
  if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
  env[key] = val;
}

let problems = 0;
let warnings = 0;

const bad = (m) => { console.log(`  FAIL    ${m}`); problems += 1; };
const warn = (m) => { console.log(`  WARN    ${m}`); warnings += 1; };
const good = (m) => console.log(`  ok      ${m}`);

console.log('\n=== Environment variables ===\n');

const REQUIRED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SESSION_SECRET',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
  'GOOGLE_SHEET_ID',
  'CRON_SECRET',
];

for (const key of REQUIRED) {
  if (!env[key]) bad(`${key} is missing or empty`);
}

if (problems === 0) good('all required variables present');

const url = env.NEXT_PUBLIC_SUPABASE_URL ?? '';
if (url) {
  // The SDK appends its own paths, so a URL with /rest/v1 produces
  // /rest/v1/rest/v1/... and every query 404s.
  if (/\/rest\/?v1\/?$/.test(url)) {
    bad(`NEXT_PUBLIC_SUPABASE_URL has a trailing API path: ${url}`);
    console.log('          expected: https://<ref>.supabase.co');
  } else if (/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url)) {
    good(`NEXT_PUBLIC_SUPABASE_URL looks correct (${new URL(url).host})`);
  } else {
    warn(`NEXT_PUBLIC_SUPABASE_URL is unusual: ${url}`);
  }
}

const svc = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
if (svc && anon) {
  if (svc === anon) bad('SUPABASE_SERVICE_ROLE_KEY is the same as the anon key');
  else good('service role key differs from the anon key');
}

if (svc) {
  try {
    const claims = JSON.parse(
      Buffer.from(svc.split('.')[1], 'base64url').toString('utf8'),
    );
    if (claims.role === 'service_role') good('service role key has role=service_role');
    else bad(`service role key has role=${claims.role}, expected service_role`);
  } catch {
    bad('could not decode the service role key as a JWT');
  }
}

const sess = env.SESSION_SECRET ?? '';
if (sess && sess.length < 32) bad(`SESSION_SECRET is ${sess.length} chars, needs >= 32`);
else if (sess) good(`SESSION_SECRET length ${sess.length}`);

const cron = env.CRON_SECRET ?? '';
if (cron && cron.length < 32) bad(`CRON_SECRET is ${cron.length} chars, needs >= 32`);
else if (cron) good(`CRON_SECRET length ${cron.length}`);

if (sess && cron && sess === cron) {
  warn('SESSION_SECRET and CRON_SECRET are identical -- use two different values');
}

const pem = env.GOOGLE_PRIVATE_KEY ?? '';
if (pem) {
  if (!pem.includes('BEGIN PRIVATE KEY')) bad('GOOGLE_PRIVATE_KEY is missing the PEM header');
  else if (!pem.includes('END PRIVATE KEY')) bad('GOOGLE_PRIVATE_KEY is missing the PEM footer');
  else if (!/\\n/.test(pem)) {
    bad('GOOGLE_PRIVATE_KEY has no literal \\n -- .env cannot hold real newlines');
  } else {
    const restored = pem.replace(/\\n/g, '\n');
    const lines = restored.split('\n').filter(Boolean);
    if (lines.length < 4) warn(`private key restored to only ${lines.length} lines`);
    else good(`private key un-escapes to ${lines.length} lines`);
  }
}

const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? '';
if (email && !/^[a-z0-9.\-]+@[a-z0-9.\-]+\.iam\.gserviceaccount\.com$/.test(email)) {
  warn(`GOOGLE_SERVICE_ACCOUNT_EMAIL does not look like a service account: ${email}`);
} else if (email) {
  good('service account email is well-formed');
}

if (!problems) console.log('\nEnvironment OK.\n');
else console.log(`\n${problems} problem(s) must be fixed before the app will work.\n`);

// --- Database checks -------------------------------------------------------
console.log('=== Database ===\n');

if (!env.NEXT_PUBLIC_SUPABASE_URL || !svc) {
  console.log('  skipped -- cannot connect without URL and service role key.\n');
  process.exit(problems > 0 ? 1 : 0);
}

const supabase = createClient(url.replace(/\/rest\/?v1\/?$/, ''), svc, {
  auth: { persistSession: false },
});

const TABLES = ['users', 'documents', 'audit_logs', 'id_counter'];

for (const table of TABLES) {
  // select=* with limit 1 is the cheapest call that proves both the table and
  // the service role's access to it.
  const { error } = await supabase.from(table).select('*').limit(1);
  if (error) bad(`${table}: ${error.message}`);
  else good(`${table} exists`);
}

const { data: counter } = await supabase.from('id_counter').select('current_val').eq('id', 1).maybeSingle();
if (!counter) bad('id_counter row (id=1) is missing -- schema.sql was not fully applied');
else good(`id_counter current_val = ${counter.current_val} (next ID will be ${counter.current_val + 1})`);

const { data: admins, error: adminErr } = await supabase
  .from('users')
  .select('username, role, status')
  .eq('role', 'superadmin');

if (adminErr) {
  bad(`could not read superadmins: ${adminErr.message}`);
} else if (!admins || admins.length === 0) {
  bad('no superadmin exists -- you cannot log in. Run supabase/seed.sql');
} else {
  const approved = admins.filter((a) => a.status === 'approved');
  if (approved.length === 0) {
    bad('the superadmin is not approved -- seed.sql needs status = approved');
  } else {
    good(`superadmin(s): ${approved.map((a) => a.username).join(', ')}`);
  }
}

const { data: pend } = await supabase.from('users').select('id').eq('status', 'pending');
good(`${pend?.length ?? 0} account(s) awaiting approval`);

// --- RLS check: the anon key must NOT be able to read users ---------------
console.log('\n=== Row Level Security ===\n');
if (!anon) {
  console.log('  skipped -- no anon key.\n');
} else {
  const anonClient = createClient(url.replace(/\/rest\/?v1\/?$/, ''), anon, {
    auth: { persistSession: false },
  });

  /*
   * The test is "did any row come back?", NOT "was there an error?".
   *
   * When RLS is enabled with no matching policy, PostgREST returns HTTP 200
   * with an empty array -- not a 401 or a permission error. An earlier version
   * of this check looked for an error, concluded anon could read the table, and
   * reported a leak that did not exist. Row count is the real signal.
   */
  const { data: leakedUsers, error: anonUsersErr } = await anonClient
    .from('users')
    .select('*')
    .limit(1);
  if (anonUsersErr) {
    good(`anon cannot read public.users (${anonUsersErr.code})`);
  } else if (leakedUsers && leakedUsers.length > 0) {
    bad(`ANON KEY READ ${leakedUsers.length} ROW(S) FROM public.users -- RLS is not protecting it`);
    console.log('          ' + JSON.stringify(leakedUsers[0]).slice(0, 140));
  } else {
    good('anon sees 0 rows in public.users (RLS is filtering correctly)');
  }

  // The other three must behave the same way: no error, no rows.
  for (const table of ['audit_logs', 'id_counter']) {
    const { data: rows, error: err } = await anonClient.from(table).select('*').limit(1);
    if (err) {
      good(`anon cannot read public.${table} (${err.code})`);
    } else if (rows && rows.length > 0) {
      bad(`ANON KEY READ ${rows.length} ROW(S) FROM public.${table}`);
    } else {
      good(`anon sees 0 rows in public.${table}`);
    }
  }

  // documents MUST be readable, or Realtime delivers nothing.
  const { data: docs, error: docsErr } = await anonClient.from('documents').select('*').limit(1);
  if (docsErr) {
    warn(`anon cannot read documents, so Realtime will deliver nothing: ${docsErr.message}`);
  } else {
    good(
      `anon can read documents (${docs?.length ?? 0} row(s) -- Realtime has what it needs)`,
    );
  }

  const { error: anonWrite } = await anonClient
    .from('documents')
    .insert({ id: 999999, title: 'rls-probe' })
    .select();
  if (!anonWrite) {
    bad('ANON KEY CAN WRITE to documents -- this is a serious problem');
    console.log('          delete the row above and review schema.sql section 7');
  } else {
    good('anon cannot write documents (all mutations go through the service role)');
  }
}

console.log(
  problems > 0
    ? `\n${problems} problem(s), ${warnings} warning(s).\n`
    : `\nAll good. ${warnings} warning(s).\n`,
);
process.exit(problems > 0 ? 1 : 0);