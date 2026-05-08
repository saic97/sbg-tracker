process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.STATIC_DIR = '';
process.env.ANTHROPIC_FAKE = '1';   // force the deterministic stub

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { closeDb } = require('../src/db');
const { buildApp } = require('../src/server');

let app;
let token;

test.before(async () => {
  app = buildApp();
  const res = await request(app).post('/api/auth/signup').send({
    email: 'ai-admin@test.local', password: 'password123', name: 'AI Admin'
  });
  token = res.body.token;
});

test.after(() => { closeDb(); });

test('POST /api/ai/scope-extract returns stub when ANTHROPIC_FAKE=1', async () => {
  // Build a fake "PDF" buffer -- the stub doesn't actually parse it.
  const fakePdf = Buffer.from('%PDF-1.4 fake test content');
  const res = await request(app)
    .post('/api/ai/scope-extract')
    .set('Authorization', `Bearer ${token}`)
    .attach('pdf', fakePdf, 'spec.pdf');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.result.project);
  assert.ok(res.body.result.tasks.length >= 1);
  assert.equal(res.body.result.project.name.startsWith('Stub'), true);
});

test('POST /api/ai/scope-extract 401s without auth', async () => {
  const res = await request(app)
    .post('/api/ai/scope-extract')
    .attach('pdf', Buffer.from('x'), 'x.pdf');
  assert.equal(res.status, 401);
});

test('POST /api/ai/scope-extract 400s without a file', async () => {
  const res = await request(app)
    .post('/api/ai/scope-extract')
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 400);
});
