/* =============================================================================
 * routes.js -- REST endpoints for the SBG Tracker.
 *
 * Endpoints
 * ---------
 *   GET    /api/health                       -- liveness check
 *   GET    /api/state                        -- full assembled state object
 *   PUT    /api/state                        -- replace canonical state blob (body: { state })
 *
 *   GET    /api/projects
 *   POST   /api/projects                     -- create
 *   GET    /api/projects/:id
 *   PATCH  /api/projects/:id                 -- partial update
 *   DELETE /api/projects/:id
 *
 *   GET    /api/projects/:id/tasks
 *   POST   /api/projects/:id/tasks           -- create
 *   GET    /api/projects/:id/tasks/:taskId
 *   PATCH  /api/projects/:id/tasks/:taskId
 *   DELETE /api/projects/:id/tasks/:taskId
 *
 *   GET    /api/team-members
 *   POST   /api/team-members
 *   PATCH  /api/team-members/:id
 *   DELETE /api/team-members/:id
 *
 *   GET    /api/stages
 *   PUT    /api/stages                       -- replace whole list (body: { stages: [...] })
 *
 *   GET    /api/templates
 *   POST   /api/templates
 *   PATCH  /api/templates/:id
 *   DELETE /api/templates/:id
 *
 *   GET    /api/holidays
 *   PUT    /api/holidays                     -- replace whole list
 *
 *   GET    /api/options/ball-in-court        -- list options
 *   PUT    /api/options/ball-in-court        -- replace list
 *   GET    /api/options/csi-divisions
 *   PUT    /api/options/csi-divisions
 *   GET    /api/options/sources
 *   PUT    /api/options/sources
 *   GET    /api/options/milestone-types
 *   PUT    /api/options/milestone-types
 *
 *   GET    /api/settings/:key                -- arbitrary key/value get
 *   PUT    /api/settings/:key                -- arbitrary key/value set (body: { value })
 * =============================================================================
 */
const express = require('express');
const m = require('./models');

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function buildRouter() {
  const r = express.Router();

  r.get('/health', (req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // ---- coarse state blob ----
  r.get('/state', asyncRoute(async (req, res) => {
    res.json({ state: m.loadStateBlob() });
  }));
  r.put('/state', asyncRoute(async (req, res) => {
    const { state } = req.body || {};
    if (!state || typeof state !== 'object') {
      return res.status(400).json({ error: 'body must include `state` object' });
    }
    const merged = m.saveStateBlob(state);
    res.json({ state: merged });
  }));

  // ---- projects ----
  r.get('/projects', asyncRoute(async (req, res) => res.json(m.projects.list())));
  r.post('/projects', asyncRoute(async (req, res) => {
    const created = m.projects.create(req.body || {});
    m.audit('create', 'project', created.id);
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
    m.audit('update', 'project', updated.id);
    res.json(updated);
  }));
  r.delete('/projects/:id', asyncRoute(async (req, res) => {
    const ok = m.projects.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    m.audit('delete', 'project', req.params.id);
    res.status(204).end();
  }));

  // ---- tasks (nested under project) ----
  r.get('/projects/:id/tasks', asyncRoute(async (req, res) => {
    res.json(m.projectTasks.list(req.params.id));
  }));
  r.post('/projects/:id/tasks', asyncRoute(async (req, res) => {
    const created = m.projectTasks.create(req.params.id, req.body || {});
    m.audit('create', 'task', created.id, { project_id: req.params.id });
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
    m.audit('update', 'task', updated.id);
    res.json(updated);
  }));
  r.delete('/projects/:id/tasks/:taskId', asyncRoute(async (req, res) => {
    const ok = m.projectTasks.remove(req.params.id, req.params.taskId);
    if (!ok) return res.status(404).json({ error: 'not found' });
    m.audit('delete', 'task', req.params.taskId);
    res.status(204).end();
  }));

  // ---- team members ----
  attachCrud(r, '/team-members', m.teamMembers, 'team_member');
  // ---- stages (replace-all PUT) ----
  attachReplaceAll(r, '/stages', m.stages, 'stages');
  // ---- task templates ----
  attachCrud(r, '/templates', m.taskTemplates, 'template');
  // ---- holidays ----
  attachReplaceAll(r, '/holidays', m.holidays, 'holidays');

  // ---- master option lists ----
  attachReplaceAll(r, '/options/ball-in-court', m.ballInCourtOptions, 'ballInCourtOptions');
  attachReplaceAll(r, '/options/csi-divisions', m.csiDivisions, 'csiDivisions');
  attachReplaceAll(r, '/options/sources', m.sourceOptions, 'sourceOptions');
  attachReplaceAll(r, '/options/milestone-types', m.milestoneTypes, 'milestoneTypes');

  // ---- arbitrary settings (key/value store) ----
  r.get('/settings/:key', asyncRoute(async (req, res) => {
    res.json({ key: req.params.key, value: m.kv.get(req.params.key) });
  }));
  r.put('/settings/:key', asyncRoute(async (req, res) => {
    const { value } = req.body || {};
    m.kv.set(req.params.key, value);
    m.audit('update', 'setting', req.params.key);
    res.json({ key: req.params.key, value });
  }));
  r.delete('/settings/:key', asyncRoute(async (req, res) => {
    m.kv.remove(req.params.key);
    m.audit('delete', 'setting', req.params.key);
    res.status(204).end();
  }));

  return r;
}

function attachCrud(router, prefix, entity, kind) {
  router.get(prefix, asyncRoute(async (req, res) => res.json(entity.list())));
  router.post(prefix, asyncRoute(async (req, res) => {
    const created = entity.create(req.body || {});
    m.audit('create', kind, created.id);
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
    m.audit('update', kind, updated.id);
    res.json(updated);
  }));
  router.delete(`${prefix}/:id`, asyncRoute(async (req, res) => {
    const ok = entity.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    m.audit('delete', kind, req.params.id);
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
    m.audit('update', bodyKey, null);
    res.json(replaced);
  }));
}

module.exports = { buildRouter };
