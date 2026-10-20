import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import ts from 'typescript';

function gate() {
  const events = new EventEmitter();
  const promise = once(events, 'response').then(([value]) => value);
  return { promise, resolve: (value) => events.emit('response', value), reject: (error) => events.emit('error', error) };
}

async function loader(component) {
  const source = ts.createSourceFile(component, readFileSync(new URL(`../src/components/${component}.tsx`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === component);
  const load = declaration.body.statements.filter(ts.isVariableStatement).flatMap((node) => node.declarationList.declarations).find((node) => node.name.getText(source) === 'load');
  const callback = load.initializer.arguments[0].getText(source);
  const compiled = ts.transpileModule(`export default ({fetch,requestId,mounted,setLoading,setUsers,setLogs,setTotalPages,setTotal,onToast,filter,isSuperadmin=true,page,action,search=''}) => (${callback});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  return (await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)).default;
}

const latest = { id: 'latest', username: 'latest_user', role: 'user', status: 'approved', action: 'PROFILE_PASSWORD', target_id: 'latest', details: {}, created_at: '2026-10-10T00:00:00Z' };
const previous = { ...latest, id: 'previous', username: 'previous_user', status: 'pending', action: 'LOGIN', target_id: 'previous' };
const response = (row) => ({ ok: true, json: async () => ({ users: [row], logs: [row], pagination: { totalPages: row === latest ? 1 : 3, total: row === latest ? 1 : 99 } }) });

for (const component of ['AuditTab', 'UsersTab']) {
  const create = await loader(component);
  for (const staleFailure of [false, true]) {
    const old = gate(), current = gate();
    const view = { rows: [], loading: false, pages: 1, total: 0, errors: [] };
    const scope = {
      requestId: { current: 0 }, mounted: { current: true }, page: 1, action: '', filter: 'pending',
      isSuperadmin: true,
      setLoading: (value) => { view.loading = value; },
      setUsers: (value) => { view.rows = value; }, setLogs: (value) => { view.rows = value; },
      setTotalPages: (value) => { view.pages = value; }, setTotal: (value) => { view.total = value; },
      onToast: (value) => { view.errors.push(value); },
    };
    const oldRequest = create({ ...scope, fetch: () => old.promise })();
    const currentRequest = create({ ...scope, action: 'PROFILE_PASSWORD', search: 'latest_user', filter: 'approved', fetch: () => current.promise })();
    if (staleFailure) {
      old.reject(new Error('superseded request failed'));
      await oldRequest;
      assert.equal(view.loading, true, `${component}: stale failure must not hide the newer loading state`);
      assert.deepEqual(view.errors, [], `${component}: stale failure must not show an obsolete error`);
    }
    current.resolve(response(latest));
    await currentRequest;
    if (!staleFailure) { old.resolve(response(previous)); await oldRequest; }
    assert.deepEqual(view.rows, [latest], `${component}: the latest selection must retain its rows`);
    assert.equal(view.loading, false);
    assert.deepEqual(view.errors, []);
    if (component === 'AuditTab') { assert.equal(view.pages, 1); assert.equal(view.total, 1); }
  }
}
const createUsersLoad = await loader('UsersTab');
for (const isSuperadmin of [false, true]) {
  const delayed = gate();
  const scope = { requestId: { current: 0 }, mounted: { current: true }, filter: 'approved', isSuperadmin };
  const writes = [];
  let requestedUrl;
  const request = createUsersLoad({
    ...scope, fetch: (url) => { requestedUrl = url; return delayed.promise; },
    setLoading: (value) => writes.push(['loading', value]),
    setUsers: (value) => writes.push(['users', value]),
    onToast: (value) => writes.push(['toast', value]),
  })();
  const url = new URL(requestedUrl, 'http://isolated.invalid');
  assert.equal(url.pathname, '/api/admin/users');
  assert.equal(url.searchParams.get('status'), isSuperadmin ? 'approved' : 'pending', 'Admin UI requests only pending registrations');
  scope.mounted.current = false;
  ++scope.requestId.current;
  delayed.resolve(response(latest));
  await request;
  assert.deepEqual(writes, [['loading', true]], 'Unmounted lists cannot receive rows, errors, or loading updates');
}
console.log('PASS admin list ordering: stale success/error cannot replace current rows, pagination, loading or error feedback');
