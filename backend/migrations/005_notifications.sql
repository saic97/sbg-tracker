-- 005_notifications.sql -- In-app notifications, scoped per user.
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,            -- 'task_assigned' (more kinds later)
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,                     -- optional client-side route hint
  entity      TEXT,                     -- 'task' | 'project' | etc.
  entity_id   TEXT,
  data        TEXT NOT NULL DEFAULT '{}',
  read_at     INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at);
