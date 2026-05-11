process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.STATIC_DIR = '';
process.env.ANTHROPIC_FAKE = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { closeDb } = require('../src/db');
const { buildApp } = require('../src/server');

let app, token, projectId, bidId;

test.before(async () => {
  app = buildApp();
  const signup = await request(app).post('/api/auth/signup').send({
    email: 'bid-intake@test.local',
    password: 'password123',
    name: 'Bid Intake Admin',
  });
  token = signup.body.token;
  const proj = await request(app).post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Bid Intake Test Project' });
  projectId = proj.body.id;
});

test.after(() => {
  const dir = path.join(require('os').tmpdir(), 'sbg-tracker-uploads-' + process.pid);
  try {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
      fs.rmdirSync(dir);
    }
  } catch {}
  closeDb();
});

test('POST /api/projects/:id/bid-intake/upload imports a sub bid row', async () => {
  const fakePdf = Buffer.from('%PDF-1.4\nfake subcontractor bid content');
  const res = await request(app)
    .post(`/api/projects/${projectId}/bid-intake/upload`)
    .set('Authorization', `Bearer ${token}`)
    .attach('pdf', fakePdf, 'Acme Concrete.pdf');

  assert.equal(res.status, 201);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'imported');
  assert.equal(res.body.subBid.subName, 'Acme Concrete');
  assert.equal(res.body.subBid.total, 123456.78);
  assert.ok(res.body.subBid.attachmentId);
  bidId = res.body.subBid.id;
});

test('GET /api/projects/:id/sub-bids lists imported rows', async () => {
  const res = await request(app)
    .get(`/api/projects/${projectId}/sub-bids`)
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, bidId);
  assert.equal(res.body[0].reviewStatus, 'needs-review');
});

test('PATCH /api/projects/:id/sub-bids/:bidId updates review fields', async () => {
  const res = await request(app)
    .patch(`/api/projects/${projectId}/sub-bids/${bidId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      reviewStatus: 'reviewed',
      total: 125000,
      exclusions: ['demo by others'],
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.reviewStatus, 'reviewed');
  assert.equal(res.body.total, 125000);
  assert.deepEqual(res.body.exclusions, ['demo by others']);
});

test('POST /api/projects/:id/bid-intake/email-poll 503s without inbox config', async () => {
  const res = await request(app)
    .post(`/api/projects/${projectId}/bid-intake/email-poll`)
    .set('Authorization', `Bearer ${token}`)
    .send({ limit: 5 });

  assert.equal(res.status, 503);
});
