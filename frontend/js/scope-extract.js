/* =============================================================================
 * scope-extract.js -- Upload a spec PDF, get an AI-suggested project structure.
 *
 * Self-contained: injects its own button (top-right of the header) and modal.
 * Doesn't touch the existing app's render path, so it's safe to add to the
 * frontend without risking regressions in the original 22k-line app.js.
 *
 * Flow:
 *   1. User clicks "✨ AI Scope Extract" in the header.
 *   2. Modal opens -- user drops a PDF.
 *   3. POST /api/ai/scope-extract (multipart) with the bearer token.
 *   4. Modal shows the parsed result (project metadata, tasks, risks).
 *   5. User can:
 *        a) Click "Create new project from this" -- creates a project + tasks
 *           via the state blob, fully integrated with the existing app.
 *        b) Click "Add tasks to active project" -- merges tasks into the
 *           currently-selected project.
 *        c) Copy raw JSON (for inspection / manual paste).
 * =============================================================================
 */
(function () {
  const apiBaseMeta = document.querySelector('meta[name="api-base"]');
  const BASE = (apiBaseMeta && apiBaseMeta.content) || '';
  const apiEnabledMeta = document.querySelector('meta[name="api-enabled"]');
  const ENABLED = !apiEnabledMeta || apiEnabledMeta.content !== 'false';

  let lastResult = null;

  function injectStyles() {
    const css = `
      #sx-trigger {
        position: fixed; top: 14px; right: 28px; z-index: 90;
        background: #c8322b; color: #fff; border: 0; padding: 8px 14px;
        border-radius: 4px; font-weight: 700; font-size: 12px; cursor: pointer;
        font-family: 'Inter', system-ui, sans-serif; letter-spacing: 0.04em;
        box-shadow: 0 2px 6px rgba(200,50,43,0.25);
      }
      #sx-trigger:hover { background: #a82621; }
      #sx-modal {
        position: fixed; inset: 0; background: rgba(10,37,64,0.72);
        z-index: 9000; display: none; align-items: center; justify-content: center;
        font-family: 'Inter', system-ui, sans-serif;
      }
      #sx-modal.active { display: flex; }
      .sx-card {
        background: #fff; border-radius: 8px; width: 720px; max-width: 92vw;
        max-height: 88vh; overflow: hidden; display: flex; flex-direction: column;
        box-shadow: 0 20px 60px rgba(0,0,0,0.4);
      }
      .sx-card header {
        padding: 18px 24px; border-bottom: 1px solid #dbdfe5;
        display: flex; align-items: center; justify-content: space-between;
      }
      .sx-card header h2 { margin: 0; font-size: 18px; color: #0a2540; }
      .sx-card .sx-close { border: 0; background: transparent; font-size: 22px; cursor: pointer; color: #6b7687; }
      .sx-body { padding: 22px 24px; overflow: auto; flex: 1; }
      .sx-drop {
        border: 2px dashed #dbdfe5; border-radius: 6px; padding: 40px; text-align: center;
        color: #6b7687; cursor: pointer; transition: 0.15s;
      }
      .sx-drop:hover, .sx-drop.dragover { border-color: #c8322b; background: #fef5f4; color: #0a2540; }
      .sx-drop input { display: none; }
      .sx-status { margin-top: 14px; font-size: 13px; color: #6b7687; min-height: 20px; }
      .sx-status.error { color: #c8322b; }
      .sx-result h3 { font-size: 14px; color: #0a2540; margin: 18px 0 8px; text-transform: uppercase; letter-spacing: 0.04em; }
      .sx-meta { background: #f8f9fb; padding: 12px 14px; border-radius: 4px; font-size: 13px; line-height: 1.6; }
      .sx-meta b { color: #0a2540; }
      .sx-tasks { list-style: none; padding: 0; margin: 0; max-height: 240px; overflow: auto; border: 1px solid #edeff3; border-radius: 4px; }
      .sx-tasks li {
        padding: 8px 12px; border-bottom: 1px solid #edeff3; display: grid;
        grid-template-columns: 110px 1fr 64px; gap: 10px; font-size: 13px; align-items: center;
      }
      .sx-tasks li:last-child { border-bottom: 0; }
      .sx-stage-tag { font-size: 10px; font-weight: 700; text-transform: uppercase; color: #6b7687; letter-spacing: 0.04em; }
      .sx-priority { font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 3px; text-align: center; }
      .sx-priority.high { background: #fde4e2; color: #c8322b; }
      .sx-priority.medium { background: #fff4d6; color: #d4a017; }
      .sx-priority.low { background: #e3efff; color: #2563a8; }
      .sx-risks { background: #fde4e2; padding: 10px 14px; border-radius: 4px; color: #a82621; font-size: 13px; }
      .sx-risks ul { margin: 4px 0 0 18px; padding: 0; }
      .sx-card footer {
        padding: 14px 24px; border-top: 1px solid #dbdfe5; display: flex; gap: 8px; justify-content: flex-end;
      }
      .sx-btn { padding: 9px 14px; border-radius: 4px; border: 1px solid #dbdfe5; background: #fff; cursor: pointer; font-weight: 600; font-size: 13px; }
      .sx-btn.primary { background: #c8322b; color: #fff; border-color: #c8322b; }
      .sx-btn.primary:hover { background: #a82621; }
      .sx-btn:disabled { opacity: 0.5; cursor: wait; }
    `;
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function injectMarkup() {
    const trigger = document.createElement('button');
    trigger.id = 'sx-trigger';
    trigger.innerHTML = '✨ AI Scope';
    trigger.title = 'Upload a spec PDF — Claude extracts the project structure';
    trigger.addEventListener('click', open);
    document.body.appendChild(trigger);

    const modal = document.createElement('div');
    modal.id = 'sx-modal';
    modal.innerHTML = `
      <div class="sx-card">
        <header>
          <h2>✨ AI Scope Extraction</h2>
          <button class="sx-close" type="button" aria-label="Close">&times;</button>
        </header>
        <div class="sx-body">
          <label class="sx-drop" id="sx-drop">
            <strong>Drop a spec PDF here</strong>
            <div style="margin-top: 6px; font-size: 12px;">or click to choose a file</div>
            <input type="file" accept="application/pdf">
          </label>
          <div class="sx-status" id="sx-status"></div>
          <div id="sx-result" style="display: none;"></div>
        </div>
        <footer>
          <button class="sx-btn" id="sx-copy" disabled type="button">Copy JSON</button>
          <button class="sx-btn" id="sx-add-active" disabled type="button">Add to active project</button>
          <button class="sx-btn primary" id="sx-create" disabled type="button">Create new project</button>
        </footer>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    modal.querySelector('.sx-close').addEventListener('click', close);

    const drop = modal.querySelector('#sx-drop');
    const fileInput = drop.querySelector('input');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('dragover');
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', () => { if (fileInput.files.length) handleFile(fileInput.files[0]); });

    document.getElementById('sx-copy').addEventListener('click', copyJson);
    document.getElementById('sx-add-active').addEventListener('click', () => applyResult('add-to-active'));
    document.getElementById('sx-create').addEventListener('click', () => applyResult('create-new'));
  }

  function open() { document.getElementById('sx-modal').classList.add('active'); }
  function close() { document.getElementById('sx-modal').classList.remove('active'); }

  async function handleFile(file) {
    const status = document.getElementById('sx-status');
    status.classList.remove('error');
    status.textContent = `Uploading ${file.name} (${Math.round(file.size/1024)} KB)…`;
    if (!ENABLED) {
      status.classList.add('error');
      status.textContent = 'Backend sync is disabled in this build (api-enabled=false).';
      return;
    }
    const token = (window.auth && window.auth.token) || null;
    if (!token) {
      status.classList.add('error');
      status.textContent = 'Not authenticated. Refresh and sign in.';
      return;
    }

    const fd = new FormData();
    fd.append('pdf', file);
    try {
      const r = await fetch(BASE + '/api/ai/scope-extract', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: fd
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Extraction failed');
      lastResult = data.result;
      status.textContent = `✓ Parsed in ~${Math.round(file.size/1024)} KB.`;
      renderResult(data.result);
    } catch (err) {
      status.classList.add('error');
      status.textContent = 'Error: ' + err.message;
    }
  }

  function renderResult(result) {
    const out = document.getElementById('sx-result');
    out.style.display = 'block';
    const tasks = (result.tasks || []).map(t => `
      <li>
        <span class="sx-stage-tag">${escapeHtml(t.stage || '')}</span>
        <span>${escapeHtml(t.title || '')}</span>
        <span class="sx-priority ${escapeAttr(t.priority || 'medium')}">${escapeHtml(t.priority || 'med')}</span>
      </li>
    `).join('');
    const trades = (result.trades || []).map(tr => `<li>${escapeHtml(tr.csi_division || '')} — ${escapeHtml(tr.name || '')}</li>`).join('');
    const risks = (result.risks || []).map(rk => `<li>${escapeHtml(rk)}</li>`).join('');
    out.innerHTML = `
      <h3>Project</h3>
      <div class="sx-meta">
        <b>Name:</b> ${escapeHtml(result.project?.name || '?')}<br>
        <b>Client:</b> ${escapeHtml(result.project?.client || '?')}<br>
        <b>Location:</b> ${escapeHtml(result.project?.location || '?')}<br>
        <b>Summary:</b> ${escapeHtml(result.project?.scope_summary || '')}
      </div>
      ${trades ? `<h3>Trades (${(result.trades||[]).length})</h3><ul style="margin:0; padding-left:20px; font-size:13px;">${trades}</ul>` : ''}
      <h3>Suggested tasks (${(result.tasks||[]).length})</h3>
      <ul class="sx-tasks">${tasks || '<li>No tasks suggested.</li>'}</ul>
      ${risks ? `<h3>Risks</h3><div class="sx-risks"><ul>${risks}</ul></div>` : ''}
    `;
    document.getElementById('sx-copy').disabled = false;
    document.getElementById('sx-add-active').disabled = false;
    document.getElementById('sx-create').disabled = false;
  }

  function applyResult(mode) {
    if (!lastResult) return;
    const status = document.getElementById('sx-status');
    try {
      if (typeof state === 'undefined' || typeof saveState !== 'function' || typeof uid !== 'function') {
        throw new Error('App state not ready -- close and re-open the modal once the app finishes loading.');
      }
      const tasks = (lastResult.tasks || []).map(t => ({
        id: uid(), title: t.title || '', stage: t.stage || 'project-setup',
        priority: t.priority || 'medium', status: 'not-started',
        notes: t.notes || '', createdAt: Date.now()
      }));
      if (mode === 'create-new') {
        const p = {
          id: uid(),
          name: lastResult.project?.name || 'New Project (AI extracted)',
          client: lastResult.project?.client || '',
          location: lastResult.project?.location || '',
          tasks,
          createdAt: Date.now()
        };
        state.projects = state.projects || [];
        state.projects.push(p);
        state.activeProjectId = p.id;
        status.textContent = `✓ Created project "${p.name}" with ${tasks.length} tasks.`;
      } else if (mode === 'add-to-active') {
        const active = (state.projects || []).find(x => x.id === state.activeProjectId);
        if (!active) throw new Error('No active project. Pick one first or use "Create new project."');
        active.tasks = (active.tasks || []).concat(tasks);
        status.textContent = `✓ Added ${tasks.length} tasks to "${active.name}".`;
      }
      saveState();
      if (typeof render === 'function') render();
      setTimeout(close, 900);
    } catch (err) {
      status.classList.add('error');
      status.textContent = 'Error: ' + err.message;
    }
  }

  function copyJson() {
    if (!lastResult) return;
    navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2)).then(() => {
      const status = document.getElementById('sx-status');
      status.textContent = '✓ Copied JSON to clipboard.';
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/[^a-zA-Z0-9_-]/g, ''); }

  document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
    injectMarkup();
  });
})();
