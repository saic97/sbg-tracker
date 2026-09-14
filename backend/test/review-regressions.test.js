process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.STATIC_DIR = '';
process.env.ANTHROPIC_FAKE = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const fs = require('node:fs');
const path = require('node:path');
const { buildApp } = require('../src/server');
const { getDb, closeDb } = require('../src/db');
const m = require('../src/models');
const rt = require('../src/realtime');
const intake = require('../src/bidIntake');

let app, token, adminId;
const authed = r => r.set('Authorization', 'Bearer ' + token);
const state = async () => (await authed(request(app).get('/api/state')).expect(200)).body;
test.beforeEach(async () => {
  closeDb(); app = buildApp();
  const signup = await request(app).post('/api/auth/signup').send({ email: 'review@test.local', password: 'password123', name: 'Review' }).expect(201);
  token = signup.body.token; adminId = signup.body.user.id;
});
test.after(() => {
  closeDb();
  const dir = path.join(require('os').tmpdir(), 'sbg-tracker-uploads-' + process.pid);
  if (fs.existsSync(dir)) { for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file)); fs.rmdirSync(dir); }
});

test('cleared camelCase dates override stale aliases on every state write path', async () => {
  const project = { id: 'p', name: 'P', startDate: '2026-09-01', dueDate: '2026-10-01', tasks: [
    { id: 't', title: 'T', dueDate: '2026-09-20', startByDate: '2026-09-10' },
  ] };
  for (const route of ['task', 'meta', 'project', 'state']) {
    await authed(request(app).put('/api/state/projects/p')).send({ project, expectedVersion: m.getStateVersion() }).expect(200);
    let loaded = await state(); const p = loaded.state.projects[0];
    p.startDate = ''; p.dueDate = null;
    p.tasks[0].dueDate = ''; p.tasks[0].startByDate = null;
    const body = { expectedVersion: loaded.version };
    if (route === 'task') await authed(request(app).put('/api/state/projects/p/tasks/t')).send({ ...body, task: p.tasks[0] }).expect(200);
    if (route === 'meta') await authed(request(app).put('/api/state/projects/p/meta')).send({ ...body, meta: p }).expect(200);
    if (route === 'project') await authed(request(app).put('/api/state/projects/p')).send({ ...body, project: p }).expect(200);
    if (route === 'state') await authed(request(app).put('/api/state')).send({ ...body, state: loaded.state }).expect(200);
    loaded = (await state()).state.projects[0];
    if (route !== 'task') { assert.equal(loaded.startDate, ''); assert.equal(loaded.dueDate, ''); }
    if (route !== 'meta') { assert.equal(loaded.tasks[0].dueDate, ''); assert.equal(loaded.tasks[0].startByDate, ''); }
  }
});

test('CRUD writes invalidate ETags, reject stale state writes, and broadcast deletions', async t => {
  const broadcasts = [];
  t.mock.method(rt, 'broadcastStateChange', payload => broadcasts.push(payload));
  await authed(request(app).post('/api/projects')).send({ id: 'p', name: 'Before' }).expect(201);
  let loaded = await state();
  await authed(request(app).patch('/api/projects/p')).send({ name: 'After' }).expect(200);
  const fresh = await authed(request(app).get('/api/state')).set('If-None-Match', '"v' + loaded.version + '"').expect(200);
  assert.equal(fresh.body.state.projects[0].name, 'After');
  await authed(request(app).put('/api/state/projects/p')).send({ project: loaded.state.projects[0], expectedVersion: loaded.version }).expect(409);
  await authed(request(app).post('/api/projects/p/tasks')).send({ id: 't', title: 'Original', status: 'not-started' }).expect(201);
  loaded = await state();
  await authed(request(app).patch('/api/projects/p/tasks/t')).send({ title: 'Changed' }).expect(200);
  await authed(request(app).put('/api/state/projects/p/tasks/t')).send({ task: loaded.state.projects[0].tasks[0], expectedVersion: loaded.version }).expect(409);
  await authed(request(app).delete('/api/projects/p')).expect(204);
  assert.equal(broadcasts.at(-1).replaceState, true);
  assert.deepEqual(broadcasts.at(-1).state.projects, []);
  assert.equal(broadcasts.at(-1).version, m.getStateVersion());
  const before = m.getStateVersion();
  await authed(request(app).patch('/api/projects/missing')).send({ name: 'No' }).expect(404);
  assert.equal(m.getStateVersion(), before, 'failed writes must not invalidate state');
});

