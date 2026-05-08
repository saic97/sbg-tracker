-- =============================================================================
-- SBG Tracker initial schema (v1).
--
-- The frontend ships with a deeply-nested state object (projects -> tasks ->
-- deliverables/checklists/notes/etc., plus dozens of cross-cutting maps and
-- toggles). To preserve every piece of functionality without a six-month
-- normalization project, the schema combines two strategies:
--
--   1. Normalized tables for the entities that obviously deserve them: projects,
--      tasks, team_members, stages, task_templates, holidays, milestone_types,
--      ball_in_court_options, csi_divisions, source_options.
--
--   2. A `key_value` settings store for everything else (companyLogo,
--      sidebarCollapsed, view modes, filters, toggles, etc.).
--
-- The application also exposes a coarse `/api/state` endpoint that hydrates the
-- whole frontend state object from these tables in one call -- this is what
-- the existing `loadState()` consumes, so the migration to a backend is a
-- drop-in change for the UI.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- ---- key/value store for arbitrary settings + the canonical state blob -------
CREATE TABLE IF NOT EXISTS key_value (
  key       TEXT PRIMARY KEY,
  value     TEXT NOT NULL,             -- JSON-encoded
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---- projects ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  client        TEXT,
  location      TEXT,
  status        TEXT,                  -- 'active' | 'archived' | etc.
  archived      INTEGER NOT NULL DEFAULT 0,   -- boolean (0/1)
  start_date    TEXT,                  -- yyyy-mm-dd
  due_date      TEXT,                  -- yyyy-mm-dd
  data          TEXT NOT NULL DEFAULT '{}',   -- JSON for any fields not promoted to columns
  created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived);
CREATE INDEX IF NOT EXISTS idx_projects_due_date ON projects(due_date);

-- ---- tasks (each task belongs to exactly one project) -----------------------
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  stage         TEXT,                  -- references stages.id (loose -- no FK so a stage delete doesn't cascade)
  category      TEXT,
  priority      TEXT,
  status        TEXT NOT NULL DEFAULT 'not-started',
  due_date      TEXT,
  start_by_date TEXT,
  day_offset    INTEGER,
  assignee      TEXT,
  source        TEXT,
  notes         TEXT,
  data          TEXT NOT NULL DEFAULT '{}',  -- deliverables, checklists, leads, etc.
  created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_stage ON tasks(stage);

-- ---- team members -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_members (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  title   TEXT,
  email   TEXT,
  data    TEXT NOT NULL DEFAULT '{}'
);

-- ---- lifecycle stages (editable by the user) --------------------------------
CREATE TABLE IF NOT EXISTS stages (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  icon        TEXT,
  description TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  data        TEXT NOT NULL DEFAULT '{}'
);

-- ---- task templates (multi-template support) --------------------------------
CREATE TABLE IF NOT EXISTS task_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  color       TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0,
  data        TEXT NOT NULL DEFAULT '{}',  -- the tasks array & any other fields
  created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

-- ---- holidays (used for business-day calculations) --------------------------
CREATE TABLE IF NOT EXISTS holidays (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  date      TEXT NOT NULL,            -- yyyy-mm-dd
  recurring INTEGER NOT NULL DEFAULT 0,
  data      TEXT NOT NULL DEFAULT '{}'
);

-- ---- master option lists (Ball-in-Court, CSI Divisions, Sources, Milestones)
CREATE TABLE IF NOT EXISTS ball_in_court_options (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS csi_divisions (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  number TEXT,                          -- '03', '06', '23 05 00', etc.
  position INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS source_options (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  icon  TEXT,
  photo TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  data  TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS milestone_types (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  icon  TEXT,
  color TEXT,
  default_days_before_bid INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  data  TEXT NOT NULL DEFAULT '{}'
);

-- ---- audit log (best-effort, append-only) ----------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  action     TEXT NOT NULL,           -- 'create' | 'update' | 'delete' | 'state-put'
  entity     TEXT NOT NULL,           -- 'project' | 'task' | 'team_member' | 'state' | etc.
  entity_id  TEXT,
  payload    TEXT                     -- optional JSON snapshot
);

CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity, entity_id);
