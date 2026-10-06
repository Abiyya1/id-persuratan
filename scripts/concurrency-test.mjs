/**
 * Concurrency check for get_next_document_id().
 *
 * Runs N parallel RPC calls against a real Supabase project and asserts every
 * returned ID is unique. This is the one property the whole system rests on,
 * and it cannot be proven by reading the SQL.
 *
 * Requires .env.local with a working NEXT_PUBLIC_SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY and schema.sql applied.
 *
 *   node scripts/concurrency-test.mjs [count]
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const COUNT = Number(process.argv[2] ?? 25);

const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      const k = l.slice(0, i).trim();
      let v = l.slice(i + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      return [k, v];
    }),
);

const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// Confirm the RPC exists before firing anything at it.
const probe = await supabase.rpc('get_next_document_id');
if (probe.error) {
  console.error('Cannot run: get_next_document_id() failed.');
  console.error(' ', probe.error.message);
  console.error('Is schema.sql applied to this project?');
  process.exit(1);
}

const start = probe.data;
console.log(`Firing ${COUNT} concurrent calls. Counter is at ${start}...\n`);

// Fire every call at once -- no awaiting in between, so they genuinely overlap
// and contend for the same row lock.
const results = await Promise.all(
  Array.from({ length: COUNT }, async (_, i) => {
    const { data, error } = await supabase.rpc('get_next_document_id');
    return { i, id: data, error: error?.message };
  }),
);

const failed = results.filter((r) => r.error);
const ids = results.filter((r) => !r.error).map((r) => r.id);

const unique = new Set(ids);
const sorted = [...ids].sort((a, b) => a - b);

// Gaps are expected and documented: a rolled-back transaction burns an ID.
// Duplicates are not acceptable, ever.
const gaps = [];
for (let i = 1; i < sorted.length; i += 1) {
  if (sorted[i] !== sorted[i - 1] + 1) gaps.push(`${sorted[i - 1]} -> ${sorted[i]}`);
}

console.log(`calls      : ${COUNT}`);
console.log(`succeeded  : ${ids.length}`);
console.log(`failed     : ${failed.length}`);
console.log(`unique IDs : ${unique.size}`);
console.log(`range      : ${sorted[0]} .. ${sorted[sorted.length - 1]}`);
console.log(`gaps       : ${gaps.length ? gaps.join(', ') : 'none'}`);

if (failed.length) {
  console.log('\nErrors:');
  for (const f of failed.slice(0, 5)) console.log(`  #${f.i}: ${f.error}`);
}

const noDuplicates = unique.size === ids.length;

console.log(
  `\n${noDuplicates ? 'PASS' : 'FAIL'}  no duplicate IDs across ${ids.length} concurrent calls`,
);

if (!noDuplicates) {
  const seen = new Set();
  const dupes = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  console.log('Duplicates:', dupes.join(', '));
}

console.log(
  `\nNote: ${COUNT} IDs were consumed from your live counter. This test is not reversible.`,
);

process.exit(noDuplicates ? 0 : 1);