test('legacy roster, templates, lists and settings writes advance versions', async () => {
  for (const [url, method, body] of [
    ['/api/team-members', 'post', { id: 'tm', name: 'Member' }],
    ['/api/team-members/tm', 'patch', { name: 'Renamed' }],
    ['/api/team-members/tm', 'delete', {}],
    ['/api/templates', 'post', { id: 'tpl', name: 'Template', is_default: 0 }],
    ['/api/templates/tpl', 'delete', {}],
    ['/api/stages', 'put', { stages: [{ id: 's', name: 'Stage' }] }],
    ['/api/holidays', 'put', { holidays: [{ id: 'h', name: 'Holiday', date: '2026-09-01', recurring: 0 }] }],
    ['/api/settings/companyLogo', 'put', { value: 'logo' }],
    ['/api/settings/companyLogo', 'delete', {}],
  ]) {
    const before = m.getStateVersion();
    const r = await authed(request(app)[method](url)).send(body);
    assert.ok(r.status < 300, JSON.stringify(r.body));
    assert.equal(m.getStateVersion(), before + 1, method + ' ' + url);
  }
  await authed(request(app).put('/api/settings/state_version')).send({ value: 0 }).expect(400);
});

test('cannot disable the only active admin, but can disable one of two admins', async () => {
  await authed(request(app).patch('/api/admin/users/' + adminId)).send({ disabled: true }).expect(400);
  await authed(request(app).get('/api/admin/users')).expect(200);
  const other = await request(app).post('/api/auth/signup').send({ email: 'other@test.local', password: 'password123' }).expect(201);
  await authed(request(app).patch('/api/admin/users/' + other.body.user.id)).send({ role: 'admin' }).expect(200);
  await authed(request(app).patch('/api/admin/users/' + adminId)).send({ disabled: true }).expect(200);
  await authed(request(app).get('/api/admin/users')).expect(401);
  await request(app).get('/api/admin/users').set('Authorization', 'Bearer ' + other.body.token).expect(200);
});

test('email polling uses UIDs and finishes fetching before flags or moves', async t => {
  const env = {
    BID_INTAKE_IMAP_HOST: 'example.invalid', BID_INTAKE_IMAP_USER: 'test',
    BID_INTAKE_IMAP_PASSWORD: 'test', BID_INTAKE_PROCESSED_MAILBOX: 'Processed',
  };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  await authed(request(app).post('/api/projects')).send({ id: 'p', name: 'Mail Project' }).expect(201);
  const before = m.getStateVersion();
  const calls = []; let activeFetch = false;
  const source = Buffer.from([
    'From: Sub <sub@example.test>', 'Subject: [SBG:p] Bid', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="review"', '', '--review',
    'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="bid.pdf"',
    'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4\nreview email').toString('base64'), '--review--', '',
  ].join('\r\n'));
  class FakeImap {
    async connect() {}
    async getMailboxLock() { return { release() { calls.push('release'); } }; }
    async search(_criteria, opts) { assert.equal(opts.uid, true); return [101, 205]; }
    async *fetch() { activeFetch = true; yield { uid: 101, source }; activeFetch = false; }
    async fetchOne(uid, _query, opts) {
      assert.equal(opts.uid, true, 'range must be interpreted as UIDs, not sequence numbers');
      assert.ok([101, 205].includes(uid));
      calls.push('fetch:' + uid);
      return { uid, source, internalDate: new Date('2026-09-14') };
    }
    async messageFlagsAdd(uid, flags, opts) {
      assert.equal(activeFetch, false, 'IMAP commands inside fetch deadlock');
      assert.equal(opts.uid, true); assert.deepEqual(flags, ['\\Seen']); calls.push('seen:' + uid);
    }
    async messageMove(uid, mailbox, opts) { assert.equal(activeFetch, false); assert.equal(opts.uid, true); assert.equal(mailbox, 'Processed'); calls.push('move:' + uid); }
    async logout() { calls.push('logout'); }
  }
  const imapModule = require('imapflow');
  const OriginalImap = imapModule.ImapFlow;
  imapModule.ImapFlow = FakeImap;
  t.after(() => { imapModule.ImapFlow = OriginalImap; });
  const summary = await intake.pollInbox({ userId: adminId });
  assert.equal(summary.scanned, 2); assert.equal(summary.errors, 0);
  assert.equal(summary.imported + summary.duplicates, 2);
  assert.deepEqual(calls, ['fetch:101', 'seen:101', 'move:101', 'fetch:205', 'seen:205', 'move:205', 'release', 'logout']);
  assert.ok(m.getStateVersion() > before, 'sub-bid imports invalidate cached state too');
});
