/* =============================================================================
 * routes.js -- REST endpoints.
 *
 * All entity endpoints under /api/* require authentication EXCEPT:
 *   GET  /api/health        -- liveness probe
 *   POST /api/auth/signup
 *   POST /api/auth/login
 *   GET  /api/auth/config   -- whether signup is currently allowed
 *
 * Auth is via bearer token: send `Authorization: Bearer <token>` on every
 * request. Tokens are issued by /api/auth/login and /api/auth/signup. See
 * auth.js for the full flow.
 * =============================================================================
 */
const express = require('express');
const m = require('./models');
const auth = require('./auth');

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function buildRouter() {
  const r = express.Router();

  // ---- Public endpoints (no auth) ----
  r.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
  r.use('/auth', auth.buildRouter());

  // ---- Everything below this line requires auth ----
  r.use(auth.requireAuth);

  // ---- coarse state blob ----
  r.get('/state', asyncRoute(async (req, res) => {
    res.json({ state: m.loadStateBlob() });
  }));
  r.put('/state', asyncRoute(async (req, res) => {
    const { state, clientId } = req.body || {};
    if (!state || typeof state !== 'object') {
      return res.status(400).json({ error: 'body must include `state` object' });
    }
    const merged = m.saveStateBlob(state);
    // Broadcast to other connected clients in the workspace.
    try {
      const rt = require('./realtime');
      rt.broadcastStateChange({
        state: merged,
        byUserId: req.user.id,
        byUserName: req.user.name || req.user.email,
        clientId: clientId || null,
      });
    } catch (e) {
      console.warn('[routes] realtime broadcast skipped:', e.message);
    }
    res.json({ state: merged });
  }));

  // ---- projects ----
  r.get('/projects', asyncRoute(async (req, res) => res.json(m.projects.list())));
  r.post('/projects', asyncRoute(async (req, res) => {
    const created = m.projects.create(req.body || {});
    m.audit('create', 'project', created.id, { user: req.user.id });
    res.status(201).json(created);
  }));
  r.get('/projects/:id', asyncRoute(async (req, res) => {
    const p = m.projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    p.tasks = m.projectTasks.list(p.id);
    res.json(p);
  }));
  r.patch('/projects/:id', asyncRoute(async (req, res) => {
    const updated = m.projects.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'not found' });
    m.audit('update', 'project', updated.id, { user: req.user.id });
    res.json(updated);
  }));
  r.delete('/projects/:id', asyncRoute(async (req, res) => {
    const ok = m.projects.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    m.audit('delete', 'project', req.params.id, { user: req.user.id });
    res.status(204).end();
  }));

  // ---- tasks (nested under project) ----
  r.get('/projects/:id/tasks', asyncRoute(async (req, res) => {
    res.json(m.projectTasks.list(req.params.id));
  }));
  r.post('/projects/:id/tasks', asyncRoute(async (req, res) => {
    const created = m.projectTasks.create(req.params.id, req.body || {});
    m.audit('create', 'task', created.id, { project_id: req.params.id, user: req.user.id });
    res.status(201).json(created);
  }));
  r.get('/projects/:id/tasks/:taskId', asyncRoute(async (req, res) => {
    const t = m.projectTasks.get(req.params.id, req.params.taskId);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(t);
  }));
  r.patch('/projects/:id/tasks/:taskId', asyncRoute(async (req, res) => {
    const updated = m.projectTasks.update(req.params.id, req.params.taskId, req.body || {});
    if (!updated) return res.status(404).json({ error: 'not found' });
    m.audit('update', 'task', updated.id, { user: req.user.id });
    res.json(updated);
  }));
  r.delete('/projects/:id/tasks/:taskId', asyncRoute(async (req, res) => {
    const ok = m.projectTasks.remove(req.params.id, req.params.taskId);
    if (!ok) return res.status(404).json({ error: 'not found' });
    m.audit('delete', 'task', req.params.taskId, { user: req.user.id });
    res.status(204).end();
  }));

  attachCrud(r, '/team-members', m.teamMembers, 'team_member');
  attachReplaceAll(r, '/stages', m.stages, 'stages');
  attachCrud(r, '/templates', m.taskTemplates, 'template');
  attachReplaceAll(r, '/holidays', m.holidays, 'holidays');
  attachReplaceAll(r, '/options/ball-in-court', m.ballInCourtOptions, 'ballInCourtOptions');
  attachReplaceAll(r, '/options/csi-divisions', m.csiDivisions, 'csiDivisions');
  attachReplaceAll(r, '/options/sources', m.sourceOptions, 'sourceOptions');
  attachReplaceAll(r, '/options/milestone-types', m.milestoneTypes, 'milestoneTypes');

  r.get('/settings/:key', asyncRoute(async (req, res) => {
    res.json({ key: req.params.key, value: m.kv.get(req.params.key) });
  }));
  r.put('/settings/:key', asyncRoute(async (req, res) => {
    const { value } = req.body || {};
    m.kv.set(req.params.key, value);
    m.audit('update', 'setting', req.params.key, { user: req.user.id });
    res.json({ key: req.params.key, value });
  }));
  r.delete('/settings/:key', asyncRoute(async (req, res) => {
    m.kv.remove(req.params.key);
    m.audit('delete', 'setting', req.params.key, { user: req.user.id });
    res.status(204).end();
  }));

  // ---- AI: scope extraction from a PDF spec ----
  const multer = require('multer');
  const ai = require('./ai');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

  r.post('/ai/scope-extract', upload.single('pdf'), asyncRoute(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'multipart upload missing `pdf` file' });
    if (!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_FAKE !== '1') {
      return res.status(503).json({
        error: 'AI features disabled: set ANTHROPIC_API_KEY in /etc/sbg-tracker.env on the EC2 host'
      });
    }
    try {
      const result = await ai.scopeExtractFromPdf(req.file.buffer);
      m.audit('ai-extract', 'pdf', null, { user: req.user.id, bytes: req.file.size });
      res.json({ ok: true, result });
    } catch (err) {
      console.error('[ai] scope extract failed:', err);
      res.status(500).json({ error: err.message });
    }
  }));

  // ---- File attachments ----
  const storage = require('./storage');
  const uploadAttachment = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }   // 50 MB per file
  });

  r.post('/attachments', uploadAttachment.single('file'), asyncRoute(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'multipart upload missing `file` field' });
    const { projectId, taskId } = req.body || {};
    if (projectId && !m.projects.get(projectId)) {
      return res.status(400).json({ error: 'project not found' });
    }
    const storageKey = storage.generateKey(req.file.originalname);
    await storage.put(storageKey, req.file.buffer);
    const id = require('crypto').randomBytes(12).toString('hex');
    const created = m.attachments.create({
      id, project_id: projectId || null, task_id: taskId || null,
      filename: req.file.originalname,
      content_type: req.file.mimetype || 'application/octet-stream',
      size_bytes: req.file.size,
      storage_key: storageKey,
      uploaded_by: req.user.id,
    });
    m.audit('upload', 'attachment', id, { user: req.user.id, filename: req.file.originalname, size: req.file.size, projectId, taskId });
    res.status(201).json(created);
  }));

  r.get('/projects/:id/attachments', asyncRoute(async (req, res) => {
    res.json(m.attachments.listByProject(req.params.id));
  }));

  r.get('/tasks/:id/attachments', asyncRoute(async (req, res) => {
    res.json(m.attachments.listByTask(req.params.id));
  }));

  r.get('/attachments/:id/download', asyncRoute(async (req, res) => {
    const a = m.attachments.get(req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    if (!storage.exists(a.storage_key)) return res.status(404).json({ error: 'file missing from storage' });
    res.setHeader('Content-Type', a.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(a.filename || 'download')}"`);
    res.setHeader('Content-Length', String(a.size_bytes || storage.size(a.storage_key)));
    storage.getStream(a.storage_key).pipe(res);
  }));

  r.delete('/attachments/:id', asyncRoute(async (req, res) => {
    const a = m.attachments.get(req.params.id);
    if (!a) return res.status(404).json({ error: 'not found' });
    await storage.remove(a.storage_key);
    m.attachments.remove(req.params.id);
    m.audit('delete', 'attachment', req.params.id, { user: req.user.id, filename: a.filename });
    res.status(204).end();
  }));

  // ---- admin: list users (admin only) ----
  r.get('/admin/users', auth.requireAdmin, asyncRoute(async (req, res) => {
    const rows = m.kv && require('./db').getDb().prepare('SELECT id, email, name, role, disabled, created_at FROM users').all();
    res.json(rows || []);
  }));

  return r;
}

