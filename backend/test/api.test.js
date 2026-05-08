/* End-to-end-ish tests for the REST API. Uses an in-memory SQLite DB so
   each test run is hermetic. */
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.STATIC_DIR = '';   // skip static serving in tests

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { closeDb } = require('../src/db');
const { buildApp } = require('../src/server');

let app;

test.before(() => {
  app = buildApp();
});

test.after(() => {
  closeDb();
});

test('GET /api/health returns ok', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('PUT /api/state then GET /api/state round-trips', async () => {
  const sample = {
    projects: [{
      id: 'p1', name: 'Test Project', client: 'ACME', archived: false,
      tasks: [{ id: 't1', title: 'Set up estimating', stage: 'project-setup', status: 'not-started' }]
    }],
    teamMembers: [{ id: 'tm1', name: 'Alice', title: 'PM', email: 'a@example.com' }],
    stages: [{ id: 'project-setup', name: 'Project Setup', icon: '📋', description: '' }],
    activeProjectId: 'p1',
    grouping: 'stage',
  };
  const put = await request(app).put('/api/state').send({ state: sample });
  assert.equal(put.status, 200);
  assert.ok(put.body.state);

  const get = await request(app).get('/api/state');
  assert.equal(get.status, 200);
  const s = get.body.state;
  assert.equal(s.activeProjectId, 'p1');
  assert.equal(s.grouping, 'stage');
  assert.equal(s.projects.length, 1);
  assert.equal(s.projects[0].name, 'Test Project');
  assert.equal(s.teamMembers.length, 1);
  assert.equal(s.teamMembers[0].name, 'Alice');
  assert.equal(s.stages.length, 1);
});

test('CRUD on /api/projects', async () => {
  const created = await request(app).post('/api/projects').send({
    name: 'CRUD Test', client: 'Foo Inc', archived: 0
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.ok(id);

  const got = await request(app).get(`/api/projects/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.name, 'CRUD Test');
  assert.deepEqual(got.body.tasks, []);

  const patched = await request(app).patch(`/api/projects/${id}`).send({ name: 'Renamed' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.name, 'Renamed');

  const list = await request(app).get('/api/projects');
  assert.equal(list.status, 200);
  assert.ok(list.body.some(p => p.id === id));

  const del = await request(app).delete(`/api/projects/${id}`);
  assert.equal(del.status, 204);

  const after = await request(app).get(`/api/projects/${id}`);
  assert.equal(after.status, 404);
});

test('CRUD on tasks nested under a project', async () => {
  const proj = await request(app).post('/api/projects').send({ name: 'Has Tasks' });
  const pid = proj.body.id;

  const task = await request(app).post(`/api/projects/${pid}/tasks`).send({
    title: 'Take off concrete', stage: 'estimating', status: 'not-started', assignee: 'Bob'
  });
  assert.equal(task.status, 201);
  const tid = task.body.id;

  const list = await request(app).get(`/api/projects/${pid}/tasks`);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].title, 'Take off concrete');

  const patched = await request(app).patch(`/api/projects/${pid}/tasks/${tid}`).send({ status: 'in-progress' });
  assert.equal(patched.body.status, 'in-progress');

  await request(app).delete(`/api/projects/${pid}/tasks/${tid}`).expect(204);
  const after = await request(app).get(`/api/projects/${pid}/tasks`);
  assert.equal(after.body.length, 0);
});

test('PUT /api/stages replaces the entire list', async () => {
  await request(app).put('/api/stages').send({ stages: [
    { id: 's1', name: 'One', icon: '1️⃣' },
    { id: 's2', name: 'Two', icon: '2️⃣' },
  ]}).expect(200);
  const list = await request(app).get('/api/stages');
  assert.equal(list.body.length, 2);
  assert.equal(list.body[0].name, 'One');
});

test('settings key/value endpoint round-trips arbitrary JSON', async () => {
  await request(app).put('/api/settings/companyLogo').send({ value: 'data:image/png;base64,AAA' }).expect(200);
  const got = await request(app).get('/api/settings/companyLogo');
  assert.equal(got.body.value, 'data:image/png;base64,AAA');

  await request(app).put('/api/settings/userPrefs').send({ value: { theme: 'dark', density: 'cozy' } }).expect(200);
  const prefs = await request(app).get('/api/settings/userPrefs');
  assert.deepEqual(prefs.body.value, { theme: 'dark', density: 'cozy' });
});

test('unknown route returns 404 JSON', async () => {
  const res = await request(app).get('/api/no-such-thing');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not found');
});
