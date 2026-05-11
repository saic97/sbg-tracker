/* =============================================================================
 * bidIntake.js -- Subcontractor bid PDF intake.
 *
 * Responsibilities:
 *   - Poll a configured IMAP inbox for PDF attachments.
 *   - Send each PDF to Claude for bid-tab extraction.
 *   - Save the original PDF as a project attachment.
 *   - Append a normalized row to project.subBids.
 *   - Track imported message/attachment keys to prevent duplicates.
 * =============================================================================
 */
const crypto = require('crypto');

const ai = require('./ai');
const m = require('./models');
const storage = require('./storage');
const { getDb, parseJson } = require('./db');

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function makeError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function safeString(value, max = 1000) {
  if (value == null) return '';
  return String(value).trim().slice(0, max);
}

function asArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(v => safeString(v, 2000)).filter(Boolean);
}

function asMoney(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100) / 100;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function firstEmailAddress(parsedFrom) {
  const value = parsedFrom && Array.isArray(parsedFrom.value) ? parsedFrom.value[0] : null;
  return value ? { name: value.name || '', email: value.address || '' } : { name: '', email: '' };
}

function getEmailConfig() {
  const host = process.env.BID_INTAKE_IMAP_HOST || '';
  const user = process.env.BID_INTAKE_IMAP_USER || '';
  const password = process.env.BID_INTAKE_IMAP_PASSWORD || '';
  return {
    enabled: Boolean(host && user && password),
    host,
    port: parseInt(process.env.BID_INTAKE_IMAP_PORT || '993', 10),
    secure: String(process.env.BID_INTAKE_IMAP_TLS || 'true').toLowerCase() !== 'false',
    user,
    password,
    mailbox: process.env.BID_INTAKE_IMAP_MAILBOX || 'INBOX',
    processedMailbox: process.env.BID_INTAKE_PROCESSED_MAILBOX || '',
    onlyUnseen: String(process.env.BID_INTAKE_ONLY_UNSEEN || 'true').toLowerCase() !== 'false',
    defaultProjectId: process.env.BID_INTAKE_DEFAULT_PROJECT_ID || '',
    pollSeconds: Math.max(30, parseInt(process.env.BID_INTAKE_POLL_SECONDS || '300', 10)),
  };
}

function status() {
  const cfg = getEmailConfig();
  return {
    configured: cfg.enabled,
    host: cfg.host || null,
    user: cfg.user || null,
    mailbox: cfg.mailbox,
    processedMailbox: cfg.processedMailbox || null,
    onlyUnseen: cfg.onlyUnseen,
    defaultProjectId: cfg.defaultProjectId || null,
    autoPoll: process.env.BID_INTAKE_AUTO_POLL === '1',
    pollSeconds: cfg.pollSeconds,
  };
}

function importRowFromDb(row) {
  if (!row) return null;
  return {
    ...row,
    data: parseJson(row.data, {}),
  };
}

function findImportByKey(importKey) {
  const row = getDb().prepare('SELECT * FROM bid_intake_imports WHERE import_key=?').get(importKey);
  return importRowFromDb(row);
}

