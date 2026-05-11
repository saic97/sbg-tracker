/* =============================================================================
 * attachments.js -- Drag-and-drop file attachments for projects.
 *
 * Injects a "📎 Files" button next to the AI Scope button. Clicking it opens
 * a modal showing all attachments for the currently-active project, with a
 * drag-drop zone for uploads.
 *
 * Uses the existing bearer token (window.auth.token) for auth.
 * =============================================================================
 */
(function () {
  const apiBaseMeta = document.querySelector('meta[name="api-base"]');
  const BASE = (apiBaseMeta && apiBaseMeta.content) || '';
  const apiEnabledMeta = document.querySelector('meta[name="api-enabled"]');
  const ENABLED = !apiEnabledMeta || apiEnabledMeta.content !== 'false';

  function injectStyles() {
    const css = `
      #at-trigger {
        position: fixed; top: 14px; right: 220px; z-index: 90;
        background: #0a2540; color: #fff; border: 0; padding: 8px 14px;
        border-radius: 4px; font-weight: 700; font-size: 12px; cursor: pointer;
        font-family: 'Inter', system-ui, sans-serif; letter-spacing: 0.04em;
        box-shadow: 0 2px 6px rgba(10,37,64,0.25);
      }
      #at-trigger:hover { background: #0f2d4d; }
      #at-modal {
        position: fixed; inset: 0; background: rgba(10,37,64,0.72);
        z-index: 9000; display: none; align-items: center; justify-content: center;
        font-family: 'Inter', system-ui, sans-serif;
      }
      #at-modal.active { display: flex; }
      .at-card {
        background: #fff; border-radius: 8px; width: 720px; max-width: 92vw;
        max-height: 88vh; overflow: hidden; display: flex; flex-direction: column;
        box-shadow: 0 20px 60px rgba(0,0,0,0.4);
      }
      .at-card header {
        padding: 18px 24px; border-bottom: 1px solid #dbdfe5;
        display: flex; align-items: center; justify-content: space-between;
      }
      .at-card header h2 { margin: 0; font-size: 18px; color: #0a2540; }
      .at-card .at-close { border: 0; background: transparent; font-size: 22px; cursor: pointer; color: #6b7687; }
      .at-body { padding: 22px 24px; overflow: auto; flex: 1; }
      .at-context { font-size: 13px; color: #6b7687; margin-bottom: 12px; }
      .at-context b { color: #0a2540; }
      .at-drop {
        border: 2px dashed #dbdfe5; border-radius: 6px; padding: 26px;
        text-align: center; color: #6b7687; cursor: pointer; transition: 0.15s;
      }
      .at-drop:hover, .at-drop.dragover { border-color: #c8322b; background: #fef5f4; color: #0a2540; }
      .at-drop input { display: none; }
      .at-status { margin-top: 10px; font-size: 13px; color: #6b7687; min-height: 18px; }
      .at-status.error { color: #c8322b; }
      .at-list { list-style: none; padding: 0; margin: 18px 0 0; }
      .at-list li {
        display: grid;
        grid-template-columns: 34px 1fr 90px 130px 30px;
        gap: 10px; padding: 10px 4px; border-bottom: 1px solid #edeff3;
        align-items: center; font-size: 13px;
      }
      .at-list li:last-child { border-bottom: 0; }
      .at-icon { font-size: 22px; text-align: center; }
      .at-name { font-weight: 600; color: #0a2540; word-break: break-all; }
      .at-name a { color: inherit; text-decoration: none; }
      .at-name a:hover { color: #c8322b; text-decoration: underline; }
      .at-meta { color: #6b7687; font-size: 11px; }
      .at-size { color: #6b7687; font-size: 12px; text-align: right; }
      .at-date { color: #6b7687; font-size: 12px; }
      .at-del { border: 0; background: transparent; color: #6b7687; cursor: pointer; font-size: 16px; }
      .at-del:hover { color: #c8322b; }
      .at-empty { padding: 18px; text-align: center; color: #9ba4b0; font-size: 13px; }
    `;
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function injectMarkup() {
    const trigger = document.createElement('button');
    trigger.id = 'at-trigger';
    trigger.innerHTML = '📎 Files';
    trigger.title = 'Project file attachments';
    trigger.addEventListener('click', open);
    document.body.appendChild(trigger);

    const modal = document.createElement('div');
    modal.id = 'at-modal';
    modal.innerHTML = `
      <div class="at-card">
        <header>
          <h2>📎 Project files</h2>
          <button class="at-close" type="button" aria-label="Close">&times;</button>
        </header>
        <div class="at-body">
          <div class="at-context" id="at-context">Select a project first.</div>
          <label class="at-drop" id="at-drop">
            <strong>Drop files here</strong>
            <div style="margin-top:4px; font-size:12px;">specs, drawings, sub bid PDFs — up to 50&nbsp;MB each</div>
            <input type="file" multiple>
          </label>
          <div class="at-status" id="at-status"></div>
          <ul class="at-list" id="at-list"></ul>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    modal.querySelector('.at-close').addEventListener('click', close);

    const drop = modal.querySelector('#at-drop');
    const fileInput = drop.querySelector('input');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('dragover');
      handleFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', () => handleFiles(fileInput.files));
  }

  function activeProject() {
    if (typeof window.state !== 'object' || !window.state) return null;
    const id = window.state.activeProjectId;
    if (!id) return null;
    return (window.state.projects || []).find(p => p.id === id) || null;
  }

  function open() {
    document.getElementById('at-modal').classList.add('active');
    const proj = activeProject();
    const ctx = document.getElementById('at-context');
    if (proj) {
      ctx.innerHTML = `Attachments for <b>${escapeHtml(proj.name || 'project')}</b>`;
      refreshList(proj.id);
    } else {
      ctx.innerHTML = 'No active project. Open a project from the sidebar first.';
      document.getElementById('at-list').innerHTML = '';
    }
  }
  function close() { document.getElementById('at-modal').classList.remove('active'); }

  async function refreshList(projectId) {
    if (!ENABLED) return;
    const token = window.auth && window.auth.token;
    if (!token) return;
    const listEl = document.getElementById('at-list');
    try {
      const r = await fetch(BASE + `/api/projects/${encodeURIComponent(projectId)}/attachments`, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!r.ok) throw new Error('list failed: ' + r.status);
      const items = await r.json();
      if (!items.length) {
        listEl.innerHTML = '<li class="at-empty">No files uploaded yet for this project.</li>';
        return;
      }
      listEl.innerHTML = items.map(a => {
        const dateStr = new Date(a.createdAt || Date.now()).toLocaleString();
        const downloadUrl = BASE + `/api/attachments/${encodeURIComponent(a.id)}/download`;
        return `
          <li data-id="${escapeAttr(a.id)}">
            <div class="at-icon">${iconForFile(a.filename, a.content_type)}</div>
            <div>
              <div class="at-name"><a href="#" data-download="${escapeAttr(a.id)}" data-filename="${escapeAttr(a.filename)}">${escapeHtml(a.filename || '(unnamed)')}</a></div>
              <div class="at-meta">${escapeHtml(a.content_type || 'unknown type')}</div>
            </div>
            <div class="at-size">${humanSize(a.size_bytes)}</div>
            <div class="at-date">${escapeHtml(dateStr)}</div>
            <button class="at-del" type="button" title="Delete" data-delete="${escapeAttr(a.id)}">&times;</button>
          </li>
        `;
      }).join('');
      // Wire up the download links to use the auth header (bearer token).
      listEl.querySelectorAll('[data-download]').forEach(el => {
        el.addEventListener('click', async (e) => {
          e.preventDefault();
          const id = el.getAttribute('data-download');
          const fn = el.getAttribute('data-filename') || 'download';
          const r = await fetch(BASE + `/api/attachments/${encodeURIComponent(id)}/download`, {
            headers: { 'Authorization': 'Bearer ' + token }
          });
          if (!r.ok) { document.getElementById('at-status').textContent = 'Download failed'; return; }
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = fn;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1500);
        });
      });
      listEl.querySelectorAll('[data-delete]').forEach(el => {
        el.addEventListener('click', async () => {
          const id = el.getAttribute('data-delete');
          if (!confirm('Delete this file? This cannot be undone.')) return;
          const r = await fetch(BASE + `/api/attachments/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + token }
          });
          if (r.status === 204) refreshList(projectId);
        });
      });
    } catch (err) {
      listEl.innerHTML = `<li class="at-empty">Could not load attachments: ${escapeHtml(err.message)}</li>`;
    }
  }

  async function handleFiles(files) {
    const status = document.getElementById('at-status');
    status.classList.remove('error');
    const proj = activeProject();
    if (!proj) { status.classList.add('error'); status.textContent = 'No active project.'; return; }
    if (!ENABLED) { status.classList.add('error'); status.textContent = 'Backend disabled.'; return; }
    const token = window.auth && window.auth.token;
    if (!token) { status.classList.add('error'); status.textContent = 'Not signed in.'; return; }

    const list = Array.from(files || []);
    if (!list.length) return;
    let ok = 0, fail = 0;
    for (const f of list) {
      status.textContent = `Uploading ${f.name} (${humanSize(f.size)})…`;
      const fd = new FormData();
      fd.append('projectId', proj.id);
      fd.append('file', f);
      try {
        const r = await fetch(BASE + '/api/attachments', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token },
          body: fd
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.error || ('status ' + r.status));
        }
        ok++;
      } catch (e) {
        fail++;
        console.warn('upload failed for', f.name, e);
      }
    }
    status.textContent = `${ok} uploaded${fail ? `, ${fail} failed` : ''}.`;
    refreshList(proj.id);
  }

  function humanSize(n) {
    if (!n) return '0 B';
    const k = 1024; const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(sizes.length - 1, Math.floor(Math.log(n) / Math.log(k)));
    return (n / Math.pow(k, i)).toFixed(i ? 1 : 0) + ' ' + sizes[i];
  }
  function iconForFile(name, mime) {
    const n = (name || '').toLowerCase();
    if (/\.(pdf)$/.test(n) || /pdf/.test(mime || '')) return '📄';
    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(n) || /image/.test(mime || '')) return '🖼';
    if (/\.(docx?|odt)$/.test(n) || /word/.test(mime || '')) return '📝';
    if (/\.(xlsx?|csv)$/.test(n) || /spreadsheet|excel|csv/.test(mime || '')) return '📊';
    if (/\.(pptx?)$/.test(n) || /presentation/.test(mime || '')) return '🎞';
    if (/\.(dwg|dxf)$/.test(n)) return '📐';
    if (/\.(zip|7z|rar|tar|gz)$/.test(n)) return '🗜';
    return '📎';
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  document.addEventListener('DOMContentLoaded', () => {
    if (!ENABLED) return;
    injectStyles();
    injectMarkup();
  });
})();
