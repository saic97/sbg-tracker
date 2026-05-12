/* =============================================================================
 * user-menu.js -- Unmissable "Sign Out" pill in the top-right corner.
 *
 * Renders a high-z-index pill button that's hard to miss no matter what other
 * styles the imported HTML carries. Clicking it opens a small dropdown with
 *   - Name + email + role
 *   - Reload state from server
 *   - Sign out
 * =============================================================================
 */
(function () {
  console.log('[user-menu] script loaded');

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
      #um-pill {
        position: fixed !important;
        top: 14px !important;
        right: 18px !important;
        z-index: 2147483646 !important;
        display: inline-flex !important;
        align-items: center !important;
        gap: 8px !important;
        padding: 8px 14px 8px 8px !important;
        border-radius: 999px !important;
        border: 2px solid #fff !important;
        background: #c8322b !important;
        color: #fff !important;
        cursor: pointer !important;
        font-family: 'Inter', system-ui, sans-serif !important;
        font-weight: 700 !important;
        font-size: 13px !important;
        letter-spacing: 0.02em !important;
        box-shadow: 0 4px 14px rgba(10,37,64,0.45) !important;
        line-height: 1 !important;
        text-transform: uppercase !important;
      }
      #um-pill:hover { background: #a02620 !important; }
      #um-pill .um-bubble {
        display: inline-flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; border-radius: 50%;
        background: rgba(255,255,255,0.18);
        font-size: 11px; font-weight: 800;
      }
      #um-pill .um-text { white-space: nowrap; }
      #um-menu {
        position: fixed !important;
        top: 58px !important;
        right: 18px !important;
        z-index: 2147483647 !important;
        background: #fff;
        border-radius: 10px;
        min-width: 260px;
        box-shadow: 0 16px 50px rgba(10,37,64,0.35);
        border: 1px solid #dbdfe5;
        font-family: 'Inter', system-ui, sans-serif;
        display: none;
        overflow: hidden;
      }
      #um-menu.active { display: block !important; }
      .um-header {
        padding: 14px 16px;
        border-bottom: 1px solid #edeff3;
        display: flex; gap: 12px; align-items: center;
      }
      .um-mini-avatar {
        width: 40px; height: 40px; border-radius: 50%; color: #fff;
        display: inline-flex; align-items: center; justify-content: center;
        font-weight: 800; font-size: 14px; text-transform: uppercase;
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
        width: 100%; padding: 10px 16px; border: 0; background: transparent;
        cursor: pointer; font: inherit; color: #0a2540; font-size: 13px;
        text-align: left;
      }
      .um-item:hover { background: #f4f5f7; }
      .um-item.danger { color: #c8322b; font-weight: 700; }
      .um-item.danger:hover { background: #fde4e2; }
      .um-icon { width: 16px; text-align: center; opacity: 0.85; }
    `;
    const s = document.createElement('style');
    s.id = 'um-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function injectMarkup() {
    if (document.getElementById('um-pill')) return;

    const btn = document.createElement('button');
    btn.id = 'um-pill';
    btn.type = 'button';
    btn.title = 'Account menu';
    btn.innerHTML = '<span class="um-bubble" id="um-bubble">?</span><span class="um-text" id="um-text">Sign Out</span>';
    document.body.appendChild(btn);

    const menu = document.createElement('div');
    menu.id = 'um-menu';
    document.body.appendChild(menu);

    btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    document.addEventListener('click', (e) => {
      const m = document.getElementById('um-menu');
      const b = document.getElementById('um-pill');
      if (!m || !m.classList.contains('active')) return;
      if (m.contains(e.target) || b.contains(e.target)) return;
      m.classList.remove('active');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const m = document.getElementById('um-menu');
        if (m) m.classList.remove('active');
      }
    });
  }

  function renderPill() {
    const btn = document.getElementById('um-pill');
    if (!btn) return;
    const user = window.auth && window.auth.user;
    if (!user) {
      btn.style.display = 'none';
      return;
    }
    btn.style.display = 'inline-flex';
    const bubble = document.getElementById('um-bubble');
    if (bubble) bubble.textContent = initialsForName(user.name || user.email);
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
          <span class="um-icon">&#x21bb;</span><span>Reload state from server</span>
        </button>
        <button class="um-item danger" type="button" data-action="signout">
          <span class="um-icon">&#x23fb;</span><span>Sign out</span>
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
        await window.auth.logout();
        return;
      }
    } catch (e) {
      console.warn('[user-menu] logout failed, forcing local clear:', e);
    }
    // Fallback: clear tokens locally & reload
    try {
      localStorage.removeItem('SBG_AUTH_TOKEN');
      localStorage.removeItem('SBG_AUTH_USER');
    } catch (e) { /* ignore */ }
    location.reload();
  }

  function boot() {
    if (!ENABLED) {
      console.log('[user-menu] api disabled — sign-out button not shown');
      return;
    }
    injectStyles();
    injectMarkup();
    renderPill();
    // Repaint periodically in case auth state lands after this script.
    setInterval(renderPill, 1500);
    console.log('[user-menu] pill injected; window.auth.user =', window.auth && window.auth.user);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