function createImportRecord(input) {
  const id = input.id || m.uid();
  const db = getDb();
  db.prepare(`
    INSERT INTO bid_intake_imports (
      id, import_key, project_id, message_uid, message_id, mailbox,
      from_email, from_name, subject, received_at,
      attachment_name, attachment_size, attachment_sha256,
      attachment_id, sub_bid_id, status, error, data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.import_key,
    input.project_id,
    input.message_uid || null,
    input.message_id || null,
    input.mailbox || null,
    input.from_email || null,
    input.from_name || null,
    input.subject || null,
    input.received_at || null,
    input.attachment_name || null,
    input.attachment_size || 0,
    input.attachment_sha256 || null,
    input.attachment_id || null,
    input.sub_bid_id || null,
    input.status || 'imported',
    input.error || null,
    JSON.stringify(input.data || {})
  );
  return findImportByKey(input.import_key);
}

function updateImportRecord(importKey, patch) {
  const existing = findImportByKey(importKey);
  if (!existing) return null;
  const fields = [];
  const values = [];
  for (const key of [
    'attachment_id', 'sub_bid_id', 'status', 'error',
    'project_id', 'subject', 'received_at', 'from_email', 'from_name'
  ]) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      fields.push(`${key}=?`);
      values.push(patch[key]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'data')) {
    fields.push('data=?');
    values.push(JSON.stringify(patch.data || {}));
  }
  if (!fields.length) return existing;
  fields.push("updated_at=CAST(strftime('%s','now') AS INTEGER)*1000");
  values.push(importKey);
  getDb().prepare(`UPDATE bid_intake_imports SET ${fields.join(', ')} WHERE import_key=?`).run(...values);
  return findImportByKey(importKey);
}

function getProjectOrThrow(projectId) {
  const project = m.projects.get(projectId);
  if (!project) throw makeError(404, 'project not found');
  return project;
}

function listSubBids(projectId) {
  const project = getProjectOrThrow(projectId);
  return Array.isArray(project.subBids) ? project.subBids : [];
}

function saveSubBids(projectId, rows) {
  const updated = m.projects.update(projectId, { subBids: rows || [] });
  return Array.isArray(updated.subBids) ? updated.subBids : [];
}

function normalizeExtract(extract, meta) {
  const sub = extract && extract.subcontractor ? extract.subcontractor : {};
  const trade = extract && extract.trade ? extract.trade : {};
  const total = extract && extract.total ? extract.total : {};
  return {
    subName: safeString(sub.name || meta.fromName || meta.fromEmail || 'Unknown Subcontractor', 200),
    contactName: safeString(sub.contact_name, 200),
    contactEmail: safeString(sub.email || meta.fromEmail, 200),
    contactPhone: safeString(sub.phone, 80),
    trade: safeString(trade.name, 200),
    csiDivision: safeString(trade.csi_division, 80),
    total: asMoney(total.amount),
    currency: safeString(total.currency || 'USD', 12) || 'USD',
    totalLabel: safeString(total.label, 120),
    totalConfidence: safeString(total.confidence || extract.confidence || 'medium', 20),
    alternates: Array.isArray(extract.alternates) ? extract.alternates.map(a => ({
      name: safeString(a && a.name, 200),
      amount: asMoney(a && a.amount),
      notes: safeString(a && a.notes, 500),
    })).filter(a => a.name || a.amount != null || a.notes) : [],
    unitPrices: Array.isArray(extract.unit_prices) ? extract.unit_prices.map(u => ({
      description: safeString(u && u.description, 300),
      unit: safeString(u && u.unit, 40),
      amount: asMoney(u && u.amount),
    })).filter(u => u.description || u.unit || u.amount != null) : [],
    inclusions: asArray(extract.inclusions),
    exclusions: asArray(extract.exclusions),
    qualifications: asArray(extract.qualifications),
    addendaAcknowledged: asArray(extract.addenda_acknowledged),
    schedule: safeString(extract.schedule, 500),
    taxIncluded: typeof extract.tax_included === 'boolean' ? extract.tax_included : null,
    bondIncluded: typeof extract.bond_included === 'boolean' ? extract.bond_included : null,
    scopeSummary: safeString(extract.scope_summary, 2000),
    riskFlags: asArray(extract.risk_flags),
    notes: safeString(extract.notes, 2000),
    confidence: safeString(extract.confidence || total.confidence || 'medium', 20),
  };
}

function makeImportKey(email, filename, pdfBuffer) {
  const digest = sha256(pdfBuffer);
  return sha256([
    email && (email.messageId || email.uid || ''),
    filename || '',
    digest,
  ].join('|'));
}

function buildEmailMeta(email = {}) {
  return {
    uid: safeString(email.uid, 120),
    messageId: safeString(email.messageId, 500),
    mailbox: safeString(email.mailbox, 200),
    subject: safeString(email.subject, 500),
    fromEmail: safeString(email.fromEmail, 200),
    fromName: safeString(email.fromName, 200),
    receivedAt: safeString(email.receivedAt, 120),
  };
}

async function importSubBidPdf(input) {
  const projectId = input.projectId;
  getProjectOrThrow(projectId);
  const pdfBuffer = Buffer.isBuffer(input.pdfBuffer) ? input.pdfBuffer : Buffer.from(input.pdfBuffer || '');
  if (!pdfBuffer.length) throw makeError(400, 'empty PDF');
  if (!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_FAKE !== '1') {
    throw makeError(503, 'AI features disabled: set ANTHROPIC_API_KEY in /etc/sbg-tracker.env on the EC2 host');
  }

  const filename = safeString(input.filename || 'sub-bid.pdf', 240) || 'sub-bid.pdf';
  const email = buildEmailMeta(input.email || {});
  const attachmentSha = sha256(pdfBuffer);
  const importKey = input.importKey || makeImportKey(email, filename, pdfBuffer);
  const existing = findImportByKey(importKey);
  if (existing && !input.force) {
    const projectRows = listSubBids(existing.project_id);
    return {
      status: 'duplicate',
      import: existing,
      subBid: projectRows.find(r => r.id === existing.sub_bid_id) || null,
    };
  }

  if (!existing) {
    createImportRecord({
      import_key: importKey,
      project_id: projectId,
      message_uid: email.uid,
      message_id: email.messageId,
      mailbox: email.mailbox,
      from_email: email.fromEmail,
      from_name: email.fromName,
      subject: email.subject,
      received_at: email.receivedAt,
      attachment_name: filename,
      attachment_size: pdfBuffer.length,
      attachment_sha256: attachmentSha,
      status: 'processing',
      data: { source: input.source || 'email' },
    });
  }

  try {
    const extract = await ai.subBidExtractFromPdf(pdfBuffer, {
      filename,
      subject: email.subject,
      from: email.fromEmail
        ? `${email.fromName ? email.fromName + ' ' : ''}<${email.fromEmail}>`
        : email.fromName,
    });
    if (extract && extract.error) {
      throw makeError(502, extract.error);
    }

    const storageKey = storage.generateKey(filename);
    await storage.put(storageKey, pdfBuffer);
    const attachmentId = crypto.randomBytes(12).toString('hex');
    const attachment = m.attachments.create({
      id: attachmentId,
      project_id: projectId,
      task_id: null,
      filename,
      content_type: input.contentType || 'application/pdf',
      size_bytes: pdfBuffer.length,
      storage_key: storageKey,
      uploaded_by: input.userId || null,
      source: 'bid-intake',
      importKey,
    });

    const normalized = normalizeExtract(extract, email);
    const subBid = {
      id: input.subBidId || m.uid(),
      ...normalized,
      reviewStatus: 'needs-review',
      source: input.source || 'email',
      attachmentId,
      filename,
      importKey,
      importedAt: Date.now(),
      updatedAt: Date.now(),
      email: {
        messageId: email.messageId,
        uid: email.uid,
        mailbox: email.mailbox,
        subject: email.subject,
        fromEmail: email.fromEmail,
        fromName: email.fromName,
        receivedAt: email.receivedAt,
      },
      rawExtract: extract,
    };

    const rows = listSubBids(projectId);
    rows.push(subBid);
    saveSubBids(projectId, rows);
    const importRecord = updateImportRecord(importKey, {
      status: 'imported',
      attachment_id: attachmentId,
      sub_bid_id: subBid.id,
      error: null,
      data: { source: input.source || 'email', confidence: subBid.confidence },
    });
    m.audit('bid-intake-import', 'sub_bid', subBid.id, {
      projectId,
      user: input.userId || null,
      source: input.source || 'email',
      filename,
      importKey,
    });
    return { status: 'imported', subBid, attachment, import: importRecord };
  } catch (err) {
    updateImportRecord(importKey, {
      status: 'error',
      error: err.message,
      data: { source: input.source || 'email' },
    });
    throw err;
  }
}

function updateSubBid(projectId, subBidId, patch) {
  getProjectOrThrow(projectId);
  const rows = listSubBids(projectId);
  const idx = rows.findIndex(r => r.id === subBidId);
  if (idx < 0) throw makeError(404, 'sub bid not found');
  const allowed = [
    'subName', 'contactName', 'contactEmail', 'contactPhone',
    'trade', 'csiDivision', 'total', 'currency', 'totalLabel',
    'reviewStatus', 'inclusions', 'exclusions', 'qualifications',
    'addendaAcknowledged', 'scopeSummary', 'notes', 'riskFlags',
    'schedule', 'taxIncluded', 'bondIncluded',
  ];
  const next = { ...rows[idx] };
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch || {}, key)) continue;
    if (key === 'total') next[key] = asMoney(patch[key]);
    else if (['inclusions', 'exclusions', 'qualifications', 'addendaAcknowledged', 'riskFlags'].includes(key)) {
      next[key] = asArray(patch[key]);
    } else if (['taxIncluded', 'bondIncluded'].includes(key)) {
      next[key] = typeof patch[key] === 'boolean' ? patch[key] : null;
    } else {
      next[key] = safeString(patch[key], 2000);
    }
  }
  next.updatedAt = Date.now();
  rows[idx] = next;
  saveSubBids(projectId, rows);
  m.audit('update', 'sub_bid', subBidId, { projectId });
  return next;
}

function removeSubBid(projectId, subBidId) {
  getProjectOrThrow(projectId);
  const rows = listSubBids(projectId);
  const next = rows.filter(r => r.id !== subBidId);
  if (next.length === rows.length) throw makeError(404, 'sub bid not found');
  saveSubBids(projectId, next);
  m.audit('delete', 'sub_bid', subBidId, { projectId });
  return true;
}

function extractProjectIdFromText(text) {
  const s = String(text || '');
  const patterns = [
    /\[(?:sbg|project|project-id)\s*:\s*([A-Za-z0-9_-]+)\]/i,
    /\bSBG-PROJECT-ID\s*[:=]\s*([A-Za-z0-9_-]+)/i,
    /\bPROJECT-ID\s*[:=]\s*([A-Za-z0-9_-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = s.match(pattern);
    if (match && match[1]) return match[1];
  }
  return '';
}

async function pollInbox(options = {}) {
  const cfg = getEmailConfig();
  if (!cfg.enabled) {
    throw makeError(503, 'Bid intake inbox is not configured. Set BID_INTAKE_IMAP_HOST, BID_INTAKE_IMAP_USER, and BID_INTAKE_IMAP_PASSWORD.');
  }
  if (!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_FAKE !== '1') {
    throw makeError(503, 'AI features disabled: set ANTHROPIC_API_KEY in /etc/sbg-tracker.env on the EC2 host');
  }

  let ImapFlow;
  let simpleParser;
  try {
    ({ ImapFlow } = require('imapflow'));
    ({ simpleParser } = require('mailparser'));
  } catch (err) {
    throw makeError(500, 'Email intake dependencies are missing. Run npm install so imapflow and mailparser are available.');
  }

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
  });

  const limit = Math.max(1, Math.min(parseInt(options.limit || '25', 10), 100));
  const results = [];
  let scanned = 0;

  await client.connect();
  let lock;
  try {
    lock = await client.getMailboxLock(cfg.mailbox);
    const searchCriteria = cfg.onlyUnseen ? { seen: false } : { all: true };
    const uids = await client.search(searchCriteria, { uid: true });
    const selected = uids.slice(-limit);
    if (!selected.length) return { scanned: 0, imported: 0, duplicates: 0, errors: 0, skipped: 0, results };

    for await (const msg of client.fetch(selected, { uid: true, envelope: true, source: true, internalDate: true })) {
      scanned += 1;
      let messageHadError = false;
      const parsed = await simpleParser(msg.source);
      const from = firstEmailAddress(parsed.from);
      const subject = parsed.subject || (msg.envelope && msg.envelope.subject) || '';
      const projectId = options.projectId || extractProjectIdFromText(`${subject}\n${parsed.text || ''}`) || cfg.defaultProjectId;
      if (!projectId || !m.projects.get(projectId)) {
        results.push({
          status: 'skipped',
          reason: 'No matching project. Include [SBG:<projectId>] in the subject or set BID_INTAKE_DEFAULT_PROJECT_ID.',
          uid: String(msg.uid),
          subject,
        });
        continue;
      }

      const attachments = (parsed.attachments || []).filter(att => {
        const filename = att.filename || '';
        const contentType = att.contentType || '';
        return /\.pdf$/i.test(filename) || contentType.toLowerCase() === 'application/pdf';
      });

      if (!attachments.length) {
        results.push({ status: 'skipped', reason: 'No PDF attachments', uid: String(msg.uid), subject, projectId });
        continue;
      }

      for (const att of attachments) {
        try {
          const imported = await importSubBidPdf({
            projectId,
            pdfBuffer: att.content,
            filename: att.filename || 'sub-bid.pdf',
            contentType: att.contentType || 'application/pdf',
            source: 'email',
            userId: options.userId || null,
            email: {
              uid: String(msg.uid),
              messageId: parsed.messageId || '',
              mailbox: cfg.mailbox,
              subject,
              fromEmail: from.email,
              fromName: from.name,
              receivedAt: (parsed.date || msg.internalDate || new Date()).toISOString(),
            },
          });
          results.push({
            status: imported.status,
            projectId,
            uid: String(msg.uid),
            filename: att.filename || 'sub-bid.pdf',
            subBid: imported.subBid,
          });
        } catch (err) {
          messageHadError = true;
          results.push({
            status: 'error',
            projectId,
            uid: String(msg.uid),
            filename: att.filename || 'sub-bid.pdf',
            error: err.message,
          });
        }
      }

      if (!messageHadError && options.markSeen !== false) {
        await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
      }
      if (!messageHadError && cfg.processedMailbox) {
        try {
          await client.messageMove(msg.uid, cfg.processedMailbox, { uid: true });
        } catch (err) {
          results.push({ status: 'warning', uid: String(msg.uid), warning: `Could not move message: ${err.message}` });
        }
      }
    }
  } finally {
    if (lock) lock.release();
    await client.logout().catch(() => {});
  }

  return summarizePoll(scanned, results);
}

function summarizePoll(scanned, results) {
  const imported = results.filter(r => r.status === 'imported').length;
  const duplicates = results.filter(r => r.status === 'duplicate').length;
  const errors = results.filter(r => r.status === 'error').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  return { scanned, imported, duplicates, errors, skipped, results };
}

let poller = null;
function startAutoPoller() {
  const cfg = getEmailConfig();
  if (process.env.BID_INTAKE_AUTO_POLL !== '1' || !cfg.enabled) return null;
  if (poller) return poller;
  const run = async () => {
    try {
      const summary = await pollInbox({ limit: parseInt(process.env.BID_INTAKE_AUTO_LIMIT || '25', 10) });
      if (summary.imported || summary.errors) {
        console.log(`[bid-intake] poll complete: imported=${summary.imported} duplicate=${summary.duplicates} errors=${summary.errors}`);
      }
      if (summary.imported) {
        try {
          const rt = require('./realtime');
          rt.broadcastStateChange({ state: m.loadStateBlob(), byUserId: null, byUserName: 'Bid Intake', clientId: null });
        } catch (err) {
          console.warn('[bid-intake] realtime broadcast skipped:', err.message);
        }
      }
    } catch (err) {
      console.warn('[bid-intake] poll failed:', err.message);
    }
  };
  poller = setInterval(run, cfg.pollSeconds * 1000);
  setTimeout(run, 5000);
  return poller;
}

module.exports = {
  status,
  importSubBidPdf,
  listSubBids,
  updateSubBid,
  removeSubBid,
  pollInbox,
  extractProjectIdFromText,
  startAutoPoller,
};
