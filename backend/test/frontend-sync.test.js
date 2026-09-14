const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const clone = x => JSON.parse(JSON.stringify(x));
const initial = () => ({ projects: [{ id: 'p1', name: 'Project', tasks: [
  { id: 't1', title: 'Task one', status: 'not-started' },
  { id: 't2', title: 'Task two', status: 'not-started' },
] }], teamMembers: [], taskTemplates: [] });
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => 'application/json' },
  json: async () => clone(body), text: async () => JSON.stringify(body),
});

function browser(state = initial(), storage = new Map()) {
  const handlers = {}, timers = [];
  const element = () => ({ classList: { add() {}, toggle() {} }, style: {},
    querySelector: () => element(), addEventListener() {}, appendChild() {}, remove() {} });
  const context = {
    console: { log() {}, warn() {} }, state: clone(state),
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, setInterval() {},
    document: { querySelector: () => null, getElementById: () => null,
      createElement: element, head: { appendChild(el) { if (el.onload) el.onload(); } },
      body: element(), addEventListener: (event, fn) => { handlers[event] = fn; } },
    localStorage: { getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    api: { enabled: false },
  };
  context.window = context;
  vm.createContext(context);
  context.load = name => vm.runInContext(fs.readFileSync(path.join(__dirname, '../../frontend/js', name), 'utf8'), context);
  context.receive = async payload => {
    context.auth = { token: 'test', user: { id: 'user' } };
    context.io = () => ({ on: (event, fn) => { handlers[event] = fn; }, emit() {} });
    context.load('realtime.js');
    handlers.DOMContentLoaded();
    await Promise.resolve(); await Promise.resolve();
    context.receive = async next => { handlers['state:updated'](clone(next)); timers.pop()(); };
    await context.receive(payload);
  };
  return context;
}

test('remote updates preserve unsaved local edits and do not bless them as synced', async () => {
  const b = browser(); b.load('sync-integration.js');
  b.lastSyncedState = clone(b.state);
  b.state.projects[0].tasks[0].title = 'Pending title';
  const writes = [];
  b.api = { enabled: true, cacheState() {}, setStateVersion() {}, putTaskState: async (pid, task) => writes.push(clone(task)) };
  await b.receive({ state: {}, version: 2, taskUpsert: { projectId: 'p1', task: { id: 't2', title: 'Remote title', status: 'done' } } });
  assert.equal(b.state.projects[0].tasks[0].title, 'Pending title');
  assert.equal(b.lastSyncedState.projects[0].tasks[0].title, 'Task one');
  await b.performIncrementalSync();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].title, 'Pending title');
  assert.equal(b.lastSyncedState.projects[0].tasks.find(t => t.id === 't2').title, 'Remote title');
  // The live UI and baseline must not share mutable task objects.
  b.state.projects[0].tasks[1].title = 'Another edit';
  assert.notEqual(b.lastSyncedState.projects[0].tasks[1].title, 'Another edit');
});

test('whole-project broadcasts merge different task edits and report overlapping edits', async () => {
  const b = browser(); b.lastSyncedState = clone(b.state);
  b.state.projects[0].tasks[0].title = 'Local title';
  const remote = initial(); remote.projects[0].tasks[1].status = 'done';
  let notices = 0;
  b.api = { enabled: true, cacheState() {}, setStateVersion() {}, showConflictBanner() { notices++; } };
  await b.receive({ state: remote, version: 2 });
  assert.equal(b.state.projects[0].tasks[0].title, 'Local title');
  assert.equal(b.state.projects[0].tasks[1].status, 'done');
  assert.equal(notices, 0);
  await b.receive({ state: {}, version: 3, taskUpsert: { projectId: 'p1', task: { id: 't1', title: 'Remote overlapping title', status: 'not-started' } } });
  assert.equal(b.state.projects[0].tasks[0].title, 'Remote overlapping title');
  assert.equal(notices, 1);
});

test('remote sibling edits during an in-flight save survive its acknowledgement', async () => {
  const b = browser(); b.load('sync-integration.js'); b.lastSyncedState = clone(b.state);
  b.state.projects[0].tasks[0].title = 'Local';
  let writes = 0;
  b.api = { enabled: true, cacheState() {}, setStateVersion() {}, putTaskState: async () => {
    writes++;
    await b.receive({ state: {}, version: 3, taskUpsert: { projectId: 'p1', task: { id: 't2', title: 'Remote', status: 'done' } } });
  } };
  await b.performIncrementalSync();
  assert.equal(b.lastSyncedState.projects[0].tasks.find(t => t.id === 't2').title, 'Remote');
  await b.performIncrementalSync();
  assert.equal(writes, 1);
});

test('conflicting project writes fetch current data once and never retry a stale replacement', async () => {
  const b = browser(); let writes = 0, reads = 0;
  const remote = initial(); remote.projects[0].tasks.push({ id: 'new', title: 'Teammate task' });
  b.fetch = async (url, opts) => {
    if (url.endsWith('/health')) return response({ ok: true });
    if (opts.method === 'PUT') { writes++; return response({ code: 'VERSION_CONFLICT', currentVersion: 2 }, 409); }
    reads++; return response({ state: remote, version: 2 });
  };
  b.load('api.js'); b.api.setStateVersion(1);
  await assert.rejects(b.api.putProjectState(initial().projects[0]), e => e.status === 409);
  assert.equal(writes, 1); assert.equal(reads, 1);
  assert.ok(b.state.projects[0].tasks.find(t => t.id === 'new'));
});

