process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.STATIC_DIR = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { closeDb } = require('../src/db');
const { buildApp } = require('../src/server');

let app;
test.before(() => { app = buildApp(); });
test.after(() => { closeDb(); });

test('first signup becomes admin', async () => {
  const res = await request(app).post('/api/auth/signup').send({
    email: 'first@example.com', password: 'longenough', name: 'First'
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, 'admin');
  assert.ok(res.body.token);
});

test('second signup is a member, not admin', async () => {
  const res = await request(app).post('/api/auth/signup').send({
    email: 'second@example.com', password: 'longenough'
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, 'estimator');
});

test('signup rejects short password', async () => {
  const res = await request(app).post('/api/auth/signup').send({ email: 'x@y.com', password: 'short' });
  assert.equal(res.status, 400);
});

test('signup rejects duplicate email', async () => {
  const res = await request(app).post('/api/auth/signup').send({ email: 'first@example.com', password: 'longenough' });
  assert.equal(res.status, 409);
});

test('login works with correct credentials', async () => {
  const res = await request(app).post('/api/auth/login').send({ email: 'first@example.com', password: 'longenough' });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.user.email, 'first@example.com');
});

test('login fails with wrong password', async () => {
  const res = await request(app).post('/api/auth/login').send({ email: 'first@example.com', password: 'WRONG' });
  assert.equal(res.status, 401);
});

test('GET /api/auth/me returns user when token is valid', async () => {
  const login = await request(app).post('/api/auth/login').send({ email: 'first@example.com', password: 'longenough' });
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'first@example.com');
});

test('GET /api/auth/me 401s without token', async () => {
  const me = await request(app).get('/api/auth/me');
  assert.equal(me.status, 401);
});

test('logout invalidates the token', async () => {
  const login = await request(app).post('/api/auth/login').send({ email: 'first@example.com', password: 'longenough' });
  const token = login.body.token;
  await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`).expect(204);
  const after = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.equal(after.status, 401);
});

test('GET /api/auth/config reflects state', async () => {
  const res = await request(app).get('/api/auth/config');
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.signupEnabled, 'boolean');
  assert.equal(res.body.isFirstUser, false);
});
