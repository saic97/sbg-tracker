/* =============================================================================
 * data-fixups.test.js -- boot-time externalization of base64 deliverable
 * files into the attachments store (see src/dataFixups.js).
 * =============================================================================
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = ':memory:';
process.env.STATIC_DIR = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { closeDb } = require('../src/db');
const { buildApp } = require('../src/server');
const { externalizeDeliverableFiles } = require('../src/dataFixups');

let app, token;

test.before(async () => {
  app = buildApp();
  const r = await request(app).post('/api/auth/signup')
    .send({ email: 'admin@fixup.test', password: 'password123', name: 'Admin' });
  if (r.status !== 201) throw new Error('signup failed: ' + JSON.stringify(r.body));
  token = r.body.token;
});
test.after(() => { closeDb(); });

function authed(req) { return req.set('Authorization', `Bearer ${token}`); }

test('externalizeDeliverableFiles moves inline base64 into attachments', async () => {
  const fileBytes = Buffer.from('hello sbg deliverable');
  const dataUrl = 'data:text/plain;base64,' + fileBytes.toString('base64');
  const sample = {
    projects: [{
      id: 'fx-p1', name: 'Fixup Project', archived: false,
      tasks: [{
        id: 'fx-t1', title: 'Task with embedded file', status: 'not-started',
        deliverables: [{
          id: 'dlv1', description: 'Bid tab', fileName: 'bidtab.txt',
          fileData: dataUrl, fileType: 'text/plain', fileSize: fileBytes.length,
          done: false, required: true,
        }],
      }],
    }],
  };
  const cur = await authed(request(app).get('/api/state'));
  await authed(request(app).put('/api/state'))
    .send({ state: sample, expectedVersion: cur.body.version, confirmDestructive: true })
    .expect(200);

  const result = await externalizeDeliverableFiles();
  assert.equal(result.migrated, 1);
  assert.equal(result.failed || 0, 0);

  // The task's deliverable now references an attachment instead of inline data.
  const after = await authed(request(app).get('/api/state'));
  const task = after.body.state.projects.find(p => p.id === 'fx-p1').tasks[0];
  const dlv = task.deliverables[0];
  assert.equal(dlv.fileData, '');
  assert.ok(dlv.attachmentId);
  assert.equal(dlv.fileName, 'bidtab.txt');

  // The attachment row exists and downloads the original bytes.
  const dl = await authed(request(app).get(`/api/attachments/${dlv.attachmentId}/download`));
  assert.equal(dl.status, 200);
  assert.equal(dl.text, 'hello sbg deliverable');

  // Idempotent: second run is a no-op (flag latched).
  const again = await externalizeDeliverableFiles();
  assert.equal(again.migrated || 0, 0);
});