test('queued tasks use the merged live state after a remote update during an earlier PUT', async () => {
  const b = browser(); b.load('sync-integration.js'); b.lastSyncedState = clone(b.state);
  b.state.projects[0].tasks.forEach(task => { task.status = 'done'; });
  const writes = [];
  b.api = { enabled: true, cacheState() {}, setStateVersion() {}, putTaskState: async (_pid, task) => {
    writes.push(clone(task));
    if (task.id === 't1') await b.receive({ state: {}, version: 3, taskUpsert: {
      projectId: 'p1', task: { id: 't2', title: 'Teammate title', status: 'not-started' },
    } });
  } };
  await b.performIncrementalSync();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].title, 'Teammate title', 'queued payload must not undo the teammate edit');
  assert.equal(writes[1].status, 'done', 'non-overlapping pending edit is still saved');
});

test('failed conflict refetch does not advance the version for stale writes', async () => {
  const b = browser();
  b.fetch = async (url, opts) => {
    if (url.endsWith('/health')) return response({ ok: true });
    if (opts.method === 'PUT') return response({ code: 'VERSION_CONFLICT', currentVersion: 8 }, 409);
    throw Error('offline');
  };
  b.load('api.js'); b.api.setStateVersion(1);
  await assert.rejects(b.api.putProjectState(initial().projects[0]));
  assert.equal(b.api.stateVersion, 1);
});

test('a conflicting sync stops before later stale tasks can be submitted', async () => {
  const b = browser(); b.load('sync-integration.js'); b.lastSyncedState = clone(b.state);
  b.state.projects[0].tasks.forEach(t => { t.status = 'done'; });
  let calls = 0;
  b.api = { enabled: true, putTaskState: async () => { calls++; throw Object.assign(Error('conflict'), { status: 409 }); } };
  await b.performIncrementalSync();
  assert.equal(calls, 1);
});

test('startup stores fetched data with its version before the next conditional load', async () => {
  const storage = new Map([['sbg_precon_tracker_v3', JSON.stringify(initial())], ['sbg_state_version', '1']]);
  const b = browser(initial(), storage); const remote = initial(); remote.projects[0].name = 'New name';
  b.fetch = async (url, opts) => {
    if (url.endsWith('/health')) return response({ ok: true });
    return opts.headers['If-None-Match'] === '"v2"' ? response(null, 304) : response({ state: remote, version: 2 });
  };
  b.load('api.js'); b.api.enabled = false; b.load('sync-integration.js'); b.api.enabled = true;
  await b.syncStateFromServer();
  assert.equal(JSON.parse(storage.get('sbg_precon_tracker_v3')).projects[0].name, 'New name');
  assert.equal(storage.get('sbg_state_version'), '2');
  b.state = JSON.parse(storage.get('sbg_precon_tracker_v3'));
  assert.equal(await b.syncStateFromServer(), false);
  assert.equal(b.state.projects[0].name, 'New name');
});

test('failed cache persistence cannot pair old data with a newer version', async () => {
  const b = browser(); const headers = [];
  b.fetch = async (url, opts) => {
    if (url.endsWith('/health')) return response({ ok: true });
    headers.push(opts.headers); return response({ state: initial(), version: 2 });
  };
  b.load('api.js'); b.api.setStateVersion(1); b.api.cacheState(b.state);
  await b.api.getState(); // version 2 is not cacheable before storing its data
  b.localStorage.setItem = () => { throw Error('quota'); };
  assert.equal(b.api.cacheState(b.state), false);
  await b.api.getState();
  assert.equal(headers[1]['If-None-Match'], undefined);
});

test('legacy and empty caches fetch full state even when their saved version matches', async () => {
  for (const empty of [false, true]) {
    const cached = empty ? { projects: [] } : initial();
    const storage = new Map([['sbg_precon_tracker_v3', JSON.stringify(cached)], ['sbg_state_version', '2']]);
    if (empty) storage.set('sbg_state_cache_format', '2');
    const b = browser(cached, storage);
    let conditional;
    b.fetch = async (url, opts) => {
      if (url.endsWith('/health')) return response({ ok: true });
      conditional = opts.headers['If-None-Match'];
      return response({ state: initial(), version: 2 });
    };
    b.load('api.js');
    const loaded = await b.api.getState();
    assert.equal(conditional, undefined);
    assert.equal(loaded.state.projects.length, 1);
  }
});

test('an authoritative CRUD deletion removes the project from local state and baseline', async () => {
  const b = browser(); b.lastSyncedState = clone(b.state);
  await b.receive({ state: { projects: [] }, replaceState: true, version: 2 });
  assert.equal(b.state.projects.length, 0); assert.equal(b.lastSyncedState.projects.length, 0);
});
