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
  const cur = await authed(request(app).get('/api/state'));
  const init = await authed(request(app).put('/api/state'))
    .send({ state: sample, expectedVersion: cur.body.version, confirmDestructive: true })
    .expect(200);
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

  // 3. Stale update of the SAME project (true conflict case)
  const staleProj = { id: 'sub-p1', name: 'Stale Edit', client: 'Alice', tasks: [] };
  const conflictRes = await authed(request(app).put('/api/state/projects/sub-p1'))
    .send({ project: staleProj, expectedVersion: startVersion });
  assert.equal(conflictRes.status, 409);
  assert.equal(conflictRes.body.code, 'VERSION_CONFLICT');
  assert.equal(conflictRes.body.currentVersion, newVersion);
  // Conflict bodies are lean: no full-state payload rides along.
  assert.equal(conflictRes.body.state, undefined);

  // 3b. Stale update of a DIFFERENT subdomain is NOT a conflict: sub-p2
  // hasn't changed since startVersion, so the write is accepted even though
  // the global version moved (two users editing different projects).
  const otherEdit = { id: 'sub-p2', name: 'Other Project Renamed', client: 'Bob', tasks: [] };
  const crossRes = await authed(request(app).put('/api/state/projects/sub-p2'))
    .send({ project: otherEdit, expectedVersion: startVersion });
  assert.equal(crossRes.status, 200);
  const v3 = crossRes.body.version;
  assert.ok(v3 > newVersion);

  // ...same for an unrelated subdomain like team members.
  const tmRes = await authed(request(app).put('/api/state/team-members'))
    .send({ teamMembers: [{ id: 'tm1', name: 'Carol' }], expectedVersion: startVersion });
  assert.equal(tmRes.status, 200);
  const v4 = tmRes.body.version;
  assert.ok(v4 > v3);

  // ...but a stale write to a subdomain that DID change conflicts.
  const tmConflict = await authed(request(app).put('/api/state/team-members'))
    .send({ teamMembers: [], expectedVersion: v3 });
  assert.equal(tmConflict.status, 409);
  assert.equal(tmConflict.body.code, 'VERSION_CONFLICT');

  // 4. Delete project state
  const deleteRes = await authed(request(app).delete(`/api/state/projects/sub-p1?expectedVersion=${v4}`));
  assert.equal(deleteRes.status, 200);

  // Verify deleted from db
  const afterDelete = await authed(request(app).get('/api/state'));
  assert.equal(afterDelete.body.state.projects.length, 1);
  assert.equal(afterDelete.body.state.projects[0].id, 'sub-p2');

  // Stale delete of a project changed since the client's version conflicts
  // (sub-p2 was renamed at v3, so expectedVersion=startVersion is stale FOR IT).
  const staleDeleteRes = await authed(request(app).delete(`/api/state/projects/sub-p2?expectedVersion=${startVersion}`));
  assert.equal(staleDeleteRes.status, 409);
});

test('GET /api/state supports If-None-Match revalidation (304)', async () => {
  const first = await authed(request(app).get('/api/state'));
  assert.equal(first.status, 200);
  const etag = first.headers.etag;
  assert.ok(etag, 'ETag header expected');
  assert.equal(etag, `"v${first.body.version}"`);

  // Same version -> 304 with empty body.
  const second = await authed(request(app).get('/api/state').set('If-None-Match', etag));
  assert.equal(second.status, 304);

  // After a write the version moves and the same validator misses.
  const put = await authed(request(app).put('/api/state/settings'))
    .send({ settings: { skipWeekends: true }, expectedVersion: first.body.version });
  assert.equal(put.status, 200);
  const third = await authed(request(app).get('/api/state').set('If-None-Match', etag));
  assert.equal(third.status, 200);
  assert.equal(third.body.version, put.body.version);
});

test('settings groups are independent subdomains (no cross-group conflict)', async () => {
  const v0 = (await authed(request(app).get('/api/state'))).body.version;

  // Write the `lists` group at v0.
  const listsRes = await authed(request(app).put('/api/state/settings'))
    .send({ settings: { sourceOptions: [{ id: 's1', name: 'Bluebeam' }] }, group: 'lists', expectedVersion: v0 });
  assert.equal(listsRes.status, 200);
  const v1 = listsRes.body.version;
  assert.ok(v1 > v0);

  // A write to a DIFFERENT group (calendar) still carrying the old v0 is
  // accepted -- the calendar group hasn't changed since v0.
  const calRes = await authed(request(app).put('/api/state/settings'))
    .send({ settings: { skipWeekends: true }, group: 'calendar', expectedVersion: v0 });
  assert.equal(calRes.status, 200);
  const v2 = calRes.body.version;
  assert.ok(v2 > v1);

  // But a stale write to the SAME group (lists) at v0 now conflicts.
  const staleLists = await authed(request(app).put('/api/state/settings'))
    .send({ settings: { sourceOptions: [] }, group: 'lists', expectedVersion: v0 });
  assert.equal(staleLists.status, 409);
  assert.equal(staleLists.body.code, 'VERSION_CONFLICT');

  // Both groups' values landed.
  const after = await authed(request(app).get('/api/state'));
  assert.equal(after.body.state.skipWeekends, true);
  assert.equal(after.body.state.sourceOptions.find(o => o.id === 's1').name, 'Bluebeam');
});

