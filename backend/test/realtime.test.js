/* End-to-end test: two Socket.IO clients connect; client B receives state:updated
   when client A does a PUT /api/state. Also verifies presence broadcasts. */
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.STATIC_DIR = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { io: ioc } = require('socket.io-client');

const { closeDb } = require('../src/db');
const { buildServer } = require('../src/server');

let httpServer, app, port, tokenA, tokenB;

test.before(async () => {
  ({ app, httpServer } = buildServer());
  await new Promise(r => httpServer.listen(0, r));
  port = httpServer.address().port;
  // Seed two users
  const a = await request(app).post('/api/auth/signup').send({
    email: 'alice@test.local', password: 'password123', name: 'Alice'
  });
  const b = await request(app).post('/api/auth/signup').send({
    email: 'bob@test.local', password: 'password123', name: 'Bob'
  });
  tokenA = a.body.token;
  tokenB = b.body.token;
});

test.after(() => {
  httpServer.close();
  closeDb();
});

function connect(token) {
  return new Promise((resolve, reject) => {
    const url = `http://localhost:${port}`;
    const s = ioc(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

test('Socket.IO connection requires a valid token', async () => {
  await new Promise((resolve) => {
    const s = ioc(`http://localhost:${port}`, {
      auth: { token: 'invalid-token' },
      transports: ['websocket'],
      reconnection: false,
    });
    s.on('connect', () => { s.disconnect(); resolve('should not connect'); });
    s.on('connect_error', (err) => {
      assert.match(err.message, /unauthorized/);
      resolve();
    });
  });
});

test('presence:list fires when a second client joins', async () => {
  const sa = await connect(tokenA);
  // Wait until any presence:list arrives with length 2 (Alice + Bob).
  const presencePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('presence timeout')), 5000);
    sa.on('presence:list', (list) => {
      if (list.length >= 2) {
        clearTimeout(timer);
        const names = list.map(p => p.name).sort();
        assert.deepEqual(names, ['Alice', 'Bob']);
        resolve();
      }
    });
  });
  const sb = await connect(tokenB);
  await presencePromise;
  sa.disconnect();
  sb.disconnect();
});

test('PUT /api/state broadcasts state:updated to other clients', async () => {
  const sa = await connect(tokenA);
  const sb = await connect(tokenB);

  const received = new Promise((resolve) => {
    sb.on('state:updated', (payload) => {
      assert.ok(payload.state);
      assert.equal(payload.byUserName, 'Alice');
      assert.equal(payload.clientId, 'client-A');
      assert.equal(payload.state.projects.length, 1);
      assert.equal(payload.state.projects[0].name, 'RT Test');
      resolve();
    });
  });

  // Give socket.io a moment to settle the handshake
  await new Promise(r => setTimeout(r, 100));

  // Fetch current version first; PUT /api/state requires expectedVersion now.
  const cur = await request(app)
    .get('/api/state')
    .set('Authorization', `Bearer ${tokenA}`);

  await request(app)
    .put('/api/state')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({
      state: { projects: [{ id: 'rt1', name: 'RT Test', tasks: [] }], grouping: 'stage' },
      clientId: 'client-A',
      expectedVersion: cur.body.version,
    })
    .expect(200);

  await received;
  sa.disconnect();
  sb.disconnect();
});

test('per-task PUT broadcasts the taskUpsert delta + version (not an empty state)', async () => {
  const sa = await connect(tokenA);
  const sb = await connect(tokenB);
  await new Promise(r => setTimeout(r, 100));

  // Resolve only on the per-task broadcast (ignore the project-create one below).
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no per-task broadcast arrived')), 5000);
    sb.on('state:updated', (payload) => {
      if (payload && payload.taskUpsert) { clearTimeout(timer); resolve(payload); }
    });
  });

  // Parent project must exist before a per-task PUT. Use the per-project
  // subdomain endpoint so we don't destructively replace other tests' data.
  let cur = await request(app).get('/api/state').set('Authorization', `Bearer ${tokenA}`);
  await request(app)
    .put('/api/state/projects/rtp1')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ project: { id: 'rtp1', name: 'RT Proj', tasks: [] }, clientId: 'client-A', expectedVersion: cur.body.version })
    .expect(200);

  // The actual per-task write whose delta must reach other clients.
  cur = await request(app).get('/api/state').set('Authorization', `Bearer ${tokenA}`);
  await request(app)
    .put('/api/state/projects/rtp1/tasks/t1')
    .set('Authorization', `Bearer ${tokenA}`)
    // actingAs is the editor's "act as" identity; the toast should credit it,
    // not the login account name ('Alice').
    .send({ task: { id: 't1', title: 'Hello RT' }, clientId: 'client-A', actingAs: 'Jane Estimator', expectedVersion: cur.body.version })
    .expect(200);

  const payload = await received;
  assert.ok(payload.taskUpsert, 'broadcast carries the taskUpsert delta');
  assert.equal(payload.taskUpsert.projectId, 'rtp1');
  assert.equal(payload.taskUpsert.task.id, 't1');
  assert.equal(payload.taskUpsert.task.title, 'Hello RT');
  assert.equal(typeof payload.version, 'number', 'broadcast carries the new version');
  assert.equal(payload.byUserName, 'Jane Estimator', 'toast credits the act-as identity, not the login');
  sa.disconnect();
  sb.disconnect();
});
