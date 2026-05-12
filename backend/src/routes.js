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

  // ---- Viewer role is read-only. Block mutating verbs except for admin endpoints
  //      (which have their own requireAdmin), and except for /attachments/:id/download
  //      (a GET; not mutating). This single guard avoids decorating every route.
  r.use((req, res, next) => {
    if (!req.user) return next();  // requireAuth will have handled it
    if (req.user.role !== 'viewer') return next();
    // Viewer is allowed all GET requests.
    if (req.method === 'GET') return next();
    return res.status(403).json({ error: 'viewer role is read-only' });
  });

  // ---- coarse state blob ----
  r.get('/state', asyncRoute(async (req, res) => {
    res.json({ state: m.loadStateBlob() });
  }));
  r.put('/state', asyncRoute(async (req, res) => {
    const { state, clientId } = req.body || {};
    if (!state || typeof state !== 'object') {
      return res.status(400).json({ error: 'body must include `state` object' });
    }
    const { state: merged, newAssignments } = m.saveStateBlob(state);
    // Broadcast workspace-wide state change.
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
    // Fire notifications for every assignment created/changed in this save.
    try {
      const rt = require('./realtime');
      const { getDb } = require('./db');
      for (const a of (newAssignments || [])) {
        // Match assignee name (case-insensitive trim) to a user.
        const recipient = getDb().prepare(
          "SELECT id, name, email FROM users WHERE lower(trim(name)) = lower(trim(?)) AND disabled=0 LIMIT 1"
        ).get(a.assignee);
        if (!recipient) continue;
        // Don't notify yourself for changes you made to your own tasks.
        if (recipient.id === req.user.id) continue;
        const title = `${req.user.name || req.user.email} assigned you a task`;
        const body = `${a.taskTitle} — in ${a.projectName}`;
        const notif = m.notifications.create({
          user_id: recipient.id,
          kind: 'task_assigned',
          title, body,
          link: `#project=${encodeURIComponent(a.projectId)}&task=${encodeURIComponent(a.taskId)}`,
          entity: 'task', entity_id: a.taskId,
          assignedBy: { id: req.user.id, name: req.user.name || req.user.email },
          project: { id: a.projectId, name: a.projectName },
        });
        m.audit('create', 'notification', notif.id, { user: req.user.id, recipient: recipient.id, kind: 'task_assigned' });
        rt.emitToUser(recipient.id, 'notification:new', notif);
      }
    } catch (e) {
      console.warn('[routes] notification fan-out skipped:', e.message);
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

  // ---- Sub bid intake: email/manual PDF -> Claude -> project.subBids row ----
  const bidIntake = require('./bidIntake');
  const uploadSubBid = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

  r.get('/bid-intake/status', asyncRoute(async (req, res) => {
    res.json(bidIntake.status());
  }));

  r.post('/bid-intake/poll', auth.requireAdmin, asyncRoute(async (req, res) => {
    const limit = parseInt((req.body && req.body.limit) || req.query.limit || '25', 10);
    const summary = await bidIntake.pollInbox({ limit, userId: req.user.id });
    if (summary.imported) broadcastState(req);
    res.json({ ok: true, ...summary });
  }));

  r.get('/projects/:id/sub-bids', asyncRoute(async (req, res) => {
    res.json(bidIntake.listSubBids(req.params.id));
  }));

  r.post('/projects/:id/bid-intake/upload', uploadSubBid.single('pdf'), asyncRoute(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'multipart upload missing `pdf` file' });
    const result = await bidIntake.importSubBidPdf({
      projectId: req.params.id,
      pdfBuffer: req.file.buffer,
      filename: req.file.originalname,
      contentType: req.file.mimetype || 'application/pdf',
      source: 'manual-upload',
      userId: req.user.id,
      email: {
        subject: (req.body && req.body.subject) || '',
        fromEmail: req.user.email || '',
        fromName: req.user.name || '',
        receivedAt: new Date().toISOString(),
      },
      force: req.body && (req.body.force === '1' || req.body.force === 'true'),
    });
    if (result.status === 'imported') broadcastState(req);
    res.status(result.status === 'duplicate' ? 200 : 201).json({ ok: true, ...result });
  }));

  r.post('/projects/:id/bid-intake/email-poll', asyncRoute(async (req, res) => {
    const limit = parseInt((req.body && req.body.limit) || req.query.limit || '25', 10);
    const summary = await bidIntake.pollInbox({
      projectId: req.params.id,
      limit,
      userId: req.user.id,
    });
    if (summary.imported) broadcastState(req);
    res.json({ ok: true, ...summary });
  }));

  r.patch('/projects/:id/sub-bids/:bidId', asyncRoute(async (req, res) => {
    const updated = bidIntake.updateSubBid(req.params.id, req.params.bidId, req.body || {});
    broadcastState(req);
    res.json(updated);
  }));

  r.delete('/projects/:id/sub-bids/:bidId', asyncRoute(async (req, res) => {
    bidIntake.removeSubBid(req.params.id, req.params.bidId);
    broadcastState(req);
    res.status(204).end();
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

  // ---- Notifications (per-user inbox) ----
  r.get('/notifications', asyncRoute(async (req, res) => {
    const unreadOnly = req.query.unreadOnly === '1' || req.query.unreadOnly === 'true';
    const limit  = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);
    const items = m.notifications.listForUser(req.user.id, { unreadOnly, limit, offset });
    const unread = m.notifications.unreadCount(req.user.id);
    res.json({ items, unread });
  }));

  r.patch('/notifications/:id/read', asyncRoute(async (req, res) => {
    const ok = m.notifications.markRead(req.params.id, req.user.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, unread: m.notifications.unreadCount(req.user.id) });
  }));

  r.post('/notifications/read-all', asyncRoute(async (req, res) => {
    m.notifications.markAllRead(req.user.id);
    res.json({ ok: true, unread: 0 });
  }));

  r.delete('/notifications/:id', asyncRoute(async (req, res) => {
    const ok = m.notifications.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  }));

  // ---- admin: user management + audit log (admin only) ----
  const { getDb } = require('./db');

  r.get('/admin/users', auth.requireAdmin, asyncRoute(async (req, res) => {
    const rows = getDb().prepare('SELECT id, email, name, role, disabled, created_at, updated_at FROM users ORDER BY created_at ASC').all();
    res.json(rows);
  }));

  r.patch('/admin/users/:id', auth.requireAdmin, asyncRoute(async (req, res) => {
    const { role, name, disabled } = req.body || {};
    const target = getDb().prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'user not found' });
    // Prevent the only admin from accidentally demoting themselves and locking the workspace out.
    if (target.role === 'admin' && role && role !== 'admin') {
      const adminCount = getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").get().n;
      if (adminCount <= 1) return res.status(400).json({ error: 'cannot demote the last admin' });
    }
    const updates = [];
    const params = [];
    if (role !== undefined) {
      if (!['admin', 'estimator', 'viewer'].includes(role)) {
        return res.status(400).json({ error: 'role must be admin | estimator | viewer' });
      }
      updates.push('role=?'); params.push(role);
    }
    if (name !== undefined) { updates.push('name=?'); params.push(String(name).slice(0, 200)); }
    if (disabled !== undefined) { updates.push('disabled=?'); params.push(disabled ? 1 : 0); }
    if (!updates.length) return res.status(400).json({ error: 'no fields to update' });
    updates.push("updated_at=CAST(strftime('%s','now') AS INTEGER)*1000");
    params.push(req.params.id);
    getDb().prepare(`UPDATE users SET ${updates.join(', ')} WHERE id=?`).run(...params);
    const after = getDb().prepare('SELECT id, email, name, role, disabled, created_at, updated_at FROM users WHERE id=?').get(req.params.id);
    m.audit('update', 'user', req.params.id, { by: req.user.id, changes: { role, name, disabled } });
    res.json(after);
  }));

  r.delete('/admin/users/:id', auth.requireAdmin, asyncRoute(async (req, res) => {
    const target = getDb().prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'user not found' });
    if (target.role === 'admin') {
      const adminCount = getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").get().n;
      if (adminCount <= 1) return res.status(400).json({ error: 'cannot delete the last admin' });
    }
    if (target.id === req.user.id) return res.status(400).json({ error: 'cannot delete yourself' });
    getDb().prepare('DELETE FROM users WHERE id=?').run(req.params.id);
    m.audit('delete', 'user', req.params.id, { by: req.user.id, email: target.email });
    res.status(204).end();
  }));

  r.get('/admin/audit-log', auth.requireAdmin, asyncRoute(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);
    const where = [];
    const params = [];
    if (req.query.entity) { where.push('entity = ?'); params.push(req.query.entity); }
    if (req.query.action) { where.push('action = ?'); params.push(req.query.action); }
    if (req.query.user)   { where.push('user_id = ?'); params.push(req.query.user); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = getDb().prepare(`
      SELECT id, ts, action, entity, entity_id, user_id, payload
      FROM audit_log ${whereSql}
      ORDER BY ts DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    const users = getDb().prepare('SELECT id, email, name FROM users').all();
    const byId = Object.fromEntries(users.map(u => [u.id, u]));
    const decorated = rows.map(row => ({
      ...row,
      user: row.user_id ? byId[row.user_id] || null : null,
      payload: row.payload ? (() => { try { return JSON.parse(row.payload); } catch { return row.payload; } })() : null,
    }));
    const totalRow = getDb().prepare(`SELECT COUNT(*) AS n FROM audit_log ${whereSql}`).get(...params);
    res.json({ items: decorated, total: totalRow.n, limit, offset });
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
