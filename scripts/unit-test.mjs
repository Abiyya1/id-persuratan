/**
 * Pure-function checks for lib/auth.ts validators.
 * These run without a database, so they work on a fresh clone.
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
check('too short', typeof validateUsername('ab'), 'string');
check('minimum length ok', validateUsername('abc'), null);
check('too long', typeof validateUsername('x'.repeat(51)), 'string');
check('spaces rejected', typeof validateUsername('a b'), 'string');
check('emoji rejected', typeof validateUsername('budi😀'), 'string');
check('sql-ish rejected', typeof validateUsername("b';--"), 'string');
check('dot/underscore/hyphen ok', validateUsername('budi.santoso_01-x'), null);
check('max length ok', validateUsername('x'.repeat(50)), null);

// --- Password rules --------------------------------------------------------
console.log('\nvalidatePasswordStrength');
check('too short', typeof validatePasswordStrength('Ab1'), 'string');
check('no digits', typeof validatePasswordStrength('abcdefgh'), 'string');
check('no letters', typeof validatePasswordStrength('12345678'), 'string');
check('too long', typeof validatePasswordStrength('a1'.repeat(101)), 'string');
check('acceptable', validatePasswordStrength('Passw0rd123'), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
