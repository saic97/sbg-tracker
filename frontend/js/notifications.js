/* =============================================================================
 * notifications.js -- 🔔 bell + per-user inbox dropdown.
 *
 * Polls the server for unread count on boot, then listens for `notification:new`
 * over the existing Socket.IO connection (window.realtime.socket).
 *
 * Visible to every authed user. Disabled in pure-localStorage demo mode.
 * =============================================================================
 */
(function () {
  const apiBaseMeta = document.querySelector('meta[name="api-base"]');
  const BASE = (apiBaseMeta && apiBaseMeta.content) || '';
  const apiEnabledMeta = document.querySelector('meta[name="api-enabled"]');
  const ENABLED = !apiEnabledMeta || apiEnabledMeta.content !== 'false';

  let unread = 0;
  let lastItems = [];

  function injectStyles() {
    const css = `
      #nf-bell {
        position: fixed; top: 14px; right: 396px; z-index: 91;
        width: 36px; height: 32px; border: 0; background: transparent;
        cursor: pointer; font-size: 18px; line-height: 1;
        display: inline-flex; align-items: center; justify-content: center;
      }
      #nf-bell .nf-badge {
        position: absolute; top: 3px; right: -4px;
        background: #c8322b; color: #fff; font-size: 10px; font-weight: 700;
        padding: 1px 5px; border-radius: 9px; min-width: 14px; text-align: center;
        font-family: 'Inter', system-ui, sans-serif; line-height: 14px;
        box-shadow: 0 0 0 2px rgba(255,255,255,0.9);
      }
      #nf-bell .nf-badge.hidden { display: none; }
      #nf-panel {
        position: fixed; top: 54px; right: 14px; z-index: 92;
        width: 380px; max-height: 70vh; overflow: hidden;
        background: #fff; border-radius: 8px; box-shadow: 0 12px 40px rgba(10,37,64,0.25);
        font-family: 'Inter', system-ui, sans-serif; display: none;
        border: 1px solid #dbdfe5;
      }
      #nf-panel.active { display: flex; flex-direction: column; }
      #nf-panel header {
        padding: 12px 16px; border-bottom: 1px solid #edeff3;
        display: flex; align-items: center; justify-content: space-between;
      }
      #nf-panel header strong { color: #0a2540; font-size: 14px; }
      .nf-clear-btn {
        font-size: 11px; color: #2563a8; background: transparent; border: 0;
        cursor: pointer; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
      }
      .nf-clear-btn:hover { color: #0a2540; }
      .nf-list { list-style: none; padding: 0; margin: 0; overflow: auto; flex: 1; }
      .nf-item {
        padding: 10px 16px; border-bottom: 1px solid #f0f2f5; cursor: pointer;
        display: grid; grid-template-columns: 26px 1fr; gap: 10px; align-items: start;
      }
      .nf-item:hover { background: #f8f9fb; }
      .nf-item.unread { background: #f5f9ff; }
      .nf-item.unread .nf-dot { background: #2563a8; }
      .nf-dot { width: 8px; height: 8px; border-radius: 50%; background: transparent; margin-top: 6px; justify-self: center; }
      .nf-content { font-size: 13px; line-height: 1.4; color: #0a2540; }
      .nf-title { font-weight: 600; }
      .nf-body { color: #2d3a4d; margin-top: 2px; }
      .nf-when { color: #9ba4b0; font-size: 11px; margin-top: 4px; }
      .nf-empty { padding: 28px 16px; text-align: center; color: #9ba4b0; font-size: 13px; }
    `;
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function injectMarkup() {
    const bell = document.createElement('button');
    bell.id = 'nf-bell';
    bell.type = 'button';
    bell.title = 'Notifications';
    bell.innerHTML = '🔔<span class="nf-badge hidden">0</span>';
    bell.addEventListener('click', toggle);
    document.body.appendChild(bell);

    const panel = document.createElement('div');
    panel.id = 'nf-panel';
    panel.innerHTML = `
      <header>
        <strong>Notifications</strong>
        <button class="nf-clear-btn" type="button" id="nf-mark-all">Mark all read</button>
      </header>
      <ul class="nf-list" id="nf-list">
        <li class="nf-empty">Loading…</li>
      </ul>
    `;
    document.body.appendChild(panel);

    document.getElementById('nf-mark-all').addEventListener('click', async (e) => {
      e.stopPropagation();
      await markAllRead();
      refresh();
    });
    document.addEventListener('click', (e) => {
      // close on outside click
      const panel = document.getElementById('nf-panel');
      const bell = document.getElementById('nf-bell');
      if (!panel || !panel.classList.contains('active')) return;
      if (panel.contains(e.target) || bell.contains(e.target)) return;
      panel.classList.remove('active');
    });
  }

  function authHeader() {
    return { 'Authorization': 'Bearer ' + (window.auth && window.auth.token) };
  }

  async function refresh() {
    if (!ENABLED || !window.auth || !window.auth.token) return;
    try {
      const r = await fetch(BASE + '/api/notifications?limit=30', { headers: authHeader() });
      if (!r.ok) return;
      const data = await r.json();
      unread = data.unread || 0;
      lastItems = data.items || [];
      renderBadge();
      renderList();
    } catch (e) { /* ignore */ }
  }

  function renderBadge() {
    const badge = document.querySelector('#nf-bell .nf-badge');
    if (!badge) return;
    if (unread > 0) {
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  function timeAgo(ms) {
    const diff = Date.now() - ms;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
    return Math.floor(diff/86400000) + 'd ago';
  }

  function renderList() {
    const ul = document.getElementById('nf-list');
    if (!ul) return;
    if (!lastItems.length) {
      ul.innerHTML = '<li class="nf-empty">No notifications yet. You will see assignments and team activity here.</li>';
      return;
    }
    ul.innerHTML = lastItems.map(n => `
      <li class="nf-item ${n.read_at ? '' : 'unread'}" data-id="${escapeAttr(n.id)}" data-link="${escapeAttr(n.link || '')}">
        <span class="nf-dot"></span>
        <div class="nf-content">
          <div class="nf-title">${escapeHtml(n.title || '')}</div>
          ${n.body ? `<div class="nf-body">${escapeHtml(n.body)}</div>` : ''}
          <div class="nf-when">${escapeHtml(timeAgo(n.createdAt))}</div>
        </div>
      </li>
    `).join('');
    ul.querySelectorAll('.nf-item').forEach(li => {
      li.addEventListener('click', async () => {
        const id = li.dataset.id;
        const link = li.dataset.link;
        await markRead(id);
        // Try to navigate to the linked project/task if the app supports it
        if (link && window.state && typeof render === 'function') {
          const proj = (link.match(/project=([^&]+)/) || [])[1];
          if (proj) {
            state.activeProjectId = decodeURIComponent(proj);
            saveState && saveState();
            render();
            // optionally close panel
            document.getElementById('nf-panel').classList.remove('active');
          }
        }
        refresh();
      });
    });
  }

  async function markRead(id) {
    try {
      await fetch(BASE + `/api/notifications/${encodeURIComponent(id)}/read`, {
        method: 'PATCH', headers: authHeader()
      });
    } catch (e) { /* ignore */ }
  }
  async function markAllRead() {
    try {
      await fetch(BASE + '/api/notifications/read-all', { method: 'POST', headers: authHeader() });
    } catch (e) { /* ignore */ }
  }

  function toggle(e) {
    e.stopPropagation();
    const panel = document.getElementById('nf-panel');
    panel.classList.toggle('active');
    if (panel.classList.contains('active')) refresh();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function wireRealtime() {
    if (!window.realtime || !window.realtime.socket) return false;
    const sock = window.realtime.socket;
    sock.on('notification:new', (n) => {
      // Bump unread + show a brief toast hint
      unread = (unread || 0) + 1;
      lastItems = [n, ...lastItems].slice(0, 30);
      renderBadge();
      // If panel is open, refresh visible list
      const panel = document.getElementById('nf-panel');
      if (panel && panel.classList.contains('active')) renderList();
    });
    return true;
  }

  function bootWhenReady() {
    if (!ENABLED) return;
    if (window.auth && window.auth.token) {
      refresh();
      // The socket may take an extra beat to attach; poll briefly.
      let tries = 0;
      const wireT = setInterval(() => {
        if (wireRealtime() || ++tries > 10) clearInterval(wireT);
      }, 500);
    } else {
      setTimeout(bootWhenReady, 500);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!ENABLED) return;
    injectStyles();
    injectMarkup();
    bootWhenReady();
  });
})();
