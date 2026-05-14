process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.STATIC_DIR = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { closeDb } = require('../src/db');
const { buildApp } = require('../src/server');

let app, aliceToken, bobToken, bobId;

test.before(async () => {
  app = buildApp();
  const a = await request(app).post('/api/auth/signup').send({ email: 'alice@n.test', password: 'password123', name: 'Alice' });
  const b = await request(app).post('/api/auth/signup').send({ email: 'bob@n.test',   password: 'password123', name: 'Bob' });
  aliceToken = a.body.token;
  bobToken   = b.body.token;
  bobId      = b.body.user.id;
});
test.after(() => { closeDb(); });

function authed(req, token) { return req.set('Authorization', `Bearer ${token}`); }

// PUT /api/state now requires expectedVersion (optimistic concurrency, see
// models.saveStateBlob). This helper fetches the current version then PUTs
// with confirmDestructive=true so we don't have to thread destructive-delete
// guards through every notification test (that's covered elsewhere).
async function putState(token, state, clientId) {
  const cur = await authed(request(app).get('/api/state'), token);
  return authed(request(app).put('/api/state'), token).send({
    state, clientId,
    expectedVersion: cur.body.version,
    confirmDestructive: true,
  });
}

test('assigning a task to a user creates a notification for that user', async () => {
  const state = {
    projects: [{
      id: 'p1', name: 'Riverwalk Tower',
      tasks: [{ id: 't1', title: 'Take off concrete', stage: 'estimating', status: 'not-started', assignee: 'Bob' }]
    }]
  };
  await putState(aliceToken, state, 'alice').then(r => assert.equal(r.status, 200));

  const notifs = await authed(request(app).get('/api/notifications'), bobToken);
  assert.equal(notifs.status, 200);
  assert.ok(notifs.body.unread >= 1);
  const n = notifs.body.items[0];
  assert.equal(n.kind, 'task_assigned');
  assert.equal(n.entity, 'task');
  assert.equal(n.entity_id, 't1');
  assert.match(n.title, /Alice assigned/);
  assert.match(n.body, /Take off concrete/);
  assert.match(n.body, /Riverwalk Tower/);
});

test('PATCH /api/notifications/:id/read marks a notification read', async () => {
  const list = await authed(request(app).get('/api/notifications'), bobToken);
  const id = list.body.items[0].id;
  const patched = await authed(request(app).patch(`/api/notifications/${id}/read`), bobToken);
  assert.equal(patched.status, 200);
  assert.equal(patched.body.unread, 0);
});

test('re-assigning the same task to the same user does NOT create a duplicate', async () => {
  // Same state -> assignee unchanged -> no new notification
  const state = {
    projects: [{
      id: 'p1', name: 'Riverwalk Tower',
      tasks: [{ id: 't1', title: 'Take off concrete', stage: 'estimating', status: 'not-started', assignee: 'Bob' }]
    }]
  };
  await putState(aliceToken, state, 'alice').then(r => assert.equal(r.status, 200));
  const list = await authed(request(app).get('/api/notifications'), bobToken);
  assert.equal(list.body.unread, 0);  // no new ones since previous read
});

test('changing the assignee to someone different creates a new notification', async () => {
  // Reassign t1 from Bob -> Alice
  const state = {
    projects: [{
      id: 'p1', name: 'Riverwalk Tower',
      tasks: [{ id: 't1', title: 'Take off concrete', stage: 'estimating', status: 'not-started', assignee: 'Alice' }]
    }]
  };
  // Bob makes the change so Alice gets notified (recipient != requester).
  await putState(bobToken, state, 'bob').then(r => assert.equal(r.status, 200));
  const aliceNotifs = await authed(request(app).get('/api/notifications'), aliceToken);
  assert.ok(aliceNotifs.body.unread >= 1);
  assert.equal(aliceNotifs.body.items[0].kind, 'task_assigned');
});

test('you do NOT receive a notification when you assign a task to yourself', async () => {
  // Reset: clear Alice's unread by marking all read
  await authed(request(app).post('/api/notifications/read-all'), aliceToken).expect(200);

  // Alice assigns a brand-new task to Alice
  const state = {
    projects: [{
      id: 'p1', name: 'Riverwalk Tower',
      tasks: [{ id: 't-self', title: 'Self task', stage: 'estimating', status: 'not-started', assignee: 'Alice' }]
    }]
  };
  await putState(aliceToken, state, 'alice').then(r => assert.equal(r.status, 200));
  const list = await authed(request(app).get('/api/notifications'), aliceToken);
  assert.equal(list.body.unread, 0);
});

test('POST /api/notifications/read-all clears the badge', async () => {
  // Create one fresh for Bob, then read-all
  const state = {
    projects: [{
      id: 'p1', name: 'Riverwalk Tower',
      tasks: [{ id: 't-rb', title: 'For Bob', stage: 'estimating', status: 'not-started', assignee: 'Bob' }]
    }]
  };
  await putState(aliceToken, state, 'alice').then(r => assert.equal(r.status, 200));
  const before = await authed(request(app).get('/api/notifications'), bobToken);
  assert.ok(before.body.unread >= 1);
  const cleared = await authed(request(app).post('/api/notifications/read-all'), bobToken);
  assert.equal(cleared.body.unread, 0);
});
