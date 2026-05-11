-- =============================================================================
-- 003_attachments.sql -- File attachments (drawings, specs, sub bid PDFs).
--
-- Files live on disk under backend/data/uploads/ (same EBS volume as the
-- SQLite DB). The `storage_key` column points at the file. Swappable to S3
-- later -- see backend/src/storage.js.
-- =============================================================================

CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  project_id    TEXT,
  task_id       TEXT,
  filename      TEXT NOT NULL,
  content_type  TEXT,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  storage_key   TEXT NOT NULL,
  uploaded_by   TEXT,
  data          TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE INDEX IF NOT EXISTS idx_attachments_project ON attachments(project_id);
CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments(uploaded_by);
