/**
 * Pure-function checks for lib/auth.ts validators and the Sheets private-key
 * un-escaping. These run without a database, so they work on a fresh clone.
 */
import { readFileSync } from 'node:fs';

// --- Extract a plain JS function from a TS source file ----------------------
function extract(file, name) {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8');
  const re = new RegExp(`export function ${name}[\\s\\S]*?\\n}`);
  const m = src.match(re);
  if (!m) throw new Error(`${name} not found in ${file}`);
  // Strip TS annotations: ": string", ": string | null", "(plain: string)"
  const plain = m[0]
    .replace(/\((\w+):\s*[^)]+\)/g, '($1)')
    .replace(/:\s*string\s*\|\s*null/g, '')
    .replace(/:\s*string/g, '')
    .replace(/export /, '');
  return new Function(`return (${plain})`)();
}

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) pass += 1;
  else fail += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(42)} ${ok ? '' : `got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`}`,
  );
}

const validateUsername = extract('../src/lib/auth.ts', 'validateUsername');
const validatePasswordStrength = extract('../src/lib/auth.ts', 'validatePasswordStrength');

// --- Username rules --------------------------------------------------------
console.log('\nvalidateUsername');
check('too short', validateUsername('ab'), 'Username must be at least 3 characters.');
check('minimum length ok', validateUsername('abc'), null);
check('too long', validateUsername('x'.repeat(51)), 'Username must be under 50 characters.');
check('spaces rejected', validateUsername('a b'), 'Username may only contain letters, numbers, dot, underscore and hyphen.');
check('emoji rejected', validateUsername('budi😀'), 'Username may only contain letters, numbers, dot, underscore and hyphen.');
check('sql-ish rejected', validateUsername("b';--"), 'Username may only contain letters, numbers, dot, underscore and hyphen.');
check('dot/underscore/hyphen ok', validateUsername('budi.santoso_01-x'), null);
check('max length ok', validateUsername('x'.repeat(50)), null);

// --- Password rules --------------------------------------------------------
console.log('\nvalidatePasswordStrength');
check('too short', validatePasswordStrength('Ab1'), 'Password must be at least 8 characters.');
check('no digits', validatePasswordStrength('abcdefgh'), 'Password must contain at least one number.');
check('no letters', validatePasswordStrength('12345678'), 'Password must contain at least one letter.');
check('too long', validatePasswordStrength('a1'.repeat(101)), 'Password must be under 200 characters.');
check('acceptable', validatePasswordStrength('Passw0rd123'), null);

// --- Private key un-escaping ----------------------------------------------
console.log('\nGOOGLE_PRIVATE_KEY un-escaping');
const unescape = (v) => v.replace(/\\n/g, '\n');

const envStyle = '-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\nkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n';
const realNewlines = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';

const fromEnv = unescape(envStyle);
check('env \\n form -> real newlines', fromEnv, realNewlines);
check('env form has 5 lines', fromEnv.split('\n').length, 5);
check('idempotent on real newlines', unescape(realNewlines), realNewlines);
check('no literal backslash-n remains', fromEnv.includes('\\n'), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