test('device-local UI keys are never stored or returned by the server', async () => {
  const v = (await authed(request(app).get('/api/state'))).body.version;
  // Even if a client mistakenly sends them, the server drops them.
  const res = await authed(request(app).put('/api/state/settings'))
    .send({
      settings: { sidebarCollapsed: true, homeView: true, currentUser: 'Alice', companyLogo: 'data:img' },
      group: 'branding',
      expectedVersion: v,
    });
  assert.equal(res.status, 200);

  const after = await authed(request(app).get('/api/state'));
  // Genuine shared key persisted...
  assert.equal(after.body.state.companyLogo, 'data:img');
  // ...device-local ones did not leak back out.
  assert.equal(after.body.state.sidebarCollapsed, undefined);
  assert.equal(after.body.state.homeView, undefined);
  assert.equal(after.body.state.currentUser, undefined);
});

test('per-task sync: two tasks in one project edit independently (no cross-task conflict)', async () => {
  // Seed a project with two tasks via a whole-project PUT.
  const seed = {
    projects: [{
      id: 'tp1', name: 'Task Proj', archived: false,
      tasks: [
        { id: 'ta', title: 'Task A', status: 'not-started' },
        { id: 'tb', title: 'Task B', status: 'not-started' },
      ],
    }],
  };
  const v0 = (await authed(request(app).get('/api/state'))).body.version;
  const seeded = await authed(request(app).put('/api/state'))
    .send({ state: seed, expectedVersion: v0, confirmDestructive: true }).expect(200);
  const base = seeded.body.version;

  // Edit task A at `base`.
  const aRes = await authed(request(app).put('/api/state/projects/tp1/tasks/ta'))
    .send({ task: { id: 'ta', title: 'Task A edited', status: 'in-progress' }, expectedVersion: base });
  assert.equal(aRes.status, 200);
  const vA = aRes.body.version;
  assert.ok(vA > base);

  // Edit task B STILL carrying `base` -- task B hasn't changed, so no conflict
  // even though the global version moved when A was saved.
  const bRes = await authed(request(app).put('/api/state/projects/tp1/tasks/tb'))
    .send({ task: { id: 'tb', title: 'Task B edited', status: 'blocked' }, expectedVersion: base });
  assert.equal(bRes.status, 200);
  const vB = bRes.body.version;
  assert.ok(vB > vA);

  // But a stale re-edit of task A at `base` now conflicts (A changed at vA).
  const aStale = await authed(request(app).put('/api/state/projects/tp1/tasks/ta'))
    .send({ task: { id: 'ta', title: 'racey', status: 'done' }, expectedVersion: base });
  assert.equal(aStale.status, 409);
  assert.equal(aStale.body.code, 'VERSION_CONFLICT');

  // Both edits landed; sibling tasks intact.
  const proj = (await authed(request(app).get('/api/state'))).body.state.projects.find(p => p.id === 'tp1');
  assert.equal(proj.tasks.length, 2);
  assert.equal(proj.tasks.find(t => t.id === 'ta').title, 'Task A edited');
  assert.equal(proj.tasks.find(t => t.id === 'tb').title, 'Task B edited');
});

test('per-task sync: whole-project replace conflicts if a child task changed since', async () => {
  const seed = {
    projects: [{ id: 'tp2', name: 'P2', archived: false, tasks: [{ id: 'x1', title: 'X1', status: 'not-started' }] }],
  };
  const v0 = (await authed(request(app).get('/api/state'))).body.version;
  const seeded = await authed(request(app).put('/api/state'))
    .send({ state: { projects: [...seed.projects, { id: 'keep', name: 'keep', tasks: [] }] }, expectedVersion: v0, confirmDestructive: true })
    .expect(200);
  const base = seeded.body.version;

  // Someone edits a task in tp2 -> child key moves.
  const childRes = await authed(request(app).put('/api/state/projects/tp2/tasks/x1'))
    .send({ task: { id: 'x1', title: 'X1 edited', status: 'done' }, expectedVersion: base });
  assert.equal(childRes.status, 200);

  // A whole-project replace of tp2 still carrying `base` must conflict -- it
  // would otherwise wipe the just-edited task.
  const wholeRes = await authed(request(app).put('/api/state/projects/tp2'))
    .send({ project: { id: 'tp2', name: 'P2', tasks: [] }, expectedVersion: base });
  assert.equal(wholeRes.status, 409);
  assert.equal(wholeRes.body.code, 'VERSION_CONFLICT');
});

test('per-task sync: task delete + project-meta update are independent', async () => {
  const seed = {
    projects: [{
      id: 'tp3', name: 'Original Name', archived: false,
      tasks: [{ id: 'd1', title: 'Doomed', status: 'not-started' }, { id: 'k1', title: 'Keeper', status: 'not-started' }],
    }],
  };
  const v0 = (await authed(request(app).get('/api/state'))).body.version;
  const seeded = await authed(request(app).put('/api/state'))
    .send({ state: seed, expectedVersion: v0, confirmDestructive: true }).expect(200);
  let v = seeded.body.version;

  // Delete one task.
  const del = await authed(request(app).delete(`/api/state/projects/tp3/tasks/d1?expectedVersion=${v}`));
  assert.equal(del.status, 200);
  v = del.body.version;

  // Update project meta (name) -- doesn't touch tasks.
  const meta = await authed(request(app).put('/api/state/projects/tp3/meta'))
    .send({ meta: { id: 'tp3', name: 'Renamed', client: 'New Client' }, expectedVersion: v });
  assert.equal(meta.status, 200);

  const proj = (await authed(request(app).get('/api/state'))).body.state.projects.find(p => p.id === 'tp3');
  assert.equal(proj.name, 'Renamed');
  assert.equal(proj.client, 'New Client');
  assert.equal(proj.tasks.length, 1);
  assert.equal(proj.tasks[0].id, 'k1');
});
