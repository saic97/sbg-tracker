/* =============================================================================
 * user-menu.js -- Account section in the sidebar with Sign Out.
 *
 * Injects an "Account" section in #appSidebar (right above the footer) that
 * shows the signed-in user's name/email/role plus a Sign Out button styled
 * to match the existing sidebar buttons.
 * =============================================================================
 */
(function () {
  console.log('[user-menu] script loaded');

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
    if (document.getElementById('um-styles')) return;
    const css = `
      .um-account-card {
        display: flex; align-items: center; gap: 10px;
        padding: 8px; margin-bottom: 8px;
        background: rgba(10,37,64,0.04);
        border: 1px solid rgba(10,37,64,0.08);
        border-radius: 8px;
      }
      .um-mini-avatar {
        width: 32px; height: 32px; border-radius: 50%; color: #fff;
        display: inline-flex; align-items: center; justify-content: center;
        font-weight: 800; font-size: 12px; text-transform: uppercase;
        flex-shrink: 0;
      }
      .um-who { flex: 1; min-width: 0; }
      .um-name {
        font-weight: 700; color: #0a2540; font-size: 12px;
        line-height: 1.2;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .um-email {
        color: #6b7687; font-size: 10px; margin-top: 1px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .um-role {
        display: inline-block; margin-top: 3px; font-size: 9px; font-weight: 700;
        padding: 1px 6px; border-radius: 8px; text-transform: uppercase; letter-spacing: 0.04em;
      }
      .um-role.admin     { background: #fde4e2; color: #c8322b; }
      .um-role.estimator { background: #e3efff; color: #2563a8; }
      .um-role.viewer    { background: #ece1f3; color: #7b4397; }
      .um-signout-btn {
        background: #c8322b !important;
        color: #fff !important;
        border-color: #c8322b !important;
      }
      .um-signout-btn:hover { background: #a02620 !important; border-color: #a02620 !important; }
      /* Hide account card details when sidebar is collapsed (icon-only) */
      .sidebar-collapsed .um-account-card .um-who { display: none; }
      .sidebar-collapsed .um-account-card { justify-content: center; padding: 6px; }
    `;
    const s = document.createElement('style');
    s.id = 'um-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function injectSection() {
    if (document.getElementById('umAccountSection')) return true;

    const sidebar = document.getElementById('appSidebar') || document.querySelector('.sidebar');
    if (!sidebar) return false;

    const footer = document.getElementById('sidebarFooter');

    const section = document.createElement('div');
    section.className = 'sidebar-section';
    section.id = 'umAccountSection';
    section.innerHTML = `
      <div class="sidebar-title">Account</div>
      <div class="um-account-card" id="umAccountCard">
        <span class="um-mini-avatar" id="umMiniAvatar">?</span>
        <div class="um-who">
          <div class="um-name" id="umName">—</div>
          <div class="um-email" id="umEmail">—</div>
          <span class="um-role" id="umRole">user</span>
        </div>
      </div>
      <button class="btn btn-sm sb-button um-signout-btn"
              style="width:100%;justify-content:center;"
              type="button"
              id="umSignoutBtn"
              title="Sign out of this account">
        <span class="sb-btn-icon">&#x23fb;</span><span class="sb-btn-label"> Sign Out</span>
      </button>
      <div class="hint-inline sb-hint" style="margin-top:6px;">End this session and return to login</div>
    `;

    if (footer && footer.parentNode === sidebar) {
      sidebar.insertBefore(section, footer);
    } else {
      sidebar.appendChild(section);
    }

    document.getElementById('umSignoutBtn').addEventListener('click', signOut);
    return true;
  }

  function renderAccount() {
    const card = document.getElementById('umAccountCard');
    const section = document.getElementById('umAccountSection');
    if (!card || !section) return;

    const user = window.auth && window.auth.user;
    if (!user) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';

    const name = user.name || user.email || 'User';
    const initials = initialsForName(name);
    const color = colorForName(name);

    const av = document.getElementById('umMiniAvatar');
    if (av) { av.textContent = initials; av.style.background = color; }

    const nameEl  = document.getElementById('umName');
    const emailEl = document.getElementById('umEmail');
    const roleEl  = document.getElementById('umRole');
    if (nameEl)  nameEl.textContent = user.name || '(no name)';
    if (emailEl) emailEl.textContent = user.email || '';
    if (roleEl) {
      roleEl.textContent = user.role || 'estimator';
      roleEl.className = 'um-role ' + (user.role || 'estimator');
    }
  }

  async function signOut() {
    const ok = window.confirm('Sign out of ' + ((window.auth && window.auth.user && window.auth.user.email) || 'this account') + '?');
    if (!ok) return;
    try {
      if (window.auth && typeof window.auth.logout === 'function') {
        await window.auth.logout();
        return;
      }
    } catch (e) {
      console.warn('[user-menu] logout failed, forcing local clear:', e);
    }
    try {
      localStorage.removeItem('SBG_AUTH_TOKEN');
      localStorage.removeItem('SBG_AUTH_USER');
    } catch (e) { /* ignore */ }
    location.reload();
  }

  function boot() {
    if (!ENABLED) {
      console.log('[user-menu] api disabled — Account section not injected');
      return;
    }
    injectStyles();
    let attempts = 0;
    function tryInject() {
      attempts++;
      const placed = injectSection();
      if (placed) {
        renderAccount();
        console.log('[user-menu] sidebar Account section injected');
        // keep avatar/name fresh if auth state lands later
        setInterval(renderAccount, 1500);
      } else if (attempts < 40) {
        setTimeout(tryInject, 250);
      } else {
        console.warn('[user-menu] could not find #appSidebar after 10s -- giving up');
      }
    }
    tryInject();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
