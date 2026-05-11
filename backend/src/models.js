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

function loadStateBlob() {
  const blob = kv.get('state') || {};
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

function saveStateBlob(state) {
  if (!state || typeof state !== 'object') throw new Error('state must be an object');
  const db = getDb();
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

    kv.set('state', state);
  });
  txn();
  audit('state-put', 'state', null, { keys: Object.keys(state).slice(0, 50) });

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
  return { state: loadStateBlob(), newAssignments };
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
  attachments,
  notifications,
  loadStateBlob, saveStateBlob,
};
