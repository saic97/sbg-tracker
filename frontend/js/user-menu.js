/* =============================================================================
 * user-menu.js -- Header avatar + dropdown with Sign Out.
 *
 * Injects a circular avatar in the top-right header showing the current user's
 * initials. Clicking it opens a small menu with:
 *   - Name + email + role
 *   - Sign out
 *
 * Designed to be extended (Profile, Change password, etc.) without restructure.
 * =============================================================================
 */
(function () {
  const apiBaseMeta = document.querySelector('meta[name="api-base"]');
  const BASE = (apiBaseMeta && apiBaseMeta.content) || '';
  const apiEnabledMeta = document.querySelector('meta[name="api-enabled"]');
  const ENABLED = !apiEnabledMeta || apiEnabledMeta.content !== 'false';

  function colorForName(name) {
    const palette = ['#c8322b','#0a2540','#2563a8','#2e7d52','#d4a017','#7b4397','#00897b','#5d4037','#455a64','#e65100'];
    let h = 0;
    for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return palette[Math.abs(h) % palette.length];
  }
  function initialsForName(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function injectStyles() {
    const css = `
      #um-avatar {
        position: fixed; top: 14px; right: 14px; z-index: 91;
        width: 32px; height: 32px; border-radius: 50%; border: 0; cursor: pointer;
        color: #fff; font-weight: 700; font-size: 12px;
        display: inline-flex; align-items: center; justify-content: center;
        font-family: 'Inter', system-ui, sans-serif; letter-spacing: 0.02em;
        box-shadow: 0 2px 6px rgba(10,37,64,0.25);
        text-transform: uppercase;
        transition: transform 0.1s;
      }
      #um-avatar:hover { transform: scale(1.06); }
      #um-menu {
        position: fixed; top: 54px; right: 14px; z-index: 95;
        background: #fff; border-radius: 8px; min-width: 240px;
        box-shadow: 0 12px 40px rgba(10,37,64,0.25);
        border: 1px solid #dbdfe5;
        font-family: 'Inter', system-ui, sans-serif; display: none; overflow: hidden;
      }
      #um-menu.active { display: block; }
      .um-header {
        padding: 14px 16px; border-bottom: 1px solid #edeff3;
        display: flex; gap: 12px; align-items: center;
      }
      .um-mini-avatar {
        width: 40px; height: 40px; border-radius: 50%; color: #fff;
        display: inline-flex; align-items: center; justify-content: center;
        font-weight: 700; font-size: 14px; text-transform: uppercase;
        flex-shrink: 0;
      }
      .um-who { flex: 1; min-width: 0; }
      .um-name { font-weight: 700; color: #0a2540; font-size: 13px; line-height: 1.2; word-break: break-word; }
      .um-email { color: #6b7687; font-size: 11px; margin-top: 2px; word-break: break-all; }
      .um-role {
        display: inline-block; margin-top: 4px; font-size: 9px; font-weight: 700;
        padding: 1px 6px; border-radius: 8px; text-transform: uppercase; letter-spacing: 0.04em;
      }
      .um-role.admin     { background: #fde4e2; color: #c8322b; }
      .um-role.estimator { background: #e3efff; color: #2563a8; }
      .um-role.viewer    { background: #ece1f3; color: #7b4397; }
      .um-list { padding: 6px 0; }
      .um-item {
        display: flex; align-items: center; gap: 10px;
        width: 100%; padding: 9px 16px; border: 0; background: transparent;
        cursor: pointer; font: inherit; color: #0a2540; font-size: 13px;
        text-align: left;
      }
      .um-item:hover { background: #f4f5f7; }
      .um-item.danger { color: #c8322b; }
      .um-item.danger:hover { background: #fde4e2; }
      .um-icon { width: 16px; text-align: center; opacity: 0.7; }
    `;
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function injectMarkup() {
    const btn = document.createElement('button');
    btn.id = 'um-avatar'; btn.type = 'button';
    btn.title = 'Account menu';
    document.body.appendChild(btn);

    const menu = document.createElement('div');
    menu.id = 'um-menu';
    document.body.appendChild(menu);

    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    document.addEventListener('click', (e) => {
      const m = document.getElementById('um-menu');
      const b = document.getElementById('um-avatar');
      if (!m || !m.classList.contains('active')) return;
      if (m.contains(e.target) || b.contains(e.target)) return;
      m.classList.remove('active');
    });
  }

  function renderAvatar() {
    const btn = document.getElementById('um-avatar');
    if (!btn) return;
    const user = window.auth && window.auth.user;
    if (!user) { btn.style.display = 'none'; return; }
    btn.style.display = 'inline-flex';
    btn.style.background = colorForName(user.name || user.email);
    btn.textContent = initialsForName(user.name || user.email);
    btn.title = (user.name || user.email) + ' · ' + (user.role || 'user') + ' — click for menu';
  }

  function renderMenu() {
    const m = document.getElementById('um-menu');
    if (!m) return;
    const user = window.auth && window.auth.user;
    if (!user) { m.innerHTML = ''; return; }
    const color = colorForName(user.name || user.email);
    const initials = initialsForName(user.name || user.email);
    m.innerHTML = `
      <div class="um-header">
        <span class="um-mini-avatar" style="background:${color}">${escapeHtml(initials)}</span>
        <div class="um-who">
          <div class="um-name">${escapeHtml(user.name || '(no name)')}</div>
          <div class="um-email">${escapeHtml(user.email)}</div>
          <span class="um-role ${escapeHtml(user.role || 'estimator')}">${escapeHtml(user.role || 'estimator')}</span>
        </div>
      </div>
      <div class="um-list">
        <button class="um-item" type="button" data-action="reload">
          <span class="um-icon">🔄</span><span>Reload state from server</span>
        </button>
        <button class="um-item danger" type="button" data-action="signout">
          <span class="um-icon">⎋</span><span>Sign out</span>
        </button>
      </div>
    `;
    m.querySelector('[data-action="signout"]').addEventListener('click', signOut);
    m.querySelector('[data-action="reload"]').addEventListener('click', async () => {
      try {
        if (typeof syncStateFromServer === 'function') {
          const updated = await syncStateFromServer();
          if (typeof render === 'function') render();
          if (updated && typeof openHomeView === 'function') openHomeView();
        } else {
          location.reload();
        }
      } catch (e) { console.warn(e); }
      m.classList.remove('active');
    });
  }

  function toggle() {
    const m = document.getElementById('um-menu');
    if (!m) return;
    renderMenu();
    m.classList.toggle('active');
  }

  async function signOut() {
    try {
      if (window.auth && typeof window.auth.logout === 'function') {
        await window.auth.logout();   // posts to /api/auth/logout + clears + reload
      } else {
        localStorage.removeItem('SBG_AUTH_TOKEN');
        localStorage.removeItem('SBG_AUTH_USER');
        location.reload();
      }
    } catch (e) {
      console.warn('logout failed, forcing local clear:', e);
      localStorage.removeItem('SBG_AUTH_TOKEN');
      localStorage.removeItem('SBG_AUTH_USER');
      location.reload();
    }
  }

  function bootWhenReady() {
    if (window.auth && window.auth.user) {
      renderAvatar();
    } else {
      setTimeout(bootWhenReady, 500);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!ENABLED) return;
    injectStyles();
    injectMarkup();
    bootWhenReady();
    // Re-render avatar periodically in case the user info lands late.
    setInterval(renderAvatar, 2000);
  });
})();