function attachCrud(router, prefix, entity, kind) {
  router.get(prefix, asyncRoute(async (req, res) => res.json(entity.list())));
  router.post(prefix, asyncRoute(async (req, res) => {
    const created = entity.create(req.body || {});
    m.audit('create', kind, created.id, { user: req.user.id });
    res.status(201).json(created);
  }));
  router.get(`${prefix}/:id`, asyncRoute(async (req, res) => {
    const item = entity.get(req.params.id);
    if (!item) return res.status(404).json({ error: 'not found' });
    res.json(item);
  }));
  router.patch(`${prefix}/:id`, asyncRoute(async (req, res) => {
    const updated = entity.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'not found' });
    m.audit('update', kind, updated.id, { user: req.user.id });
    res.json(updated);
  }));
  router.delete(`${prefix}/:id`, asyncRoute(async (req, res) => {
    const ok = entity.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    m.audit('delete', kind, req.params.id, { user: req.user.id });
    res.status(204).end();
  }));
}

function attachReplaceAll(router, prefix, entity, bodyKey) {
  router.get(prefix, asyncRoute(async (req, res) => {
    res.json(entity.list().sort((a, b) => (a.position || 0) - (b.position || 0)));
  }));
  router.put(prefix, asyncRoute(async (req, res) => {
    const items = (req.body && (req.body[bodyKey] || req.body.items)) || [];
    if (!Array.isArray(items)) return res.status(400).json({ error: `body must include \`${bodyKey}\` array` });
    const replaced = entity.replaceAll(items.map((it, i) => ({ ...it, position: i })));
    m.audit('update', bodyKey, null, { user: req.user.id });
    res.json(replaced);
  }));
}

module.exports = { buildRouter };
