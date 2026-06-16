/* =============================================================================
 * realtime.js -- Socket.IO client for real-time multi-user sync + presence.
 *
 * Flow:
 *   1. After auth lands (window.auth.token is set), connect to the backend.
 *   2. Server validates the bearer token in the handshake.
 *   3. Server broadcasts presence:list whenever anyone joins/leaves.
 *      We render a small avatar row in the top-right of the header.
 *   4. Server broadcasts state:updated when ANYONE PUTs /api/state.
 *      If the event's clientId matches our own (we sent it), we ignore it.
 *      Otherwise, we merge the incoming state into `window.state` and re-render.
 *
 * Outgoing tagging: api.js needs to send a clientId on every PUT /api/state so
 * the server can skip echoing back to us. We expose `window.realtime.clientId`
 * for that purpose.
 *
 * Disabled when api-enabled is "false" (pure-localStorage demo mode).
 * =============================================================================
 */
(function () {
  const apiBaseMeta = document.querySelector('meta[name="api-base"]');
  const BASE = (apiBaseMeta && apiBaseMeta.content) || '';
  const apiEnabledMeta = document.querySelector('meta[name="api-enabled"]');
  const ENABLED = !apiEnabledMeta || apiEnabledMeta.content !== 'false';

  // A unique per-tab id so we can ignore our own broadcasts.
  const clientId = 'c-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
  const rt = { clientId, socket: null, presence: [], enabled: ENABLED };
  window.realtime = rt;

  if (!ENABLED) return;

  // Load socket.io client from the backend (Express serves /socket.io/socket.io.js by default).
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve; s.onerror = () => reject(new Error('failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  function injectPresenceStyles() {
    const css = `
      #rt-presence {
        position: fixed; top: 14px; right: 130px; z-index: 90;
        display: flex; align-items: center; gap: 6px;
        font-family: 'Inter', system-ui, sans-serif; font-size: 12px;
      }
      #rt-presence .rt-dot {
        width: 8px; height: 8px; border-radius: 50%; background: #ccc;
        transition: background 0.2s;
      }
      #rt-presence .rt-dot.online { background: #2e7d52; box-shadow: 0 0 0 2px rgba(46,125,82,0.18); }
      #rt-presence .rt-dot.offline { background: #c8322b; }
      #rt-presence .rt-avatars { display: flex; align-items: center; }
      #rt-presence .rt-avatar {
        width: 26px; height: 26px; border-radius: 50%; color: #fff;
        display: inline-flex; align-items: center; justify-content: center;
        font-weight: 700; font-size: 11px; margin-left: -6px;
        border: 2px solid #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.1);
        text-transform: uppercase; cursor: default;
      }
      #rt-toast {
        position: fixed; bottom: 24px; right: 24px; z-index: 95;
        background: #0a2540; color: #fff; padding: 10px 14px; border-radius: 4px;
        font-family: 'Inter', system-ui, sans-serif; font-size: 13px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.25);
        opacity: 0; transform: translateY(8px); transition: opacity 0.2s, transform 0.2s;
        pointer-events: none; max-width: 320px;
      }
      #rt-toast.show { opacity: 1; transform: translateY(0); }
    `;
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function injectPresenceMarkup() {
    const el = document.createElement('div');
    el.id = 'rt-presence';
    el.innerHTML = '<span class="rt-dot" title="Connecting..."></span><span class="rt-avatars"></span>';
    document.body.appendChild(el);
    const toast = document.createElement('div');
    toast.id = 'rt-toast';
    document.body.appendChild(toast);
  }

  function colorForName(name) {
    const palette = ['#c8322b','#0a2540','#2563a8','#2e7d52','#d4a017','#7b4397','#00897b','#5d4037','#455a64','#e65100'];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return palette[Math.abs(h) % palette.length];
  }
  function initialsForName(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function renderPresence(list) {
    rt.presence = list || [];
    const root = document.getElementById('rt-presence');
    if (!root) return;
    const dot = root.querySelector('.rt-dot');
    dot.classList.toggle('online', !!(rt.socket && rt.socket.connected));
    dot.classList.toggle('offline', !(rt.socket && rt.socket.connected));
    dot.title = (rt.socket && rt.socket.connected) ? 'Live · ' + rt.presence.length + ' online' : 'Disconnected';
    const av = root.querySelector('.rt-avatars');
    const me = window.auth && window.auth.user && window.auth.user.id;
    const others = rt.presence.filter(p => p.userId !== me);
    av.innerHTML = others.map(p => {
      const color = colorForName(p.name || p.email);
      const init = initialsForName(p.name || p.email);
      return `<span class="rt-avatar" style="background:${color}" title="${escapeHtml(p.name || p.email)}${p.activeProjectId ? ' · viewing a project' : ''}">${escapeHtml(init)}</span>`;
    }).join('');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  let toastTimer = null;
  function showToast(text) {
    const el = document.getElementById('rt-toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // Coalesce bursts of state:updated events so we render once per ~100ms
  // window instead of N times back to back. CRUCIAL: now that payloads are
  // incremental deltas (one task, one project's meta), we QUEUE every payload
  // and apply them all -- the old "keep only the most recent" behavior would
  // silently drop every delta but the last.
  let _pendingRemote = [];
  let _pendingRemoteTimer = null;
  function applyRemoteState(payload) {
    if (payload.clientId === rt.clientId) return;  // our own change, ignore
    if (!payload.state || typeof window.state === 'undefined') return;
    _pendingRemote.push(payload);
    if (_pendingRemoteTimer) return;
    _pendingRemoteTimer = setTimeout(() => {
      const batch = _pendingRemote;
      _pendingRemote = [];
      _pendingRemoteTimer = null;
      _flushRemoteBatch(batch);
    }, 100);
  }

  // Apply a whole batch of deltas to window.state, then persist + render ONCE.
  function _flushRemoteBatch(batch) {
    if (!batch || !batch.length) return;
    let lastByUserName = null;
    let lastVersion = null;
    for (const payload of batch) {
      _applyOneRemotePayload(payload);
      if (payload.byUserName) lastByUserName = payload.byUserName;
      if (typeof payload.version === 'number') lastVersion = payload.version;
    }
    window.lastSyncedState = JSON.parse(JSON.stringify(window.state));
    try { localStorage.setItem('sbg_precon_tracker_v3', JSON.stringify(window.state)); } catch(e) {}
    // Track the server's monotonic state version so the next saveState() PUTs
    // the right `expectedVersion` and doesn't trip the optimistic-concurrency
    // guard (which would otherwise treat a fresh post-broadcast save as stale).
    if (lastVersion !== null && window.api && typeof window.api.setStateVersion === 'function') {
      window.api.setStateVersion(lastVersion);
    }
    if (typeof render === 'function') render();
    if (lastByUserName) showToast('Updated by ' + lastByUserName);
  }

  // Merge ONE payload into window.state (no persist/render -- the batch does
  // that once at the end).
  function _applyOneRemotePayload(payload) {
    if (!payload || !payload.state) return;

    // Merge: replace top-level state fields by subdomain to avoid wiping out other data
    const newState = { ...window.state };
    
    for (const key of Object.keys(payload.state)) {
      if (key === 'projects' && Array.isArray(payload.state.projects)) {
        // Merge projects: update/add received project(s), preserve others
        const projectMap = new Map(newState.projects.map(p => [p.id, p]));
        for (const p of payload.state.projects) {
          projectMap.set(p.id, p);
        }
        newState.projects = Array.from(projectMap.values());
      } else if (key === 'teamMembers' && Array.isArray(payload.state.teamMembers)) {
        newState.teamMembers = payload.state.teamMembers;
      } else if (key === 'taskTemplates' && Array.isArray(payload.state.taskTemplates)) {
        newState.taskTemplates = payload.state.taskTemplates;
      } else {
        newState[key] = payload.state[key];
      }
    }
    
    // Handle deleted projects if explicitly broadcasted
    if (payload.deletedProjectId) {
      newState.projects = newState.projects.filter(p => p.id !== payload.deletedProjectId);
      if (newState.activeProjectId === payload.deletedProjectId) {
        const fallback = newState.projects.find(x => !x.archived);
        newState.activeProjectId = fallback ? fallback.id : null;
        if (!fallback) newState.homeView = true;
      }
    }

    // ---- Per-task / project-meta merges (finer than a whole project) ----
    // Each touches ONE task or only the meta fields, so sibling tasks and
    // server-owned subBids are left intact.
    if (payload.taskUpsert && payload.taskUpsert.projectId && payload.taskUpsert.task) {
      const { projectId, task } = payload.taskUpsert;
      const proj = newState.projects.find(p => p.id === projectId);
      if (proj) {
        const tasks = Array.isArray(proj.tasks) ? proj.tasks.slice() : [];
        const idx = tasks.findIndex(t => t.id === task.id);
        if (idx === -1) tasks.push(task); else tasks[idx] = task;
        proj.tasks = tasks;
      }
      // If we don't have the project yet, skip -- a subsequent full sync /
      // 304-miss boot will pull it.
    }
    if (payload.taskDelete && payload.taskDelete.projectId) {
      const { projectId, taskId } = payload.taskDelete;
      const proj = newState.projects.find(p => p.id === projectId);
      if (proj && Array.isArray(proj.tasks)) {
        proj.tasks = proj.tasks.filter(t => t.id !== taskId);
      }
    }
    if (payload.projectMeta && payload.projectMeta.projectId && payload.projectMeta.meta) {
      const { projectId, meta } = payload.projectMeta;
      const proj = newState.projects.find(p => p.id === projectId);
      if (proj) {
        const keptTasks = proj.tasks;       // meta must never wipe tasks...
        const keptSubBids = proj.subBids;   // ...or server-owned subBids
        Object.assign(proj, meta);
        proj.tasks = keptTasks;
        if (typeof keptSubBids !== 'undefined') proj.subBids = keptSubBids;
      } else {
        newState.projects = newState.projects.concat([{ ...meta, tasks: [] }]);
      }
    }

    const localUiFlags = {
      activeProjectId: window.state.activeProjectId,
      activeStageId: window.state.activeStageId,
      activeAssignee: window.state.activeAssignee,
      grouping: window.state.grouping,
      viewMode: window.state.viewMode,
      // Device-local UI prefs: never let a remote user's values clobber ours
      // (these no longer travel from an up-to-date server, but a peer on an
      // older build could still broadcast them).
      sidebarCollapsed: window.state.sidebarCollapsed,
      homeView: window.state.homeView,
      currentUser: window.state.currentUser,
      bulkSelectionMode: false, bulkSelectedTaskIds: [],
    };
    
    window.state = { ...newState, ...localUiFlags };
  }

  function reportActiveProject() {
    if (!rt.socket || !rt.socket.connected) return;
    const pid = (window.state && window.state.activeProjectId) || null;
    rt.socket.emit('presence:update', { activeProjectId: pid });
  }

  async function start() {
    if (!window.auth || !window.auth.token) return;  // not authed yet
    try {
      // Load the Socket.IO browser client served by the backend at /socket.io/socket.io.js
      await loadScript(BASE + '/socket.io/socket.io.js');
    } catch (e) {
      console.warn('[realtime] socket.io client load failed:', e.message);
      return;
    }
    injectPresenceStyles();
    injectPresenceMarkup();

    /* global io */
    const socket = io(BASE || undefined, {
      auth: { token: window.auth.token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    rt.socket = socket;

    socket.on('connect', () => {
      console.log('[realtime] connected', socket.id);
      renderPresence(rt.presence);
      reportActiveProject();
    });
    socket.on('disconnect', () => {
      console.log('[realtime] disconnected');
      renderPresence(rt.presence);
    });
    socket.on('connect_error', (err) => {
      console.warn('[realtime] connect_error:', err && err.message);
      renderPresence(rt.presence);
    });
    socket.on('presence:list', renderPresence);
    socket.on('state:updated', applyRemoteState);

    // Detect activeProjectId changes from the app and report them.
    let lastReportedPid = null;
    setInterval(() => {
      const pid = (window.state && window.state.activeProjectId) || null;
      if (pid !== lastReportedPid) {
        lastReportedPid = pid;
        reportActiveProject();
      }
    }, 1500);
  }

  // Boot when auth + DOM are ready. We poll briefly because auth-ui.js may
  // race with DOMContentLoaded depending on token caching.
  function bootWhenReady() {
    if (window.auth && window.auth.token) {
      start();
    } else {
      setTimeout(bootWhenReady, 500);
    }
  }
  document.addEventListener('DOMContentLoaded', bootWhenReady);
})();
