/* =============================================================================
 * state-conflict.test.js -- Optimistic concurrency + destructive-delete guard
 * for PUT /api/state. Added after the May 2026 incident in which a stale
 * browser tab silently wiped a real client project from the live DB.
 * See migration 007_state_versioning.sql for the schema bits.
 * =============================================================================
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.STATIC_DIR = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { closeDb, getDb } = require('../src/db');
const { buildApp } = require('../src/server');

let app, token;

test.before(async () => {
  app = buildApp();
  const r = await request(app).post('/api/auth/signup')
    .send({ email: 'admin@conflict.test', password: 'password123', name: 'Admin' });
  if (r.status !== 201) throw new Error('signup failed: ' + JSON.stringify(r.body));
  token = r.body.token;
});
test.after(() => { closeDb(); });

function authed(req) { return req.set('Authorization', `Bearer ${token}`); }
async function getVersion() {
  const r = await authed(request(app).get('/api/state'));
  return r.body.version;
}

test('GET /api/state returns a numeric version', async () => {
  const r = await authed(request(app).get('/api/state'));
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.version, 'number');
});

test('PUT without expectedVersion returns 400 EXPECTED_VERSION_REQUIRED + current state', async () => {
  const r = await authed(request(app).put('/api/state'))
    .send({ state: { projects: [] } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'EXPECTED_VERSION_REQUIRED');
  // Server echoes its current state so the client can refresh without an extra GET.
  assert.ok(r.body.state);
  assert.equal(typeof r.body.currentVersion, 'number');
});

test('PUT with current expectedVersion succeeds and bumps the version', async () => {
  const v0 = await getVersion();
  const r = await authed(request(app).put('/api/state'))
    .send({
      state: { projects: [{ id: 'p1', name: 'First', tasks: [] }], grouping: 'stage' },
      expectedVersion: v0,
    });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, v0 + 1);
  assert.equal(await getVersion(), v0 + 1);
});

test('PUT with a stale expectedVersion returns 409 VERSION_CONFLICT and does NOT mutate', async () => {
  const v = await getVersion();  // current
  // Sanity: there is one project in the DB right now.
  const before = await authed(request(app).get('/api/state'));
  assert.equal(before.body.state.projects.length, 1);

  const r = await authed(request(app).put('/api/state'))
    .send({
      state: { projects: [{ id: 'p2', name: 'Stale', tasks: [] }] },
      expectedVersion: v - 1,
    });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'VERSION_CONFLICT');
  assert.equal(r.body.expectedVersion, v - 1);
  assert.equal(r.body.currentVersion, v);
  assert.ok(r.body.state);

  // The unchanged DB proves no DELETE ran.
  const after = await authed(request(app).get('/api/state'));
  assert.equal(after.body.state.projects.length, 1);
  assert.equal(after.body.state.projects[0].id, 'p1');
  assert.equal(after.body.version, v);
});

test('PUT that would drop an existing project returns 409 DESTRUCTIVE_DELETE', async () => {
  // Right shape: current version, but the incoming `projects` array omits p1.
  // This is exactly the FTW PMD failure mode: stale tab, missing project.
  const v = await getVersion();
  const r = await authed(request(app).put('/api/state'))
    .send({ state: { projects: [] }, expectedVersion: v });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'DESTRUCTIVE_DELETE');
  assert.deepEqual(r.body.droppedProjects.map(p => p.id), ['p1']);
  // No DELETE ran.
  const after = await authed(request(app).get('/api/state'));
  assert.equal(after.body.state.projects.length, 1);
});

test('PUT with confirmDestructive=true is allowed to drop projects', async () => {
  const v = await getVersion();
  const r = await authed(request(app).put('/api/state'))
    .send({ state: { projects: [] }, expectedVersion: v, confirmDestructive: true });
  assert.equal(r.status, 200);
  const after = await authed(request(app).get('/api/state'));
  assert.equal(after.body.state.projects.length, 0);
});

test('every successful PUT writes a row to state_snapshots', async () => {
  const before = getDb().prepare('SELECT COUNT(*) AS n FROM state_snapshots').get().n;
  const v = await getVersion();
  await authed(request(app).put('/api/state'))
    .send({
      state: { projects: [{ id: 'snap1', name: 'Snap test', tasks: [] }] },
      expectedVersion: v,
      confirmDestructive: true,
    }).expect(200);
  const after = getDb().prepare('SELECT COUNT(*) AS n FROM state_snapshots').get().n;
  assert.equal(after, before + 1);
  // Most-recent snapshot has the right project so recovery would actually work.
  const last = getDb().prepare('SELECT blob, version FROM state_snapshots ORDER BY id DESC LIMIT 1').get();
  const blob = JSON.parse(last.blob);
  assert.equal(blob.projects[0].id, 'snap1');
  assert.equal(last.version, v + 1);
});

test('state_snapshots is bounded (rotation keeps recent ~50 entries)', async () => {
  // Burn enough writes to exceed the retention window. The exact cap is
  // SNAPSHOT_RETENTION = 50 in models.js; we just assert the table is bounded.
  for (let i = 0; i < 55; i++) {
    const v = await getVersion();
    await authed(request(app).put('/api/state'))
      .send({
        state: { projects: [{ id: 'rot', name: 'rot ' + i, tasks: [] }] },
        expectedVersion: v,
        confirmDestructive: true,
      }).expect(200);
  }
  const total = getDb().prepare('SELECT COUNT(*) AS n FROM state_snapshots').get().n;
  assert.ok(total <= 50, `expected <= 50 snapshots after rotation, got ${total}`);
});
