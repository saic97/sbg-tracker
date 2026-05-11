process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.STATIC_DIR = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { closeDb } = require('../src/db');
const { buildApp } = require('../src/server');

let app, token, projectId;

test.before(async () => {
  app = buildApp();
  const signup = await request(app).post('/api/auth/signup').send({
    email: 'attach@test.local', password: 'password123', name: 'Attacher'
  });
  token = signup.body.token;
  const proj = await request(app).post('/api/projects')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Attach Test Project' });
  projectId = proj.body.id;
});

test.after(() => {
  // Clean up the temp uploads dir created by storage.js when DB is :memory:
  const dir = path.join(require('os').tmpdir(), 'sbg-tracker-uploads-' + process.pid);
  try {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
      fs.rmdirSync(dir);
    }
  } catch {}
  closeDb();
});

test('POST /api/attachments uploads a file and creates a record', async () => {
  const fakePdf = Buffer.from('%PDF-1.4\nfake spec content for testing');
  const res = await request(app)
    .post('/api/attachments')
    .set('Authorization', `Bearer ${token}`)
    .field('projectId', projectId)
    .attach('file', fakePdf, 'spec.pdf');
  assert.equal(res.status, 201);
  assert.equal(res.body.filename, 'spec.pdf');
  assert.equal(res.body.project_id, projectId);
  assert.ok(res.body.size_bytes > 0);
  assert.ok(res.body.storage_key);
});

test('GET /api/projects/:id/attachments lists the upload', async () => {
  const res = await request(app)
    .get(`/api/projects/${projectId}/attachments`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].filename, 'spec.pdf');
});

test('GET /api/attachments/:id/download returns the file bytes', async () => {
  const list = await request(app)
    .get(`/api/projects/${projectId}/attachments`)
    .set('Authorization', `Bearer ${token}`);
  const id = list.body[0].id;
  const res = await request(app)
    .get(`/api/attachments/${id}/download`)
    .set('Authorization', `Bearer ${token}`)
    .buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/pdf/);
  assert.ok(res.body.toString('utf8').startsWith('%PDF-1.4'));
});

test('DELETE /api/attachments/:id removes the row + file', async () => {
  const list = await request(app)
    .get(`/api/projects/${projectId}/attachments`)
    .set('Authorization', `Bearer ${token}`);
  const id = list.body[0].id;
  await request(app)
    .delete(`/api/attachments/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(204);
  const after = await request(app)
    .get(`/api/projects/${projectId}/attachments`)
    .set('Authorization', `Bearer ${token}`);
  assert.equal(after.body.length, 0);
});

test('POST /api/attachments without a file 400s', async () => {
  const res = await request(app)
    .post('/api/attachments')
    .set('Authorization', `Bearer ${token}`)
    .field('projectId', projectId);
  assert.equal(res.status, 400);
});

test('POST /api/attachments without auth 401s', async () => {
  const res = await request(app)
    .post('/api/attachments')
    .attach('file', Buffer.from('x'), 'x.txt');
  assert.equal(res.status, 401);
});
