/* RBAC + admin endpoints */
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.STATIC_DIR = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { closeDb, getDb } = require('../src/db');
const { buildApp } = require('../src/server');

let app, adminToken, estimatorToken, viewerToken, viewerId, estimatorId;

test.before(async () => {
  app = buildApp();
  // 1st user = admin
  const admin = await request(app).post('/api/auth/signup')
    .send({ email: 'admin@rbac.test', password: 'password123', name: 'Admin' });
  adminToken = admin.body.token;
  // 2nd user = estimator (default)
  const est = await request(app).post('/api/auth/signup')
    .send({ email: 'est@rbac.test', password: 'password123', name: 'Estimator' });
  estimatorToken = est.body.token;
  estimatorId = est.body.user.id;
  // 3rd user = signup as estimator, then admin promotes to viewer
  const v = await request(app).post('/api/auth/signup')
    .send({ email: 'v@rbac.test', password: 'password123', name: 'Viewer' });
  viewerToken = v.body.token;
  viewerId = v.body.user.id;
  await request(app).patch('/api/admin/users/' + viewerId)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ role: 'viewer' }).expect(200);
});

test.after(() => { closeDb(); });

test('default role after first signup is admin', async () => {
  const res = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(res.body.user.role, 'admin');
});

test('default role for non-first signup is estimator', async () => {
  const res = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${estimatorToken}`);
  assert.equal(res.body.user.role, 'estimator');
});

test('estimator can create projects', async () => {
  await request(app).post('/api/projects')
    .set('Authorization', `Bearer ${estimatorToken}`)
    .send({ name: 'Estimator Project' })
    .expect(201);
});

test('viewer is read-only: GET works, POST/PUT/DELETE 403', async () => {
  await request(app).get('/api/projects')
    .set('Authorization', `Bearer ${viewerToken}`)
    .expect(200);
  const post = await request(app).post('/api/projects')
    .set('Authorization', `Bearer ${viewerToken}`)
    .send({ name: 'Should Fail' });
  assert.equal(post.status, 403);
  const put = await request(app).put('/api/state')
    .set('Authorization', `Bearer ${viewerToken}`)
    .send({ state: {} });
  assert.equal(put.status, 403);
});

test('non-admin cannot access admin endpoints', async () => {
  await request(app).get('/api/admin/users')
    .set('Authorization', `Bearer ${estimatorToken}`)
    .expect(403);
  await request(app).get('/api/admin/audit-log')
    .set('Authorization', `Bearer ${estimatorToken}`)
    .expect(403);
});

test('admin lists users with all three roles', async () => {
  const res = await request(app).get('/api/admin/users')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(res.status, 200);
  const roles = res.body.map(u => u.role).sort();
  assert.deepEqual(roles, ['admin', 'estimator', 'viewer']);
});

test('admin can change a user role', async () => {
  const res = await request(app).patch('/api/admin/users/' + estimatorId)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ role: 'viewer' });
  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'viewer');
  // Put them back so other tests still see an estimator
  await request(app).patch('/api/admin/users/' + estimatorId)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ role: 'estimator' }).expect(200);
});

test('cannot demote the last admin', async () => {
  // Get admin user id via /me
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
  const myId = me.body.user.id;
  const res = await request(app).patch('/api/admin/users/' + myId)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ role: 'viewer' });
  assert.equal(res.status, 400);
});

test('cannot delete yourself', async () => {
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${adminToken}`);
  const res = await request(app).delete('/api/admin/users/' + me.body.user.id)
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(res.status, 400);
});

test('admin can delete another user', async () => {
  // Create a throwaway
  const tmp = await request(app).post('/api/auth/signup')
    .send({ email: 'throwaway@rbac.test', password: 'password123' });
  const del = await request(app).delete('/api/admin/users/' + tmp.body.user.id)
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(del.status, 204);
});

test('audit-log returns recent events with payload + user info', async () => {
  const res = await request(app).get('/api/admin/audit-log?limit=10')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(typeof res.body.total === 'number');
  assert.ok(res.body.items.length >= 1);
});

test('audit-log filters by action', async () => {
  const res = await request(app).get('/api/admin/audit-log?action=update&entity=user')
    .set('Authorization', `Bearer ${adminToken}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.items.every(it => it.action === 'update' && it.entity === 'user'));
});
