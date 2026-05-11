/* =============================================================================
 * sub-bids.js -- Project-level subcontractor bid intake panel.
 *
 * Self-contained, like scope-extract.js: injects a project panel and talks to
 * /api/projects/:id/bid-intake/* without disturbing the main app render path.
 * =============================================================================
 */
(function () {
  const apiBaseMeta = document.querySelector('meta[name="api-base"]');
  const BASE = (apiBaseMeta && apiBaseMeta.content) || '';
  const apiEnabledMeta = document.querySelector('meta[name="api-enabled"]');
  const ENABLED = !apiEnabledMeta || apiEnabledMeta.content !== 'false';

  const loadedProjects = new Set();
  const loadingProjects = new Set();
  let inboxStatus = null;
  let renderHookInstalled = false;

  function injectStyles() {
    if (document.getElementById('sbi-styles')) return;
    const css = `
      .sbi-panel {
        margin: 14px 0 18px;
        background: #fff;
        border: 1px solid #dfe4ea;
        border-left: 4px solid #0a2540;
        border-radius: 6px;
        box-shadow: 0 1px 3px rgba(10,37,64,0.06);
        overflow: hidden;
      }
      .sbi-header {
        padding: 12px 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        background: #f8f9fb;
        border-bottom: 1px solid #e7ebf0;
      }
      .sbi-title-wrap { min-width: 0; }
      .sbi-title {
        margin: 0;
        color: #0a2540;
        font-family: 'Barlow Condensed', 'Inter', sans-serif;
        font-size: 18px;
        font-weight: 800;
        letter-spacing: 0;
      }
      .sbi-meta {
        margin-top: 2px;
        color: #667085;
        font-size: 12px;
      }
      .sbi-actions {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .sbi-btn {
        border: 1px solid #cfd6df;
        background: #fff;
        color: #0a2540;
        border-radius: 4px;
        padding: 7px 10px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }
      .sbi-btn:hover { border-color: #0a2540; }
      .sbi-btn.primary {
        background: #c8322b;
        border-color: #c8322b;
        color: #fff;
      }
      .sbi-btn.primary:hover { background: #a82621; border-color: #a82621; }
      .sbi-btn:disabled { opacity: 0.55; cursor: wait; }
      .sbi-status {
        padding: 8px 14px;
        min-height: 16px;
        color: #667085;
        font-size: 12px;
        border-bottom: 1px solid #eef1f5;
      }
      .sbi-status.error { color: #c8322b; background: #fff7f6; }
      .sbi-status.ok { color: #2e7d52; background: #f4fbf6; }
      .sbi-empty {
        padding: 18px 14px;
        color: #667085;
        font-size: 13px;
      }
      .sbi-table-wrap { overflow-x: auto; }
      .sbi-table {
        width: 100%;
        border-collapse: collapse;
        min-width: 980px;
      }
      .sbi-table th {
        text-align: left;
        padding: 9px 10px;
        color: #5d6674;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        border-bottom: 1px solid #e8ecf1;
        background: #fbfcfd;
      }
      .sbi-table td {
        padding: 10px;
        border-bottom: 1px solid #edf0f4;
        vertical-align: top;
        font-size: 13px;
        color: #1d2939;
      }
      .sbi-sub-name { font-weight: 800; color: #0a2540; }
      .sbi-sub-contact { margin-top: 3px; color: #667085; font-size: 12px; }
      .sbi-money {
        font-family: 'JetBrains Mono', Consolas, monospace;
        font-weight: 800;
        color: #0a2540;
        white-space: nowrap;
      }
      .sbi-pill {
        display: inline-block;
        padding: 2px 7px;
        border-radius: 999px;
        background: #eef3f8;
        color: #475467;
        font-size: 11px;
        font-weight: 700;
      }
      .sbi-pill.reviewed { background: #e7f6ec; color: #2e7d52; }
      .sbi-pill.accepted { background: #e9f1ff; color: #2563a8; }
      .sbi-pill.rejected { background: #fde4e2; color: #a82621; }
      .sbi-list-preview {
        color: #475467;
        line-height: 1.35;
        max-width: 320px;
      }
      .sbi-row-actions { display: flex; gap: 6px; align-items: center; }
      .sbi-select {
        border: 1px solid #cfd6df;
        border-radius: 4px;
        padding: 5px 6px;
        background: #fff;
        font-size: 12px;
      }
      .sbi-link {
        color: #2563a8;
        font-weight: 700;
        text-decoration: none;
      }
      .sbi-link:hover { text-decoration: underline; }
      .sbi-file-input { display: none; }
      @media (max-width: 720px) {
        .sbi-header { align-items: stretch; flex-direction: column; }
        .sbi-actions { justify-content: flex-start; }
        .sbi-btn { flex: 1 1 auto; }
      }
    `;
    const s = document.createElement('style');
    s.id = 'sbi-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function installRenderHook() {
    if (renderHookInstalled || typeof render !== 'function') return;
    const original = render;
    render = function () {
      const result = original.apply(this, arguments);
      setTimeout(renderSubBidPanel, 0);
      return result;
    };
    renderHookInstalled = true;
  }

  function getToken() {
    return (window.auth && window.auth.token) || null;
  }

  async function request(path, opts = {}) {
    if (!ENABLED) throw new Error('API disabled');
    const headers = { ...(opts.headers || {}) };
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch(BASE + path, { ...opts, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try { message = JSON.parse(text).error || text; } catch {}
      throw new Error(message || `Request failed: ${res.status}`);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  function activeProject() {
    if (typeof state === 'undefined' || !state || !Array.isArray(state.projects)) return null;
    return state.projects.find(p => p.id === state.activeProjectId) || null;
  }

  function ensurePanel() {
    let panel = document.getElementById('subBidIntakePanel');
    if (panel) return panel;
    const anchor = document.getElementById('pvWorkspaceControls');
    const projectView = document.getElementById('projectView');
    if (!anchor || !projectView) return null;
    panel = document.createElement('section');
    panel.id = 'subBidIntakePanel';
    panel.className = 'sbi-panel';
    anchor.parentNode.insertBefore(panel, anchor);
    return panel;
  }

  function renderSubBidPanel() {
    injectStyles();
    const panel = ensurePanel();
    if (!panel) return;
    const project = activeProject();
    if (!project || (typeof state !== 'undefined' && state.homeView)) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = '';
    const rows = Array.isArray(project.subBids) ? project.subBids.slice() : [];
    rows.sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0));
    const total = rows.reduce((sum, r) => sum + (typeof r.total === 'number' ? r.total : 0), 0);
    const needsReview = rows.filter(r => (r.reviewStatus || 'needs-review') === 'needs-review').length;
    const configuredText = inboxStatus
      ? (inboxStatus.configured ? `Inbox connected: ${escapeHtml(inboxAddress())}` : 'Inbox not configured')
      : 'Checking inbox connection...';

    panel.innerHTML = `
      <div class="sbi-header">
        <div class="sbi-title-wrap">
          <h3 class="sbi-title">Sub Bid Inbox</h3>
          <div class="sbi-meta">${rows.length} row${rows.length === 1 ? '' : 's'} - ${needsReview} need review - ${formatMoney(total)} carried total - ${configuredText}</div>
        </div>
        <div class="sbi-actions">
          <button class="sbi-btn" type="button" onclick="copySubBidForwardingSubject()">Copy Forward Subject</button>
          <button class="sbi-btn" type="button" onclick="document.getElementById('sbiUploadInput').click()">Upload PDF</button>
          <button class="sbi-btn primary" id="sbiPollBtn" type="button" onclick="pollSubBidInbox()">Check Inbox</button>
          <input class="sbi-file-input" id="sbiUploadInput" type="file" accept="application/pdf" onchange="uploadSubBidPdf(this.files && this.files[0]); this.value='';">
        </div>
      </div>
      <div class="sbi-status" id="sbiStatus"></div>
      ${rows.length ? renderRows(rows, project.id) : '<div class="sbi-empty">No subcontractor bids imported for this project yet.</div>'}
    `;

    const statusEl = document.getElementById('sbiStatus');
    if (statusEl && statusEl.dataset.keep !== '1') {
      statusEl.textContent = `Forward bid PDFs to ${inboxAddress()}, then check the inbox from this project.`;
    }
    if (!loadedProjects.has(project.id) && !loadingProjects.has(project.id)) {
      loadSubBids(project.id);
    }
    if (!inboxStatus) loadInboxStatus();
  }

  function renderRows(rows, projectId) {
    const body = rows.map(r => {
      const status = r.reviewStatus || 'needs-review';
      const attachment = r.attachmentId
        ? `<button class="sbi-btn" type="button" onclick="downloadSubBidAttachment('${escapeAttr(r.attachmentId)}','${escapeJsArg(r.filename || 'sub-bid.pdf')}')">PDF</button>`
        : '';
      return `
        <tr>
          <td>
            <div class="sbi-sub-name">${escapeHtml(r.subName || 'Unknown Sub')}</div>
            <div class="sbi-sub-contact">${escapeHtml([r.contactName, r.contactEmail].filter(Boolean).join(' - '))}</div>
          </td>
          <td>
            <div>${escapeHtml(r.trade || '')}</div>
            ${r.csiDivision ? `<span class="sbi-pill">${escapeHtml(r.csiDivision)}</span>` : ''}
          </td>
          <td><span class="sbi-money">${formatMoney(r.total, r.currency)}</span><div class="sbi-sub-contact">${escapeHtml(r.totalLabel || r.totalConfidence || '')}</div></td>
          <td><div class="sbi-list-preview">${renderListPreview(r.exclusions)}</div></td>
          <td><div class="sbi-list-preview">${renderListPreview(r.qualifications)}</div></td>
          <td>
            <span class="sbi-pill ${escapeAttr(status)}">${escapeHtml(labelStatus(status))}</span>
            <div class="sbi-sub-contact">${formatDateTime(r.importedAt)}</div>
          </td>
          <td>
            <div class="sbi-row-actions">
              <select class="sbi-select" onchange="updateSubBidStatus('${escapeAttr(projectId)}','${escapeAttr(r.id)}',this.value)">
                ${['needs-review','reviewed','accepted','rejected'].map(s => `<option value="${s}" ${s === status ? 'selected' : ''}>${labelStatus(s)}</option>`).join('')}
              </select>
              ${attachment}
              <button class="sbi-btn" type="button" onclick="deleteSubBidRow('${escapeAttr(projectId)}','${escapeAttr(r.id)}')">Remove</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
    return `
      <div class="sbi-table-wrap">
        <table class="sbi-table">
          <thead>
            <tr>
              <th>Sub</th>
              <th>Trade</th>
              <th>Total</th>
              <th>Exclusions</th>
              <th>Qualifications</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    `;
  }

  async function loadInboxStatus() {
    try {
      inboxStatus = await request('/api/bid-intake/status');
    } catch (err) {
      inboxStatus = { configured: false, error: err.message };
    }
    renderSubBidPanel();
  }

  async function loadSubBids(projectId, force = false) {
    if (!force && (loadedProjects.has(projectId) || loadingProjects.has(projectId))) return;
    loadingProjects.add(projectId);
    try {
      const rows = await request(`/api/projects/${encodeURIComponent(projectId)}/sub-bids`);
      const project = (state.projects || []).find(p => p.id === projectId);
      if (project) project.subBids = Array.isArray(rows) ? rows : [];
      loadedProjects.add(projectId);
      persistLocalOnly();
    } catch (err) {
      setStatus('Could not load sub bids: ' + err.message, 'error');
    } finally {
      loadingProjects.delete(projectId);
      renderSubBidPanel();
    }
  }

  async function pollInbox() {
    const project = activeProject();
    if (!project) return;
    const btn = document.getElementById('sbiPollBtn');
    if (btn) btn.disabled = true;
    setStatus(`Checking ${inboxAddress()}...`, '');
    try {
      const summary = await request(`/api/projects/${encodeURIComponent(project.id)}/bid-intake/email-poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 50, clientId: (window.realtime && window.realtime.clientId) || null }),
      });
      await loadSubBids(project.id, true);
      setStatus(`Imported ${summary.imported || 0}; duplicates ${summary.duplicates || 0}; skipped ${summary.skipped || 0}; errors ${summary.errors || 0}.`, summary.errors ? 'error' : 'ok');
    } catch (err) {
      setStatus('Inbox check failed: ' + err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function uploadPdf(file) {
    const project = activeProject();
    if (!project || !file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      setStatus('Choose a PDF file.', 'error');
      return;
    }
    setStatus(`Uploading ${file.name}...`, '');
    const fd = new FormData();
    fd.append('pdf', file);
    fd.append('clientId', (window.realtime && window.realtime.clientId) || '');
    try {
      const res = await request(`/api/projects/${encodeURIComponent(project.id)}/bid-intake/upload`, {
        method: 'POST',
        body: fd,
      });
      await loadSubBids(project.id, true);
      setStatus(res.status === 'duplicate' ? 'That PDF is already imported.' : `Imported ${res.subBid && res.subBid.subName ? res.subBid.subName : file.name}.`, 'ok');
    } catch (err) {
      setStatus('Upload failed: ' + err.message, 'error');
    }
  }

  async function updateStatus(projectId, bidId, reviewStatus) {
    try {
      const updated = await request(`/api/projects/${encodeURIComponent(projectId)}/sub-bids/${encodeURIComponent(bidId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewStatus, clientId: (window.realtime && window.realtime.clientId) || null }),
      });
      const project = (state.projects || []).find(p => p.id === projectId);
      if (project && Array.isArray(project.subBids)) {
        const idx = project.subBids.findIndex(r => r.id === bidId);
        if (idx >= 0) project.subBids[idx] = updated;
      }
      persistLocalOnly();
      renderSubBidPanel();
      setStatus('Bid row updated.', 'ok');
    } catch (err) {
      setStatus('Update failed: ' + err.message, 'error');
    }
  }

  async function deleteRow(projectId, bidId) {
    if (!confirm('Remove this imported sub bid row? The saved PDF attachment will remain in project files.')) return;
    try {
      await request(`/api/projects/${encodeURIComponent(projectId)}/sub-bids/${encodeURIComponent(bidId)}`, { method: 'DELETE' });
      const project = (state.projects || []).find(p => p.id === projectId);
      if (project && Array.isArray(project.subBids)) {
        project.subBids = project.subBids.filter(r => r.id !== bidId);
      }
      persistLocalOnly();
      renderSubBidPanel();
      setStatus('Bid row removed.', 'ok');
    } catch (err) {
      setStatus('Remove failed: ' + err.message, 'error');
    }
  }

  async function downloadAttachment(attachmentId, filename) {
    try {
      const token = getToken();
      const res = await fetch(BASE + `/api/attachments/${encodeURIComponent(attachmentId)}/download`, {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
      });
      if (!res.ok) throw new Error('download failed: ' + res.status);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'sub-bid.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (err) {
      setStatus('Download failed: ' + err.message, 'error');
    }
  }

  function copyForwardingSubject() {
    const project = activeProject();
    if (!project) return;
    const subject = `[SBG:${project.id}] ${project.name || 'Project'} - sub bid`;
    const text = `To: ${inboxAddress()}\nSubject: ${subject}`;
    navigator.clipboard.writeText(text).then(() => {
      setStatus('Forwarding subject copied.', 'ok');
    }).catch(() => {
      window.prompt('Copy this forwarding subject:', subject);
    });
  }

  function setStatus(message, tone) {
    const el = document.getElementById('sbiStatus');
    if (!el) return;
    el.dataset.keep = '1';
    el.className = 'sbi-status' + (tone ? ' ' + tone : '');
    el.textContent = message || '';
  }

  function inboxAddress() {
    return (inboxStatus && inboxStatus.user) || 'bids@sourcebuild.net';
  }

  function persistLocalOnly() {
    try {
      if (typeof STORAGE_KEY !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      }
    } catch {}
  }

  function renderListPreview(items) {
    const arr = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!arr.length) return '<span style="color:#98a2b3;">None found</span>';
    const shown = arr.slice(0, 2).map(escapeHtml).join('<br>');
    const more = arr.length > 2 ? `<br><span class="sbi-sub-contact">+${arr.length - 2} more</span>` : '';
    return shown + more;
  }

  function formatMoney(value, currency) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'TBD';
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency || 'USD',
        maximumFractionDigits: 0,
      }).format(value);
    } catch {
      return '$' + Math.round(value).toLocaleString('en-US');
    }
  }

  function formatDateTime(ms) {
    if (!ms) return '';
    try {
      return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch { return ''; }
  }

  function labelStatus(value) {
    return ({
      'needs-review': 'Needs Review',
      reviewed: 'Reviewed',
      accepted: 'Accepted',
      rejected: 'Rejected',
    })[value] || 'Needs Review';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/[^a-zA-Z0-9_-]/g, '');
  }

  function escapeJsArg(s) {
    return escapeHtml(String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]+/g, ' '));
  }

  document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
    installRenderHook();
    renderSubBidPanel();
  });

  window.pollSubBidInbox = pollInbox;
  window.uploadSubBidPdf = uploadPdf;
  window.updateSubBidStatus = updateStatus;
  window.deleteSubBidRow = deleteRow;
  window.downloadSubBidAttachment = downloadAttachment;
  window.copySubBidForwardingSubject = copyForwardingSubject;
})();
