#!/usr/bin/env node
/**
 * Generate a bcrypt hash for supabase/seed.sql.
 *
 *   npm run hash-password -- "MyPassword123"
 *
 * Uses bcryptjs (pure JS, no native build) so it runs anywhere Node does.
 * Same library the app uses at runtime, so the hash is guaranteed compatible.
 */
import bcrypt from 'bcryptjs';

const password = process.argv[2];

if (!password) {
  console.error('Usage: npm run hash-password -- "your-password"');
  console.error('       Add quotes if the password contains spaces or symbols.');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Refusing to hash a password shorter than 8 characters.');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);

console.log('\nPaste this into supabase/seed.sql in place of __HASH_ME__:\n');
console.log(hash);
console.log('\nVerify a password against it later with:');
console.log(`  node -e "import('bcryptjs').then(async b => console.log(await b.compare('${password}', '${hash}')))"`);
console.log('');
