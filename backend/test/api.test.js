process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.STATIC_DIR = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { closeDb } = require('../src/db');
const { buildApp } = require('../src/server');

let app;
let token;

test.before(async () => {
  app = buildApp();
  const res = await request(app)
    .post('/api/auth/signup')
    .send({ email: 'admin@test.local', password: 'password123', name: 'Admin' });
  if (res.status !== 201) throw new Error('admin signup failed: ' + JSON.stringify(res.body));
  token = res.body.token;
});

test.after(() => { closeDb(); });

function authed(req) { return req.set('Authorization', `Bearer ${token}`); }

test('health endpoint is public', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
});

test('protected endpoint 401s without token', async () => {
  const res = await request(app).get('/api/projects');
  assert.equal(res.status, 401);
});

test('PUT/GET /api/state round-trips', async () => {
  const sample = {
    projects: [{ id: 'p1', name: 'Test Project', client: 'ACME', archived: false,
      tasks: [{ id: 't1', title: 'Set up estimating', stage: 'project-setup', status: 'not-started' }] }],
    teamMembers: [{ id: 'tm1', name: 'Alice', title: 'PM', email: 'a@example.com' }],
    stages: [{ id: 'project-setup', name: 'Project Setup', icon: '📋', description: '' }],
    activeProjectId: 'p1', grouping: 'stage',
  };
  // PUT /api/state requires expectedVersion (optimistic concurrency, see
  // models.saveStateBlob). Fetch the current version first.
  const cur = await authed(request(app).get('/api/state'));
  assert.equal(typeof cur.body.version, 'number');
  await authed(request(app).put('/api/state'))
    .send({ state: sample, expectedVersion: cur.body.version }).expect(200);
  const get = await authed(request(app).get('/api/state'));
  assert.equal(get.status, 200);
  assert.equal(get.body.state.activeProjectId, 'p1');
  assert.equal(get.body.state.projects.length, 1);
  assert.equal(get.body.version, cur.body.version + 1);
});

test('CRUD on /api/projects', async () => {
  const created = await authed(request(app).post('/api/projects')).send({ name: 'CRUD Test', client: 'Foo Inc' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const got = await authed(request(app).get(`/api/projects/${id}`));
  assert.equal(got.body.name, 'CRUD Test');
  const patched = await authed(request(app).patch(`/api/projects/${id}`)).send({ name: 'Renamed' });
  assert.equal(patched.body.name, 'Renamed');
  await authed(request(app).delete(`/api/projects/${id}`)).expect(204);
});

test('CRUD on tasks nested under a project', async () => {
  const proj = await authed(request(app).post('/api/projects')).send({ name: 'Has Tasks' });
  const pid = proj.body.id;
  const task = await authed(request(app).post(`/api/projects/${pid}/tasks`)).send({
    title: 'Take off concrete', stage: 'estimating', status: 'not-started', assignee: 'Bob' });
  assert.equal(task.status, 201);
  const tid = task.body.id;
  const list = await authed(request(app).get(`/api/projects/${pid}/tasks`));
  assert.equal(list.body.length, 1);
  await authed(request(app).delete(`/api/projects/${pid}/tasks/${tid}`)).expect(204);
});

test('PUT /api/stages replaces the entire list', async () => {
  await authed(request(app).put('/api/stages')).send({ stages: [
    { id: 's1', name: 'One', icon: '1️⃣' }, { id: 's2', name: 'Two', icon: '2️⃣' },
  ]}).expect(200);
  const list = await authed(request(app).get('/api/stages'));
  assert.equal(list.body.length, 2);
});

test('settings k/v round-trip', async () => {
  await authed(request(app).put('/api/settings/companyLogo')).send({ value: 'data:image/png;base64,AAA' }).expect(200);
  const got = await authed(request(app).get('/api/settings/companyLogo'));
  assert.equal(got.body.value, 'data:image/png;base64,AAA');
});

test('unknown protected route 401s without auth (auth comes before 404)', async () => {
  const res = await request(app).get('/api/no-such-thing');
  assert.equal(res.status, 401);
});

test('subdomain incremental sync and OCC version checks', async () => {
  // 1. Setup initial state on the server
  const sample = {
    projects: [
      { id: 'sub-p1', name: 'Original Project', client: 'Alice', archived: false, tasks: [] },
      { id: 'sub-p2', name: 'Other Project', client: 'Bob', archived: false, tasks: [] }
    ],
    teamMembers: [],
    stages: [],
  };
  const init = await authed(request(app).put('/api/state')).send({ state: sample, expectedVersion: 0 }).expect(200);
  const startVersion = init.body.version;
  assert.ok(startVersion > 0);

  // 2. Update sub-p1 with correct expectedVersion (success case)
  const updatedProj = { id: 'sub-p1', name: 'Updated Project Name', client: 'Alice', tasks: [] };
  const putRes = await authed(request(app).put('/api/state/projects/sub-p1'))
    .send({ project: updatedProj, expectedVersion: startVersion });
  assert.equal(putRes.status, 200);
  const newVersion = putRes.body.version;
  assert.ok(newVersion > startVersion);

  // Verify project updated in db
  const getProj = await authed(request(app).get('/api/state'));
  const targetProj = getProj.body.state.projects.find(p => p.id === 'sub-p1');
  assert.equal(targetProj.name, 'Updated Project Name');

  // Other project remains untouched
  const otherProj = getProj.body.state.projects.find(p => p.id === 'sub-p2');
  assert.equal(otherProj.name, 'Other Project');

  // 3. Stale update (conflict case)
  const staleProj = { id: 'sub-p1', name: 'Stale Edit', client: 'Alice', tasks: [] };
  const conflictRes = await authed(request(app).put('/api/state/projects/sub-p1'))
    .send({ project: staleProj, expectedVersion: startVersion });
  assert.equal(conflictRes.status, 409);
  assert.equal(conflictRes.body.code, 'VERSION_CONFLICT');
  assert.equal(conflictRes.body.currentVersion, newVersion);

  // 4. Delete project state
  const deleteRes = await authed(request(app).delete(`/api/state/projects/sub-p1?expectedVersion=${newVersion}`));
  assert.equal(deleteRes.status, 200);

  // Verify deleted from db
  const afterDelete = await authed(request(app).get('/api/state'));
  assert.equal(afterDelete.body.state.projects.length, 1);
  assert.equal(afterDelete.body.state.projects[0].id, 'sub-p2');

  // Stale delete conflict
  const staleDeleteRes = await authed(request(app).delete(`/api/state/projects/sub-p2?expectedVersion=${startVersion}`));
  assert.equal(staleDeleteRes.status, 409);
});
