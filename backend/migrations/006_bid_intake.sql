-- =============================================================================
-- 006_bid_intake.sql -- Email/PDF subcontractor bid intake import ledger.
--
-- The normalized bid rows live on projects.data as project.subBids so they
-- travel with the existing state blob. This table is an operational ledger for
-- dedupe, audit, and troubleshooting individual mailbox/PDF imports.
-- =============================================================================

CREATE TABLE IF NOT EXISTS bid_intake_imports (
  id                TEXT PRIMARY KEY,
  import_key        TEXT NOT NULL UNIQUE,
  project_id        TEXT NOT NULL,
  message_uid       TEXT,
  message_id        TEXT,
  mailbox           TEXT,
  from_email        TEXT,
  from_name         TEXT,
  subject           TEXT,
  received_at       TEXT,
  attachment_name   TEXT,
  attachment_size   INTEGER NOT NULL DEFAULT 0,
  attachment_sha256 TEXT,
  attachment_id     TEXT,
  sub_bid_id        TEXT,
  status            TEXT NOT NULL DEFAULT 'imported',
  error             TEXT,
  data              TEXT NOT NULL DEFAULT '{}',
  created_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at        INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE INDEX IF NOT EXISTS idx_bid_intake_project ON bid_intake_imports(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bid_intake_message ON bid_intake_imports(message_id);
CREATE INDEX IF NOT EXISTS idx_bid_intake_attachment_hash ON bid_intake_imports(attachment_sha256);
