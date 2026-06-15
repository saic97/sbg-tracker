/* =============================================================================
 * models.js -- Thin data-access layer over SQLite.
 * =============================================================================
 */
const crypto = require('crypto');
const { getDb, parseJson } = require('./db');

function uid() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex').slice(0, 6);
}

function now() { return Date.now(); }

const kv = {
  get(key) {
    const row = getDb().prepare('SELECT value FROM key_value WHERE key=?').get(key);
    return row ? parseJson(row.value, null) : null;
  },
  set(key, value) {
    getDb().prepare(`INSERT INTO key_value (key, value, updated_at)
                     VALUES (?, ?, datetime('now'))
                     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
           .run(key, JSON.stringify(value === undefined ? null : value));
  },
  remove(key) {
    getDb().prepare('DELETE FROM key_value WHERE key=?').run(key);
  },
  all() {
    const rows = getDb().prepare('SELECT key, value FROM key_value').all();
    const out = {};
    for (const r of rows) out[r.key] = parseJson(r.value, null);
    return out;
  },
};

function makeEntity(table, typedCols, withTimestamps = true) {
  const allCols = ['id', ...typedCols, 'data', ...(withTimestamps ? ['created_at', 'updated_at'] : [])];
  const insertCols = allCols.filter(c => c !== 'created_at' && c !== 'updated_at');
  const insertSql = `INSERT INTO ${table} (${insertCols.join(',')}) VALUES (${insertCols.map(() => '?').join(',')})`;
  const updateSqlFor = (cols) => `UPDATE ${table} SET ${cols.map(c => `${c}=?`).join(', ')}${withTimestamps ? ", updated_at=CAST(strftime('%s','now') AS INTEGER)*1000" : ''} WHERE id=?`;

  function rowToObject(row) {
    if (!row) return null;
    const out = { id: row.id };
    for (const c of typedCols) out[c] = row[c];
    Object.assign(out, parseJson(row.data, {}));
    if (withTimestamps) {
      out.createdAt = row.created_at;
      out.updatedAt = row.updated_at;
    }
    return out;
  }

  function objectToColumns(obj) {
    const cols = {};
    for (const c of typedCols) {
      if (Object.prototype.hasOwnProperty.call(obj, c)) cols[c] = obj[c];
    }
    const data = {};
    for (const k of Object.keys(obj)) {
      if (k === 'id' || k === 'createdAt' || k === 'updatedAt' || k === 'created_at' || k === 'updated_at') continue;
      if (typedCols.includes(k)) continue;
      data[k] = obj[k];
    }
    cols.data = JSON.stringify(data);
    return cols;
  }

  function coerce(v) {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  }

  return {
    list(where = '', params = []) {
      const sql = `SELECT * FROM ${table}${where ? ' WHERE ' + where : ''}`;
      return getDb().prepare(sql).all(...params).map(rowToObject);
    },
    get(id) {
      const row = getDb().prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
      return rowToObject(row);
    },
    create(input) {
      const id = input.id || uid();
      const obj = { ...input, id };
      const cols = objectToColumns(obj);
      const values = insertCols.map(c => {
        if (c === 'id') return id;
        if (c === 'data') return cols.data;
        return coerce(cols[c]);
      });
      getDb().prepare(insertSql).run(...values);
      return this.get(id);
    },
    update(id, patch) {
      const existing = this.get(id);
      if (!existing) return null;
      const merged = { ...existing, ...patch, id };
      const cols = objectToColumns(merged);
      const colNames = [...typedCols, 'data'];
      const values = colNames.map(c => coerce(cols[c]));
      values.push(id);
      getDb().prepare(updateSqlFor(colNames)).run(...values);
      return this.get(id);
    },
    remove(id) {
      const info = getDb().prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
      return info.changes > 0;
    },
    replaceAll(items) {
      const db = getDb();
      const self = this;
      const txn = db.transaction((arr) => {
        db.prepare(`DELETE FROM ${table}`).run();
        for (const it of arr) self.create(it);
      });
      txn(items || []);
      return this.list();
    },
  };
}

const _projectsEntity = makeEntity('projects', [
  'name', 'client', 'location', 'status', 'archived', 'start_date', 'due_date'
]);
// Wrapper: provide sensible defaults for NOT NULL columns when callers omit them.
const projects = {
  ..._projectsEntity,
  create(input) {
    return _projectsEntity.create({ archived: 0, ...input });
  },
};
const tasks = makeEntity('tasks', [
  'project_id', 'title', 'stage', 'category', 'priority', 'status',
  'due_date', 'start_by_date', 'day_offset', 'assignee', 'source', 'notes'
]);
const teamMembers = makeEntity('team_members', ['name', 'title', 'email'], false);
const stages = makeEntity('stages', ['name', 'icon', 'description', 'position'], false);
const taskTemplates = makeEntity('task_templates', ['name', 'description', 'icon', 'color', 'is_default']);
const holidays = makeEntity('holidays', ['name', 'date', 'recurring'], false);
const ballInCourtOptions = makeEntity('ball_in_court_options', ['name', 'position'], false);
const csiDivisions = makeEntity('csi_divisions', ['name', 'number', 'position'], false);
const sourceOptions = makeEntity('source_options', ['name', 'icon', 'photo', 'position'], false);
const milestoneTypes = makeEntity('milestone_types', ['name', 'icon', 'color', 'default_days_before_bid', 'position'], false);
const notifications = makeEntity('notifications', [
  'user_id', 'kind', 'title', 'body', 'link', 'entity', 'entity_id', 'read_at'
], false);
notifications.listForUser = (userId, opts = {}) => {
  const { unreadOnly = false, limit = 50, offset = 0 } = opts;
  const where = ['user_id = ?'];
  const params = [userId];
  if (unreadOnly) where.push('read_at IS NULL');
  const sql = `SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  return getDb().prepare(sql).all(...params, limit, offset).map(row => {
    const out = { id: row.id };
    for (const c of ['user_id','kind','title','body','link','entity','entity_id','read_at']) out[c] = row[c];
    Object.assign(out, (row.data ? parseJson(row.data, {}) : {}));
    out.createdAt = row.created_at;
    return out;
  });
};
notifications.unreadCount = (userId) => {
  return getDb().prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL').get(userId).n;
};
notifications.markRead = (id, userId) => {
  const info = getDb().prepare('UPDATE notifications SET read_at = ? WHERE id=? AND user_id=?')
                       .run(Date.now(), id, userId);
  return info.changes > 0;
};
notifications.markAllRead = (userId) => {
  getDb().prepare('UPDATE notifications SET read_at = ? WHERE user_id=? AND read_at IS NULL')
         .run(Date.now(), userId);
};

const attachments = makeEntity('attachments', [
  'project_id', 'task_id', 'filename', 'content_type', 'size_bytes', 'storage_key', 'uploaded_by'
]);
attachments.listByProject = (pid) => attachments.list('project_id=?', [pid]);
attachments.listByTask = (tid) => attachments.list('task_id=?', [tid]);


function audit(action, entity, entityId, payload) {
  try {
    getDb().prepare('INSERT INTO audit_log (action, entity, entity_id, payload) VALUES (?, ?, ?, ?)')
           .run(action, entity, entityId || null, payload ? JSON.stringify(payload).slice(0, 4000) : null);
  } catch (e) {
    console.warn('[audit] failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// State versioning (optimistic concurrency for PUT /api/state).
//
// Background: the bulk PUT /api/state endpoint runs DELETE FROM projects
// before re-inserting from the request body. Without a version check, any
// authenticated client -- including a stale browser tab whose localStorage
// snapshot pre-dates a recently-added project -- can wipe live data. The
// version counter (migration 007) makes those PUTs reject with 409 before
// any DELETE runs.
//
// `state_version` is stored in key_value (initialized to 0 by 007). It is
// bumped only by saveStateBlob; per-entity routes do not change it because
// they don't compete with the bulk PUT for the same fields. Sub-bid /
// bid-intake mutations also leave it alone -- they preserve unrelated state
// via the `preservedProjectData` map below, so a stale bulk PUT can't drop
// their changes.
// ---------------------------------------------------------------------------
const SNAPSHOT_RETENTION = 50;
// Snapshot cadence for incremental (subdomain) writes. Snapshotting every
// save serialized the FULL state blob on every keystroke-burst (CPU + 50x
// blob-size on disk). Whole-state PUTs and project deletes still always
// snapshot (those are the writes you want a restore point right before);
// routine incremental saves snapshot every Nth version.
const SNAPSHOT_EVERY = 10;

function getStateVersion() {
  const v = kv.get('state_version');
  return typeof v === 'number' ? v : 0;
}
function bumpStateVersion() {
  const v = getStateVersion() + 1;
  kv.set('state_version', v);
  return v;
}

// ---------------------------------------------------------------------------
// Per-subdomain write tracking.
//
// The global version alone makes ANY two concurrent writers conflict, even
// when they touch unrelated subdomains (user A saves project X, user B's
// save of project Y half a second later carries a stale expectedVersion and
// gets a 409). That false conflict drops B's edit and forces a full-state
// refresh -- the "lag" users feel when two people work at once.
//
// We record, per subdomain key, the global version at which it was last
// written. A subdomain PUT with a stale expectedVersion is then only a
// conflict if THAT subdomain changed after expectedVersion; otherwise the
// write is accepted and the global version advances.
//
// Keys are HIERARCHICAL:
//   '*'                          whole-state writes (bulk PUT /api/state)
//   'project:<id>'               whole-project writes (create / bulk fallback)
//   'project:<id>:task:<tid>'    a single task
//   'project:<id>:meta'          a project's non-task fields
//   'teamMembers' / 'templates' / 'settings:<group>'
//
// Conflict checks honor the hierarchy so there are no lost updates:
//   - a task/meta write conflicts if its own key, its parent 'project:<id>',
//     or '*' moved since the client's version;
//   - a whole-project write conflicts if the project key, '*', OR ANY of its
//     child task/meta keys moved (so a per-task edit can't be clobbered by a
//     concurrent whole-project replace).
// A whole-project write supersedes (clears) its child keys; '*' clears all.
//
// On first run after upgrade the map doesn't exist; we seed it with
// {'*': currentVersion} so pre-upgrade history is conservatively treated as
// "everything changed" and stale tabs still conflict exactly as before.
//
// The map lives in one kv JSON row, so we cap it (oldest/lowest-version child
// keys evicted first) to keep that row small. Eviction only risks a missed
// conflict for a client more than ~thousands of versions stale writing the
// exact evicted task -- pathological, and such a client is already caught by
// the global guards on any bulk op.
// ---------------------------------------------------------------------------
const MAX_SUBDOMAIN_KEYS = 4000;
const SUBDOMAIN_PRUNE_TO = 3000;

function getSubdomainVersions() {
  let map = kv.get('subdomain_versions');
  if (!map || typeof map !== 'object') {
    map = { '*': getStateVersion() };
    kv.set('subdomain_versions', map);
  }
  return map;
}

function pruneSubdomainVersions(map) {
  const keys = Object.keys(map);
  if (keys.length <= MAX_SUBDOMAIN_KEYS) return;
  const evictable = keys.filter(k => k !== '*').sort((a, b) => (map[a] || 0) - (map[b] || 0));
  const dropCount = keys.length - SUBDOMAIN_PRUNE_TO;
  for (let i = 0; i < dropCount && i < evictable.length; i++) delete map[evictable[i]];
}

function markSubdomainsWritten(keys, version) {
  const map = getSubdomainVersions();
  for (const k of keys) {
    map[k] = version;
    // A whole-project write supersedes its child task/meta keys.
    if (/^project:[^:]+$/.test(k)) {
      const prefix = k + ':';
      for (const existing of Object.keys(map)) {
        if (existing.startsWith(prefix)) delete map[existing];
      }
    }
  }
  // A whole-state write supersedes every per-key entry.
  if (keys.includes('*')) {
    for (const k of Object.keys(map)) if (k !== '*') delete map[k];
  }
  pruneSubdomainVersions(map);
  kv.set('subdomain_versions', map);
}

function subdomainChangedSince(key, sinceVersion) {
  const map = getSubdomainVersions();
  let maxV = typeof map['*'] === 'number' ? map['*'] : 0;
  if (typeof map[key] === 'number' && map[key] > maxV) maxV = map[key];
  // Child (task/meta) -> also covered by a whole-project write on its parent.
  const child = /^(project:[^:]+):/.exec(key);
  if (child && typeof map[child[1]] === 'number' && map[child[1]] > maxV) maxV = map[child[1]];
  // Parent project -> also covered by ANY child task/meta write.
  if (/^project:[^:]+$/.test(key)) {
    const prefix = key + ':';
    for (const k of Object.keys(map)) {
      if (k.startsWith(prefix) && typeof map[k] === 'number' && map[k] > maxV) maxV = map[k];
    }
  }
  return maxV > sinceVersion;
}

// Cheap wrapper for incremental writes: only assembles + stores the full
// blob on the SNAPSHOT_EVERY cadence so routine saves stay light.
function maybeRecordSnapshot(version, userId) {
  if (version % SNAPSHOT_EVERY !== 0) return;
  recordStateSnapshot(version, userId, loadStateBlob());
}

function recordStateSnapshot(version, userId, state) {
  try {
    const blob = JSON.stringify(state);
    const projectCount = Array.isArray(state.projects) ? state.projects.length : null;
    const taskCount = Array.isArray(state.projects)
      ? state.projects.reduce((s, p) => s + (Array.isArray(p.tasks) ? p.tasks.length : 0), 0)
      : null;
    const db = getDb();
    db.prepare(
      'INSERT INTO state_snapshots (version, user_id, project_count, task_count, blob) VALUES (?, ?, ?, ?, ?)'
    ).run(version, userId || null, projectCount, taskCount, blob);
    // Rotate: keep only the most recent SNAPSHOT_RETENTION rows. Doing this
    // in app code (vs a trigger) lets us tune the limit without a migration.
    db.prepare(
      'DELETE FROM state_snapshots WHERE id NOT IN (SELECT id FROM state_snapshots ORDER BY id DESC LIMIT ?)'
    ).run(SNAPSHOT_RETENTION);
  } catch (e) {
    console.warn('[snapshot] failed:', e.message);
  }
}

// Everything in this list is the source-of-truth responsibility of a real
// table; loadStateBlob() always overwrites these keys from the tables, so
// copies of them inside the kv 'state' row are pure dead weight. Historically
// the full incoming blob (projects + tasks + embedded files included) was
// rewritten into kv on every save -- a multi-MB write per keystroke-burst.
const TABLE_BACKED_KEYS = [
  'projects', 'teamMembers', 'taskTemplates', 'stages', 'holidays',
  'ballInCourtOptions', 'csiDivisions', 'sourceOptions', 'milestoneTypes',
];

function stripTableBackedKeys(state) {
  const out = { ...state };
  for (const k of TABLE_BACKED_KEYS) delete out[k];
  return out;
}

// Per-device / per-tab UI preferences that the server must never store or
// emit. Each browser owns its own copy in localStorage. Persisting these
// workspace-wide meant one user toggling their sidebar (or picking who they
// "act as") bumped the shared version and pushed that UI state onto everyone
// else. They are scrubbed on both read (loadStateBlob) and write
// (saveSettingsState) so no stale copy can leak back out.
const DEVICE_LOCAL_KEYS = ['sidebarCollapsed', 'homeView', 'currentUser'];

function stripDeviceLocalKeys(state) {
  const out = { ...state };
  for (const k of DEVICE_LOCAL_KEYS) delete out[k];
  return out;
}

function loadStateBlob() {
  const blob = stripDeviceLocalKeys(kv.get('state') || {});
  return {
    ...blob,
    projects: projects.list().map(p => ({ ...p, tasks: tasks.list('project_id=?', [p.id]) })),
    teamMembers: teamMembers.list(),
    stages: stages.list().sort((a, b) => (a.position || 0) - (b.position || 0)),
    taskTemplates: taskTemplates.list(),
    holidays: holidays.list(),
    ballInCourtOptions: ballInCourtOptions.list().sort((a, b) => (a.position || 0) - (b.position || 0)),
    csiDivisions: csiDivisions.list().sort((a, b) => (a.position || 0) - (b.position || 0)),
    sourceOptions: sourceOptions.list().sort((a, b) => (a.position || 0) - (b.position || 0)),
    milestoneTypes: milestoneTypes.list().sort((a, b) => (a.position || 0) - (b.position || 0)),
  };
}

function saveStateBlob(state, opts = {}) {
  if (!state || typeof state !== 'object') throw new Error('state must be an object');
  const { expectedVersion, confirmDestructive = false, userId = null } = opts;
  const db = getDb();
  const currentVersion = getStateVersion();

  // ---- Guard 1: optimistic concurrency ------------------------------------
  // expectedVersion is required. Missing it == client predates this check
  // (cached older bundle); reject before doing anything destructive.
  // NOTE: conflict errors deliberately do NOT carry the full current state.
  // Embedding it meant every conflict response shipped the entire workspace
  // (multi-MB) back to the client; clients now refetch via GET /api/state,
  // which is gzip-compressed at the proxy and cheap to serve.
  if (typeof expectedVersion !== 'number') {
    const err = new Error('expectedVersion is required (your tab may be running an outdated version)');
    err.code = 'EXPECTED_VERSION_REQUIRED';
    err.currentVersion = currentVersion;
    throw err;
  }
  if (expectedVersion !== currentVersion) {
    const err = new Error('state version conflict: another tab/user wrote since you loaded');
    err.code = 'VERSION_CONFLICT';
    err.expectedVersion = expectedVersion;
    err.currentVersion = currentVersion;
    throw err;
  }

  // ---- Guard 2: destructive-delete safety net -----------------------------
  // Versioning alone catches the failure modes we know about, but if a stale
  // tab somehow has the right version (e.g. just received a broadcast) and
  // its blob is missing a project, we still don't want a silent wipe. Only
  // an explicit confirmDestructive: true bypasses this.
  if (Array.isArray(state.projects) && !confirmDestructive) {
    const currentProjects = db.prepare('SELECT id, name FROM projects').all();
    const incomingIds = new Set(state.projects.map(p => p && p.id).filter(Boolean));
    const droppedProjects = currentProjects.filter(p => !incomingIds.has(p.id));
    if (droppedProjects.length > 0) {
      const err = new Error('save would delete existing project(s); pass confirmDestructive to override');
      err.code = 'DESTRUCTIVE_DELETE';
      err.droppedProjects = droppedProjects.map(p => ({ id: p.id, name: p.name }));
      err.currentVersion = currentVersion;
      throw err;
    }
  }

  const preservedProjectData = new Map(
    db.prepare('SELECT id, data FROM projects').all().map(row => [row.id, parseJson(row.data, {})])
  );
  // Snapshot existing task assignees so we can diff after the save and surface
  // new/changed assignments to the caller (used to drive notifications).
  const beforeAssignees = new Map();
  for (const row of getDb().prepare('SELECT id, assignee FROM tasks').all()) {
    beforeAssignees.set(row.id, row.assignee || '');
  }
  const txn = db.transaction(() => {
    if (Array.isArray(state.projects)) {
      db.prepare('DELETE FROM tasks').run();
      db.prepare('DELETE FROM projects').run();
      for (const p of state.projects) {
        const preserved = preservedProjectData.get(p.id) || {};
        const hasSubBids = Object.prototype.hasOwnProperty.call(p, 'subBids');
        const projRow = {
          ...p,
          id: p.id || uid(),
          name: p.name || 'Untitled',
          client: p.client || null,
          location: p.location || null,
          status: p.status || null,
          archived: p.archived ? 1 : 0,
          start_date: p.startDate || p.start_date || null,
          due_date: p.dueDate || p.due_date || null,
          subBids: hasSubBids ? p.subBids : preserved.subBids,
        };
        delete projRow.tasks;
        projects.create(projRow);
        if (Array.isArray(p.tasks)) {
          for (const t of p.tasks) {
            tasks.create({
              ...t,
              id: t.id || uid(),
              project_id: projRow.id,
              title: t.title || '',
              stage: t.stage || null,
              category: t.category || null,
              priority: t.priority || null,
              status: t.status || 'not-started',
              due_date: t.dueDate || t.due_date || null,
              start_by_date: t.startByDate || t.start_by_date || null,
              day_offset: typeof t.dayOffset === 'number' ? t.dayOffset : null,
              assignee: t.assignee || null,
              source: t.source || null,
              notes: t.notes || null,
            });
          }
        }
      }
    }
    if (Array.isArray(state.teamMembers)) teamMembers.replaceAll(state.teamMembers);
    if (Array.isArray(state.stages)) stages.replaceAll(state.stages.map((s, i) => ({ ...s, position: i })));
    if (Array.isArray(state.taskTemplates)) taskTemplates.replaceAll(state.taskTemplates);
    if (Array.isArray(state.holidays)) holidays.replaceAll(state.holidays);
    if (Array.isArray(state.ballInCourtOptions)) ballInCourtOptions.replaceAll(state.ballInCourtOptions.map((s, i) => ({ ...s, position: i })));
    if (Array.isArray(state.csiDivisions)) csiDivisions.replaceAll(state.csiDivisions.map((s, i) => ({ ...s, position: i })));
    if (Array.isArray(state.sourceOptions)) sourceOptions.replaceAll(state.sourceOptions.map((s, i) => ({ ...s, position: i })));
    if (Array.isArray(state.milestoneTypes)) milestoneTypes.replaceAll(state.milestoneTypes.map((s, i) => ({ ...s, position: i })));

    kv.set('state', stripTableBackedKeys(state));
  });
  txn();
  // Bump the version + snapshot AFTER the txn commits so a failed write
  // doesn't leave the version desynced or a phantom snapshot lying around.
  const newVersion = bumpStateVersion();
  markSubdomainsWritten(['*'], newVersion);
  recordStateSnapshot(newVersion, userId, state);
  audit('state-put', 'state', null, {
    version: newVersion,
    userId,
    keys: Object.keys(state).slice(0, 50),
    projectCount: Array.isArray(state.projects) ? state.projects.length : null,
    // First 25 names are enough to spot "wait, project X is missing" in the
    // audit log without bloating the row past the 4000-char audit limit.
    projectNames: Array.isArray(state.projects)
      ? state.projects.slice(0, 25).map(p => p && p.name).filter(Boolean) : null,
    taskCount: Array.isArray(state.projects)
      ? state.projects.reduce((s, p) => s + (Array.isArray(p.tasks) ? p.tasks.length : 0), 0) : null,
  });

  // Compute the assignee diff: tasks where the assignee was set/changed in this save.
  const newAssignments = [];
  if (Array.isArray(state.projects)) {
    for (const p of state.projects) {
      if (!Array.isArray(p.tasks)) continue;
      for (const t of p.tasks) {
        const before = beforeAssignees.get(t.id) || '';
        const after = (t.assignee || '').trim();
        if (after && after !== before) {
          newAssignments.push({
            taskId: t.id, taskTitle: t.title || '(untitled task)',
            projectId: p.id, projectName: p.name || '(unnamed project)',
            assignee: after,
            previousAssignee: before,
          });
        }
      }
    }
  }
  return { state: loadStateBlob(), version: newVersion, newAssignments };
}

function touchState(version = null) {
  const newVersion = version !== null ? version : bumpStateVersion();
  return newVersion;
}

// Upsert a project ROW only (never touches the tasks table). subBids are
// server-authoritative (bid intake writes them outside the sync path), so
// they're preserved from the existing row unless the caller explicitly
// includes a `subBids` key.
function upsertProjectRow(project) {
  const db = getDb();
  const hasSubBids = Object.prototype.hasOwnProperty.call(project, 'subBids');
  const preserved = db.prepare('SELECT data FROM projects WHERE id=?').get(project.id);
  const preservedData = preserved ? parseJson(preserved.data, {}) : {};

  const projRow = {
    ...project,
    id: project.id || uid(),
    name: project.name || 'Untitled',
    client: project.client || null,
    location: project.location || null,
    status: project.status || null,
    archived: project.archived ? 1 : 0,
    start_date: project.startDate || project.start_date || null,
    due_date: project.dueDate || project.due_date || null,
    subBids: hasSubBids ? project.subBids : preservedData.subBids,
  };

  const projData = { ...projRow };
  for (const k of ['id', 'name', 'client', 'location', 'status', 'archived',
                   'startDate', 'dueDate', 'start_date', 'due_date', 'tasks']) {
    delete projData[k];
  }

  db.prepare(`INSERT INTO projects (id, name, client, location, status, archived, start_date, due_date, data)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, client=excluded.client, location=excluded.location,
                status=excluded.status, archived=excluded.archived,
                start_date=excluded.start_date, due_date=excluded.due_date, data=excluded.data`)
    .run(
      projRow.id, projRow.name, projRow.client, projRow.location, projRow.status,
      projRow.archived, projRow.start_date, projRow.due_date,
      JSON.stringify(projData)
    );
  return projRow.id;
}

// Upsert a single task ROW (INSERT ... ON CONFLICT so it works for both a
// fresh insert and an in-place edit, without disturbing sibling tasks).
function upsertTaskRow(projectId, t) {
  const db = getDb();
  const tRow = {
    ...t,
    id: t.id || uid(),
    project_id: projectId,
    title: t.title || '',
    stage: t.stage || null,
    category: t.category || null,
    priority: t.priority || null,
    status: t.status || 'not-started',
    due_date: t.dueDate || t.due_date || null,
    start_by_date: t.startByDate || t.start_by_date || null,
    day_offset: typeof t.dayOffset === 'number' ? t.dayOffset : null,
    assignee: t.assignee || null,
    source: t.source || null,
    notes: t.notes || null,
  };
  const tData = { ...tRow };
  for (const k of ['id', 'project_id', 'title', 'stage', 'category', 'priority',
                   'status', 'dueDate', 'due_date', 'startByDate', 'start_by_date',
                   'dayOffset', 'day_offset', 'assignee', 'source', 'notes']) {
    delete tData[k];
  }
  db.prepare(`INSERT INTO tasks (id, project_id, title, stage, category, priority, status, due_date, start_by_date, day_offset, assignee, source, notes, data)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                project_id=excluded.project_id, title=excluded.title, stage=excluded.stage,
                category=excluded.category, priority=excluded.priority, status=excluded.status,
                due_date=excluded.due_date, start_by_date=excluded.start_by_date,
                day_offset=excluded.day_offset, assignee=excluded.assignee,
                source=excluded.source, notes=excluded.notes, data=excluded.data`)
    .run(
      tRow.id, tRow.project_id, tRow.title, tRow.stage, tRow.category, tRow.priority, tRow.status,
      tRow.due_date, tRow.start_by_date, tRow.day_offset, tRow.assignee, tRow.source, tRow.notes,
      JSON.stringify(tData)
    );
  return tRow.id;
}

// Whole-project replace: upsert the project row, then delete+reinsert ALL its
// tasks. Used for project creation and the bulk-change fallback.
function saveProjectState(project) {
  const db = getDb();
  upsertProjectRow(project);
  db.prepare('DELETE FROM tasks WHERE project_id=?').run(project.id);
  if (Array.isArray(project.tasks)) {
    for (const t of project.tasks) upsertTaskRow(project.id, t);
  }
  // Projects/tasks live in their tables; loadStateBlob() reassembles from
  // there. No kv 'state' mirror update -- mirroring the full projects array
  // into kv on every project save was a multi-MB write per save.
}

// Project META only -- the non-task fields (name, client, dates, archived,
// notes, etc.). Leaves the tasks table untouched, so it can't clobber a
// concurrent per-task edit.
function saveProjectMeta(project) {
  upsertProjectRow(project);
}

// Single task upsert (per-task sync path).
function saveTaskState(projectId, task) {
  upsertTaskRow(projectId, task);
}

// Single task delete (per-task sync path).
function deleteTaskState(projectId, taskId) {
  getDb().prepare('DELETE FROM tasks WHERE id=? AND project_id=?').run(taskId, projectId);
}

function deleteProjectState(projectId) {
  const db = getDb();
  db.prepare('DELETE FROM tasks WHERE project_id=?').run(projectId);
  db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
}

function saveSettingsState(settings) {
  if (Array.isArray(settings.stages)) stages.replaceAll(settings.stages.map((s, i) => ({ ...s, position: i })));
  if (Array.isArray(settings.holidays)) holidays.replaceAll(settings.holidays);
  if (Array.isArray(settings.ballInCourtOptions)) ballInCourtOptions.replaceAll(settings.ballInCourtOptions.map((s, i) => ({ ...s, position: i })));
  if (Array.isArray(settings.csiDivisions)) csiDivisions.replaceAll(settings.csiDivisions.map((s, i) => ({ ...s, position: i })));
  if (Array.isArray(settings.sourceOptions)) sourceOptions.replaceAll(settings.sourceOptions.map((s, i) => ({ ...s, position: i })));
  if (Array.isArray(settings.milestoneTypes)) milestoneTypes.replaceAll(settings.milestoneTypes.map((s, i) => ({ ...s, position: i })));
  
  const current = kv.get('state') || {};
  // Strip both table-backed keys (owned by real tables) and device-local UI
  // prefs (owned by each browser) before persisting -- the kv 'state' row
  // holds only genuine shared scalars (e.g. companyLogo, skipWeekends).
  const merged = stripDeviceLocalKeys(stripTableBackedKeys({ ...current, ...settings }));
  kv.set('state', merged);
}

const projectTasks = {
  list(projectId) {
    return tasks.list('project_id=?', [projectId]);
  },
  get(projectId, taskId) {
    const t = tasks.get(taskId);
    if (!t || t.project_id !== projectId) return null;
    return t;
  },
  create(projectId, input) {
    return tasks.create({ ...input, project_id: projectId });
  },
  update(projectId, taskId, patch) {
    const t = tasks.get(taskId);
    if (!t || t.project_id !== projectId) return null;
    return tasks.update(taskId, { ...patch, project_id: projectId });
  },
  remove(projectId, taskId) {
    const t = tasks.get(taskId);
    if (!t || t.project_id !== projectId) return false;
    return tasks.remove(taskId);
  },
};

module.exports = {
  uid, now, kv, audit,
  projects, tasks, projectTasks, teamMembers, stages, taskTemplates,
  holidays, ballInCourtOptions, csiDivisions, sourceOptions, milestoneTypes,
  attachments, notifications,
  loadStateBlob, saveStateBlob, stripTableBackedKeys, stripDeviceLocalKeys,
  getStateVersion, bumpStateVersion, recordStateSnapshot, maybeRecordSnapshot,
  getSubdomainVersions, markSubdomainsWritten, subdomainChangedSince,
  touchState, saveProjectState, deleteProjectState, saveSettingsState,
  saveProjectMeta, saveTaskState, deleteTaskState,
};
