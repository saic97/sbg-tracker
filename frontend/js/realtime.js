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

  // Coalesce bursts of state:updated events. When two users save within ~100ms
  // of each other we used to re-render N times back to back; now we hold the
  // most recent payload and apply it once. Reduces both CPU and visible flicker
  // without making any individual update perceptibly slower.
  let _pendingRemote = null;
  let _pendingRemoteTimer = null;
  function applyRemoteState(payload) {
    if (payload.clientId === rt.clientId) return;  // our own change, ignore
    if (!payload.state || typeof window.state === 'undefined') return;
    _pendingRemote = payload;
    if (_pendingRemoteTimer) return;
    _pendingRemoteTimer = setTimeout(() => {
      const p = _pendingRemote;
      _pendingRemote = null;
      _pendingRemoteTimer = null;
      _flushRemoteState(p);
    }, 100);
  }

  function _flushRemoteState(payload) {
    // Merge: replace top-level state with the incoming state, but preserve
    // transient UI flags the server doesn't own.
    const localUiFlags = {
      activeProjectId: window.state.activeProjectId,
      activeStageId: window.state.activeStageId,
      activeAssignee: window.state.activeAssignee,
      grouping: window.state.grouping,
      viewMode: window.state.viewMode,
      bulkSelectionMode: false, bulkSelectedTaskIds: [],
    };
    window.state = { ...window.state, ...payload.state, ...localUiFlags };
    try { localStorage.setItem('sbg_precon_tracker_v3', JSON.stringify(window.state)); } catch(e) {}
    if (typeof render === 'function') render();
    if (payload.byUserName) showToast('Updated by ' + payload.byUserName);
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
