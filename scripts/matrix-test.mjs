/**
 * Generates valid session tokens with the local SESSION_SECRET and probes the
 * middleware matrix. Run against `npm run start` with .env.local present.
 *
 *   node scripts/matrix-test.mjs http://localhost:3112
 */
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:3111';

// Read the secret straight out of .env.local so the tokens are definitely valid.
const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const secret = env.match(/^SESSION_SECRET=(.+)$/m)?.[1]?.trim();
if (!secret) throw new Error('SESSION_SECRET not found in .env.local');

const key = new TextEncoder().encode(secret);

const role = (r) => r[0].toUpperCase() + r.slice(1);
const uuid = (n) => `${n}`.repeat(8).slice(0, 8) + '-1111-1111-1111-111111111111';

async function mint(r, status) {
  return new SignJWT({ username: `u_${r}`, role: r, status })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(uuid(r.length))
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

const CASES = [
  ['user', 'approved'],
  ['user', 'pending'],
  ['user', 'rejected'],
  ['admin', 'approved'],
  ['superadmin', 'approved'],
];

const PAGES = ['/dashboard', '/admin', '/documents', '/register-sheet', '/profile', '/login', '/register'];

for (const [r, status] of CASES) {
  const token = await mint(r, status);
  const label = `${role(r)}/${status}`;

  for (const p of PAGES) {
    const res = await fetch(base + p, {
      redirect: 'manual',
      headers: { Cookie: `dlms_session=${token}` },
    });
    const loc = res.headers.get('location') ?? '';
    console.log(
      label.padEnd(20),
      p.padEnd(12),
      String(res.status).padEnd(5),
      loc,
    );
  }
  console.log('');
}
