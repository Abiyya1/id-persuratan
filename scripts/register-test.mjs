import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

// Always creates an isolated cluster. Never reads .env.local or consumes live IDs.
const bin = process.env.PG_BIN ?? (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '');
const executable = (name) => bin ? join(bin, name + (process.platform === 'win32' ? '.exe' : '')) : name;
const root = mkdtempSync(join(tmpdir(), 'persuratan-pg-'));
const data = join(root, 'data');
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
let started = false;
function run(name, args, input) {
  const result = spawnSync(executable(name), args, { input, encoding: 'utf8', stdio: name === 'pg_ctl' ? 'ignore' : 'pipe', timeout: 120_000, env: { ...process.env, PGCLIENTENCODING: 'UTF8' } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${name}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const psqlArgs = ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
function sql(text) { return run('psql', [...psqlArgs, '-q'], text); }
function prepareAccountTransaction(args, preflight, mutation, isolation, applicationName = 'account-permission-regression') {
  const child = spawn(executable('psql'), [...args, '-qAt'], { env: { ...process.env, PGCLIENTENCODING: 'UTF8', PGAPPNAME: applicationName } });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const completed = once(child, 'close').then(([code]) => ({ code, stderr }));
  const ready = Promise.race([
    once(lines, 'line').then(([line]) => line),
    completed.then(() => { throw new Error(`Account transaction exited before preflight: ${stderr}`); }),
  ]);
  child.stdin.write(`BEGIN ISOLATION LEVEL ${isolation}; ${preflight};\n`);
  return { ready, completed, commit: () => child.stdin.end(`${mutation}; COMMIT;\n`) };
}
try {
  run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C']);
  started = true;
  run('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -c wal_level=logical`, '-w', 'start']);
  sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
  // Freeze only this disposable cluster's SQL clock so 2026 scenarios stay deterministic.
  sql("CREATE OR REPLACE FUNCTION pg_catalog.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT TIMESTAMPTZ '2026-10-06 08:00:00+00' + coalesce(nullif(current_setting('persuratan_test.clock_offset',true),''),'0')::double precision * INTERVAL '1 second' $$;");
  sql(readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  const migration = new URL('../supabase/migrations/20261006_letter_register.sql', import.meta.url);
  if (existsSync(migration)) sql(readFileSync(migration, 'utf8'));
  const deletionMigration = new URL('../supabase/migrations/20261007_document_delete.sql', import.meta.url);
  if (existsSync(deletionMigration)) sql(readFileSync(deletionMigration, 'utf8'));
  const formMigration = new URL('../supabase/migrations/20261007_form_revisions.sql', import.meta.url);
  sql(readFileSync(formMigration, 'utf8'));
  sql(readFileSync(new URL('../supabase/migrations/20261009_register_settings.sql', import.meta.url), 'utf8'));
  sql(readFileSync(new URL('../supabase/migrations/20261010_superadmin_invariant.sql', import.meta.url), 'utf8'));
  sql(readFileSync(new URL('../supabase/migrations/20261011_document_sort.sql', import.meta.url), 'utf8'));
  sql(readFileSync(new URL('../supabase/migrations/20261012_register_tail_trim.sql', import.meta.url), 'utf8'));
  sql(readFileSync(new URL('./document-sort-test.sql', import.meta.url), 'utf8'));
  console.log('PASS natural document-number ordering, cross-page descending, legacy/suffix keys and service-only invoker permissions');
  console.log(sql(readFileSync(new URL('./register-test.sql', import.meta.url), 'utf8')));
  sql(readFileSync(new URL('./register-delete-test.sql', import.meta.url), 'utf8'));
  console.log('PASS safe deletion, delayed slot release, ownership and original-date number reuse');
  // Simulate an archive created under the previous policy before the forward migration.
  sql("SELECT create_registered_document('11111111-1111-1111-1111-111111111111', (now() AT TIME ZONE 'Asia/Jakarta')::date, 'Form legacy CAT', '{\"kdSurat\":\"600\",\"kdSatker\":\"Pusdatin\",\"ket\":\"CAT\"}'::jsonb);");
  sql(readFileSync(new URL('../supabase/migrations/20261008_required_destination.sql', import.meta.url), 'utf8'));
  sql(readFileSync(new URL('./register-form-test.sql', import.meta.url), 'utf8'));
  console.log('PASS required destination, CAT rejection, non-today MANUAL, WIB midnight and legacy sync-only update guards');
  sql(readFileSync(new URL('./register-settings-test.sql', import.meta.url), 'utf8'));
  console.log('PASS configurable closing/future reserves, dated overrides, role/bounds and frozen-range safety');
  const restorationRegression = readFileSync(new URL('./register-post-trim-test.sql', import.meta.url), 'utf8');
  const beforeRestore = spawnSync(executable('psql'), [...psqlArgs, '-q'], { input: restorationRegression, encoding: 'utf8', timeout: 120_000, env: { ...process.env, PGCLIENTENCODING: 'UTF8' } });
  if (beforeRestore.error) throw beforeRestore.error;
  assert.equal(beforeRestore.status, 3, 'Migration12 must fail the exact post-trim regression');
  assert.match(beforeRestore.stderr, /Post-trim expected today 5117, got 5058/);
  console.log('PASS red regression: migration12 skips elapsed daily reserves and allocates5058');
  sql(`
    INSERT INTO register_days(letter_date,tail_trimmed,revision,synced_revision) VALUES('2026-01-01',true,7,7);
    SELECT set_config('persuratan_test.pre_restore_state',(SELECT to_jsonb(s)::text FROM register_state s WHERE id=1),false);
    SELECT set_config('persuratan_test.pre_restore_private',(SELECT current_val::text FROM id_counter WHERE id=1),false);
    SELECT set_config('persuratan_test.pre_restore_slots',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY number),'[]'::jsonb)::text FROM letter_slots s),false);
    SELECT set_config('persuratan_test.pre_restore_docs',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]'::jsonb)::text FROM documents d),false);
    ${readFileSync(new URL('../supabase/migrations/20261013_post_trim_daily_reserves.sql', import.meta.url), 'utf8')}
    DO $$ BEGIN
      IF NOT (SELECT revision=8 AND synced_revision=7 AND tail_trimmed FROM register_days WHERE letter_date='2026-01-01')
        OR current_setting('persuratan_test.pre_restore_state')::jsonb<>(SELECT to_jsonb(s) FROM register_state s WHERE id=1)
        OR current_setting('persuratan_test.pre_restore_private')::int<>(SELECT current_val FROM id_counter WHERE id=1)
        OR current_setting('persuratan_test.pre_restore_slots')::jsonb<>(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY number),'[]'::jsonb) FROM letter_slots s)
        OR current_setting('persuratan_test.pre_restore_docs')::jsonb<>(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]'::jsonb) FROM documents d)
      THEN RAISE EXCEPTION 'Migration13 residue backfill changed ledger instead of dirtying trimmed projections'; END IF;
    END $$;
    DELETE FROM register_days WHERE letter_date='2026-01-01';
  `);
  console.log(sql(restorationRegression));
  sql(readFileSync(new URL('./register-settings-test.sql', import.meta.url), 'utf8'));
  sql(readFileSync(new URL('./register-form-test.sql', import.meta.url), 'utf8'));
  console.log('PASS restored allocator preserves settings bounds/roles, active frozen ranges and form/clock validation');
  console.log(sql(readFileSync(new URL('./register-trim-test.sql', import.meta.url), 'utf8')));
  // Independent psql connections contend on the real allocation lock.
  const results = await Promise.all(Array.from({ length: 25 }, () => new Promise((resolve, reject) => {
    const child = spawn(executable('psql'), [...psqlArgs, '-At', '-c', "SELECT create_registered_document('11111111-1111-1111-1111-111111111111', (now() AT TIME ZONE 'Asia/Jakarta')::date + 5, 'Concurrent', '{\"kdSurat\":\"600\",\"kdSatker\":\"Pusdatin\",\"tujuanSurat\":\"Test\",\"ket\":\"MANUAL\"}'::jsonb)->>'surat_number';"], { env: { ...process.env, PGCLIENTENCODING: 'UTF8' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
  })));
  assert.equal(new Set(results).size, 25, 'Concurrent requests must receive different official numbers');
  console.log('PASS 25 concurrent allocations: unique numbers');
  sql(`
    TRUNCATE public.letter_slots,public.register_days,public.documents,public.register_day_targets;
    UPDATE public.register_state SET initialized=true,current_number=100,allocation_floor=100,start_date='2026-10-06',closed_through='2026-10-05' WHERE id=1;
    UPDATE public.register_sync_lease SET owner=NULL,expires_at=NULL WHERE id=1;
    SELECT create_registered_document('11111111-1111-1111-1111-111111111111','2026-10-06','Concurrent trim survivor','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}');
    SELECT create_registered_document('11111111-1111-1111-1111-111111111111','2026-10-06','Concurrent trim victim','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}');
    SELECT reserve_letter_slots('2026-10-06',3);
    SELECT delete_registered_document('11111111-1111-1111-1111-111111111111',(SELECT id FROM documents WHERE surat_number='102'));
    SELECT acquire_register_sync('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  `);
  const clearing = spawn(executable('psql'), [...psqlArgs, '-qAt'], { env: { ...process.env, PGCLIENTENCODING: 'UTF8' } });
  let clearingError = '';
  clearing.stderr.on('data', (chunk) => { clearingError += chunk; });
  const clearingLines = createInterface({ input: clearing.stdout });
  const clearingDone = once(clearing, 'close');
  const clearReady = Promise.race([
    once(clearingLines, 'line').then(([line]) => line),
    clearingDone.then(() => { throw new Error(`Clear transaction exited early: ${clearingError}`); }),
  ]);
  clearing.stdin.write("BEGIN; SELECT acknowledge_register_days('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',(SELECT jsonb_agg(jsonb_build_object('letter_date',letter_date,'revision',revision)) FROM register_days));\n");
  assert.equal(await clearReady, 't', 'Clear acknowledgement holds allocator lock until commit');
  const afterClear = new Promise((resolve, reject) => {
    const child = spawn(executable('psql'), [...psqlArgs, '-qAt', '-c', `SELECT create_registered_document('11111111-1111-1111-1111-111111111111','2026-10-06','Allocated after clear','{"kdSurat":"600","kdSatker":"Pusdatin","tujuanSurat":"Test","ket":"MANUAL"}')->>'surat_number';`], { env: { ...process.env, PGCLIENTENCODING: 'UTF8', PGAPPNAME: 'register-trim-concurrent-allocation' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
  });
  sql(`DO $$ BEGIN FOR n IN 1..100 LOOP
    PERFORM pg_stat_clear_snapshot();
    IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='register-trim-concurrent-allocation' AND wait_event_type='Lock') THEN RETURN; END IF;
    PERFORM pg_sleep(0.05);
  END LOOP; RAISE EXCEPTION 'Concurrent allocation never waited for trim transaction'; END $$;`);
  clearing.stdin.end('COMMIT;\n');
  assert.equal((await clearingDone)[0], 0, clearingError);
  assert.equal(await afterClear, '102', 'Waiting allocation uses the cleared next number, not the old high-water tail');
  assert.equal(run('psql', [...psqlArgs, '-qAt'], "SELECT count(*) FROM documents d JOIN letter_slots s ON s.document_id=d.id WHERE d.title='Allocated after clear' AND s.number='102' AND s.occupied AND NOT s.retiring;").trim(), '1');
  console.log('PASS real concurrent clear/allocation serialization preserves new occupied slot');
  const accountMigration = readFileSync(new URL('../supabase/migrations/20261014_single_superadmin_approvals.sql', import.meta.url), 'utf8');
  const accountPreservation = `SELECT jsonb_build_object(
    'users',(SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM public.users u),
    'documents',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.documents d),
    'slots',(SELECT jsonb_agg(to_jsonb(s) ORDER BY number) FROM public.letter_slots s),
    'state',(SELECT to_jsonb(s) FROM public.register_state s WHERE id=1),
    'counter',(SELECT to_jsonb(c) FROM public.id_counter c WHERE id=1),
    'audits',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.audit_logs a));`;
  const accountBefore = sql(accountPreservation);
  sql(accountMigration);
  assert.equal(sql(accountPreservation), accountBefore, 'Migration14 must preserve all existing accounts, letters, slots, allocator state, counter and audits');
  console.log('PASS forward single-superadmin migration preserves existing accounts and register data');
  sql('CREATE DATABASE users_invariant_test;');
  const usersArgs = [...psqlArgs];
  usersArgs[usersArgs.indexOf('-d') + 1] = 'users_invariant_test';
  function usersSql(text) { return run('psql', [...usersArgs, '-qAt'], text); }
  usersSql(readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  usersSql(readFileSync(new URL('../supabase/migrations/20261010_superadmin_invariant.sql', import.meta.url), 'utf8'));
  const userIds = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'];
  usersSql(`INSERT INTO public.users(id,username,password_hash,role,status) VALUES ('${userIds[0]}','invariant_one','isolated-test-hash','superadmin','approved'),('${userIds[1]}','invariant_two','isolated-test-hash','superadmin','approved');`);
  usersSql("INSERT INTO public.users(username,password_hash,role,status) VALUES ('legacy_pending_root','unused','superadmin','pending'),('legacy_rejected_root','unused','superadmin','rejected');");
  const rootsBeforeAbort = usersSql('SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM public.users u;');
  const abortedMigration = spawnSync(executable('psql'), [...usersArgs, '-q'], { input: accountMigration, encoding: 'utf8', timeout: 120_000, env: { ...process.env, PGCLIENTENCODING: 'UTF8' } });
  if (abortedMigration.error) throw abortedMigration.error;
  assert.equal(abortedMigration.status, 3, 'Existing multiple roots must abort migration instead of choosing one');
  assert.match(abortedMigration.stderr, /SINGLE_SUPERADMIN_REQUIRED/);
  assert.match(abortedMigration.stderr, /database owner/);
  assert.equal(usersSql('SELECT jsonb_agg(to_jsonb(u) ORDER BY id) FROM public.users u;'), rootsBeforeAbort, 'An aborted migration must not delete, demote or otherwise rewrite any existing root');
  assert.equal(usersSql("SELECT to_regclass('public.users_single_superadmin_idx') IS NULL;").trim(), 't', 'Aborted migration must not install partial guards');
  usersSql("DELETE FROM public.users WHERE status IN ('pending','rejected');");
  for (const isolation of ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']) {
    for (const mutation of ["UPDATE public.users SET role='user'", "UPDATE public.users SET status='rejected'", 'DELETE FROM public.users']) {
      usersSql(`UPDATE public.users SET role='superadmin',status='approved'; INSERT INTO public.users(id,username,password_hash,role,status) VALUES ('${userIds[0]}','invariant_one','isolated-test-hash','superadmin','approved'),('${userIds[1]}','invariant_two','isolated-test-hash','superadmin','approved') ON CONFLICT(id) DO NOTHING;`);
      const requests = userIds.map((id) => prepareAccountTransaction(usersArgs,
        "SELECT count(*) FROM public.users WHERE role='superadmin' AND status='approved'", `${mutation} WHERE id='${id}'`, isolation));
      assert.deepEqual(await Promise.all(requests.map((request) => request.ready)), ['2', '2'], 'Both administrators complete the same count preflight before either mutation');
      requests.forEach((request) => request.commit());
      const outcomes = await Promise.all(requests.map((request) => request.completed));
      const remaining = Number(usersSql("SELECT count(*) FROM public.users WHERE role='superadmin' AND status='approved';").trim());
      assert.equal(remaining, 1, `${isolation}: ${mutation}: concurrent removals must retain one approved superadmin`);
      assert.deepEqual(outcomes.map((outcome) => outcome.code).sort(), [0, 3], 'Exactly one conflicting removal must be rejected');
      assert.match(outcomes.find((outcome) => outcome.code === 3)?.stderr ?? '', /LAST_SUPERADMIN|could not serialize access/);
    }
  }
  console.log('PASS retained migration10 concurrent role/status/deletion last-active-root protections');
  usersSql(accountMigration);
  usersSql('GRANT SELECT,INSERT,UPDATE,DELETE ON public.users,public.audit_logs TO service_role; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;');
  usersSql(readFileSync(new URL('./users-invariant-test.sql', import.meta.url), 'utf8'));
  for (const [index, isolation] of ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'].entries()) {
    const database = `users_bootstrap_${index}`;
    sql(`CREATE DATABASE ${database};`);
    const bootstrapArgs = [...psqlArgs];
    bootstrapArgs[bootstrapArgs.indexOf('-d') + 1] = database;
    run('psql', [...bootstrapArgs, '-q'], readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
    run('psql', [...bootstrapArgs, '-q'], readFileSync(new URL('../supabase/migrations/20261010_superadmin_invariant.sql', import.meta.url), 'utf8'));
    run('psql', [...bootstrapArgs, '-q'], accountMigration);
    run('psql', [...bootstrapArgs, '-q'], `
      INSERT INTO public.users(id,username,password_hash,role,status) VALUES('ffffffff-ffff-ffff-ffff-ffffffffffff','pre_bootstrap_admin','unused','admin','approved');
      DO $$ BEGIN
        BEGIN
          UPDATE public.users SET role='superadmin' WHERE username='pre_bootstrap_admin';
          RAISE EXCEPTION 'A pre-bootstrap account was promoted to root';
        EXCEPTION WHEN check_violation THEN IF SQLERRM<>'SUPERADMIN_PROTECTED' THEN RAISE; END IF;
        END;
        BEGIN
          PERFORM public.create_managed_user_account('ffffffff-ffff-ffff-ffff-ffffffffffff','forbidden_first_root','unused','superadmin');
          RAISE EXCEPTION 'Application created a first root without a root principal';
        EXCEPTION WHEN insufficient_privilege THEN NULL;
        END;
      END $$;`);
    const bootstraps = ['approved', index === 1 ? 'pending' : 'rejected'].map((status, candidate) => prepareAccountTransaction(
      bootstrapArgs, "SELECT count(*) FROM public.users WHERE role='superadmin'",
      `INSERT INTO public.users(username,password_hash,role,status) VALUES('bootstrap_${candidate}','unused','superadmin','${status}')`, isolation));
    assert.deepEqual(await Promise.all(bootstraps.map((request) => request.ready)), ['0', '0'], 'Both bootstrap candidates must see an empty database before inserting');
    bootstraps.forEach((request) => request.commit());
    const outcomes = await Promise.all(bootstraps.map((request) => request.completed));
    assert.deepEqual(outcomes.map((outcome) => outcome.code).sort(), [0, 3], `${isolation}: exactly one concurrent bootstrap may succeed`);
    assert.match(outcomes.find((outcome) => outcome.code === 3)?.stderr ?? '', /users_single_superadmin_idx|could not serialize access/);
    assert.equal(run('psql', [...bootstrapArgs, '-qAt'], "SELECT count(*) FROM public.users WHERE role='superadmin';").trim(), '1', 'The root uniqueness invariant includes every status');
    run('psql', [...bootstrapArgs, '-q'], `
      DO $$ DECLARE root_id UUID; root_status TEXT; operation INT; BEGIN
        SELECT id,status INTO root_id,root_status FROM public.users WHERE role='superadmin';
        FOR operation IN 1..3 LOOP
          BEGIN
            CASE operation
              WHEN 1 THEN UPDATE public.users SET role='user' WHERE id=root_id;
              WHEN 2 THEN UPDATE public.users SET status=CASE root_status WHEN 'approved' THEN 'rejected' ELSE 'approved' END WHERE id=root_id;
              WHEN 3 THEN DELETE FROM public.users WHERE id=root_id;
            END CASE;
            RAISE EXCEPTION 'Bootstrapped root loss accepted';
          EXCEPTION WHEN check_violation THEN IF SQLERRM NOT IN ('SUPERADMIN_PROTECTED','LAST_SUPERADMIN') THEN RAISE; END IF;
          END;
        END LOOP;
        IF NOT EXISTS(SELECT 1 FROM public.users WHERE id=root_id AND role='superadmin' AND status=root_status) THEN
          RAISE EXCEPTION 'Protected bootstrap root changed';
        END IF;
      END $$;`);
  }
  const actors = ['cccccccc-cccc-cccc-cccc-cccccccccccc', 'dddddddd-dddd-dddd-dddd-dddddddddddd'];
  const registrationId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  usersSql(`INSERT INTO public.users(id,username,password_hash,role,status) VALUES
    ('${actors[0]}','decision_admin_one','unused','admin','approved'),
    ('${actors[1]}','decision_admin_two','unused','admin','approved'),
    ('${registrationId}','decision_registration','unused','user','pending');`);
  for (const isolation of ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']) {
    usersSql(`UPDATE public.users SET role='user',status='pending' WHERE id='${registrationId}'; DELETE FROM public.audit_logs WHERE target_id='${registrationId}';`);
    const decisions = actors.map((actor, index) => prepareAccountTransaction(
      usersArgs, `SELECT status FROM public.users WHERE id='${registrationId}'`,
      `SET LOCAL ROLE service_role; SELECT public.update_managed_user_account('${actor}','${registrationId}','{"status":"${index === 0 ? 'approved' : 'rejected'}"}')`, isolation));
    assert.deepEqual(await Promise.all(decisions.map((request) => request.ready)), ['pending', 'pending']);
    decisions.forEach((request) => request.commit());
    const outcomes = await Promise.all(decisions.map((request) => request.completed));
    assert.deepEqual(outcomes.map((outcome) => outcome.code).sort(), [0, 3], `${isolation}: competing registration decisions must have one winner`);
    assert.match(outcomes.find((outcome) => outcome.code === 3)?.stderr ?? '', /PENDING_REGISTRATION_REQUIRED|could not serialize access/);
    assert.equal(usersSql(`SELECT count(*) FROM public.audit_logs WHERE target_id='${registrationId}' AND action IN ('APPROVE_USER','REJECT_USER');`).trim(), '1', 'Only the committed decision may emit an audit');
    assert.equal(usersSql(`SELECT role='user' AND status IN ('approved','rejected') FROM public.users WHERE id='${registrationId}';`).trim(), 't');
    for (const mutation of ["UPDATE public.users SET role='user'", "UPDATE public.users SET status='rejected'", 'DELETE FROM public.users']) {
      usersSql(`INSERT INTO public.users(id,username,password_hash,role,status) VALUES('${actors[0]}','decision_admin_one','unused','admin','approved') ON CONFLICT(id) DO UPDATE SET role='admin',status='approved'; UPDATE public.users SET role='user',status='pending' WHERE id='${registrationId}'; DELETE FROM public.audit_logs WHERE target_id='${registrationId}';`);
      const revocation = prepareAccountTransaction(usersArgs, `${mutation} WHERE id='${actors[0]}'; SELECT 'held'`, 'SELECT 1', isolation, 'account-actor-revocation');
      assert.equal(await revocation.ready, 'held');
      const decision = prepareAccountTransaction(usersArgs, `SELECT status FROM public.users WHERE id='${registrationId}'`,
        `SET LOCAL ROLE service_role; SELECT public.update_managed_user_account('${actors[0]}','${registrationId}','{"status":"approved"}')`, isolation, 'account-revoked-decision');
      assert.equal(await decision.ready, 'pending');
      decision.commit();
      usersSql(`DO $$ BEGIN FOR n IN 1..100 LOOP
        PERFORM pg_stat_clear_snapshot();
        IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='account-revoked-decision' AND wait_event_type='Lock') THEN RETURN; END IF;
        PERFORM pg_sleep(0.05);
      END LOOP; RAISE EXCEPTION 'Decision never waited for the actor mutation lock'; END $$;`);
      revocation.commit();
      assert.equal((await revocation.completed).code, 0);
      const denied = await decision.completed;
      assert.equal(denied.code, 3, `${isolation}: revoked/deleted principals cannot commit a waiting decision`);
      assert.match(denied.stderr, /FORBIDDEN|could not serialize access/);
      assert.equal(usersSql(`SELECT role='user' AND status='pending' FROM public.users WHERE id='${registrationId}';`).trim(), 't');
      assert.equal(usersSql(`SELECT count(*) FROM public.audit_logs WHERE target_id='${registrationId}';`).trim(), '0', 'A mutation-time revocation must not emit a false audit');
    }
    usersSql(`INSERT INTO public.users(id,username,password_hash,role,status) VALUES('${actors[0]}','decision_admin_one','unused','admin','approved') ON CONFLICT(id) DO UPDATE SET role='admin',status='approved';`);
    const escalation = prepareAccountTransaction(usersArgs, `UPDATE public.users SET role='admin' WHERE id='${registrationId}'; SELECT 'held'`, 'SELECT 1', isolation, 'account-target-promotion');
    assert.equal(await escalation.ready, 'held');
    const staleDecision = prepareAccountTransaction(usersArgs, `SELECT role||':'||status FROM public.users WHERE id='${registrationId}'`,
      `SET LOCAL ROLE service_role; SELECT public.update_managed_user_account('${actors[0]}','${registrationId}','{"status":"approved"}')`, isolation, 'account-promoted-target-decision');
    assert.equal(await staleDecision.ready, 'user:pending');
    staleDecision.commit();
    usersSql(`DO $$ BEGIN FOR n IN 1..100 LOOP
      PERFORM pg_stat_clear_snapshot();
      IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='account-promoted-target-decision' AND wait_event_type='Lock') THEN RETURN; END IF;
      PERFORM pg_sleep(0.05);
    END LOOP; RAISE EXCEPTION 'Decision never waited for the target promotion lock'; END $$;`);
    escalation.commit();
    assert.equal((await escalation.completed).code, 0);
    const rejectedEscalation = await staleDecision.completed;
    assert.equal(rejectedEscalation.code, 3, 'A stale pending-user view must not authorize an admin-role target');
    assert.match(rejectedEscalation.stderr, /FORBIDDEN|could not serialize access/);
    assert.equal(usersSql(`SELECT role='admin' AND status='pending' FROM public.users WHERE id='${registrationId}';`).trim(), 't');
    assert.equal(usersSql(`SELECT count(*) FROM public.audit_logs WHERE target_id='${registrationId}';`).trim(), '0');
  }
  console.log('PASS concurrent bootstrap uniqueness, competing pending decisions, principal revocation/deletion and target-role races across all transaction isolation levels');
  console.log('PASS isolated PostgreSQL register and account permission checks');
} finally {
  if (started && existsSync(join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
