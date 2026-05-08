/* =============================================================================
 * auth-ui.js -- Login/signup modal + bearer-token management.
 *
 * Loaded BEFORE api.js and app.js. Until the user has a valid bearer token,
 * the app's UI is gated behind a full-page overlay with login + signup forms.
 *
 * Token storage: window.localStorage under SBG_AUTH_TOKEN. Cleared on logout.
 * The api.js client picks up the token from window.auth.token and adds it to
 * every fetch as Authorization: Bearer <token>.
 *
 * If api-enabled is false (pure-localStorage mode, e.g. on the public Pages
 * demo when no API is configured), we skip the auth gate entirely.
 * =============================================================================
 */
(function () {
  const apiEnabledMeta = document.querySelector('meta[name="api-enabled"]');
  const ENABLED = !apiEnabledMeta || apiEnabledMeta.content !== 'false';
  const apiBaseMeta = document.querySelector('meta[name="api-base"]');
  const BASE = (apiBaseMeta && apiBaseMeta.content) || '';
  const TOKEN_KEY = 'SBG_AUTH_TOKEN';
  const USER_KEY  = 'SBG_AUTH_USER';

  const auth = {
    token: localStorage.getItem(TOKEN_KEY) || null,
    user: JSON.parse(localStorage.getItem(USER_KEY) || 'null'),
    enabled: ENABLED,
    setSession({ token, user }) {
      this.token = token;
      this.user = user;
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    },
    clearSession() {
      this.token = null;
      this.user = null;
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    },
    async logout() {
      try {
        if (this.token) {
          await fetch(BASE + '/api/auth/logout', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + this.token }
          });
        }
      } catch (e) { /* ignore */ }
      this.clearSession();
      location.reload();
    },
  };
  window.auth = auth;

  if (!ENABLED) return;  // pure-localStorage mode -- skip the auth gate

  // Render the auth gate overlay. Hidden by default; shown if no valid session.
  function injectOverlay() {
    const css = `
      #sbg-auth-overlay {
        position: fixed; inset: 0; background: linear-gradient(135deg, #0a2540 0%, #0f2d4d 100%);
        z-index: 99999; display: flex; align-items: center; justify-content: center;
        font-family: 'Inter', system-ui, sans-serif;
      }
      #sbg-auth-overlay.hidden { display: none; }
      .sbg-auth-card {
        background: #fff; border-radius: 8px; padding: 32px; width: 380px; max-width: 92vw;
        box-shadow: 0 20px 60px rgba(0,0,0,0.4);
      }
      .sbg-auth-card h1 { font-size: 22px; color: #0a2540; margin: 0 0 4px; font-weight: 700; }
      .sbg-auth-card .sbg-auth-sub { color: #6b7687; font-size: 13px; margin-bottom: 22px; }
      .sbg-auth-tabs { display: flex; gap: 4px; background: #edeff3; border-radius: 6px; padding: 3px; margin-bottom: 18px; }
      .sbg-auth-tabs button { flex: 1; padding: 8px; border: 0; background: transparent; cursor: pointer; border-radius: 4px; font-weight: 600; color: #6b7687; font-size: 13px; }
      .sbg-auth-tabs button.active { background: #fff; color: #0a2540; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
      .sbg-auth-card label { display: block; font-size: 12px; font-weight: 600; color: #2d3a4d; margin: 12px 0 5px; text-transform: uppercase; letter-spacing: 0.04em; }
      .sbg-auth-card input { width: 100%; padding: 10px 12px; border: 1px solid #dbdfe5; border-radius: 4px; font-size: 14px; font-family: inherit; }
      .sbg-auth-card input:focus { outline: none; border-color: #c8322b; box-shadow: 0 0 0 3px rgba(200,50,43,0.12); }
      .sbg-auth-submit { width: 100%; margin-top: 18px; padding: 11px; background: #c8322b; color: #fff; border: 0; border-radius: 4px; font-weight: 700; font-size: 14px; cursor: pointer; letter-spacing: 0.02em; }
      .sbg-auth-submit:hover { background: #a82621; }
      .sbg-auth-submit:disabled { opacity: 0.5; cursor: wait; }
      .sbg-auth-error { color: #c8322b; font-size: 13px; margin-top: 12px; min-height: 16px; }
      .sbg-auth-hint  { color: #6b7687; font-size: 12px; margin-top: 14px; line-height: 1.5; }
      .sbg-auth-card form.hidden { display: none; }
    `;
    const style = document.createElement('style');
    style.id = 'sbg-auth-styles';
    style.textContent = css;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'sbg-auth-overlay';
    overlay.innerHTML = `
      <div class="sbg-auth-card">
        <h1>SBG Tracker</h1>
        <div class="sbg-auth-sub">Sign in to continue</div>
        <div class="sbg-auth-tabs">
          <button type="button" data-tab="login" class="active">Sign in</button>
          <button type="button" data-tab="signup" id="sbg-signup-tab">Create account</button>
        </div>
        <form id="sbg-login-form">
          <label>Email</label>
          <input type="email" name="email" required autocomplete="username">
          <label>Password</label>
          <input type="password" name="password" required autocomplete="current-password">
          <button type="submit" class="sbg-auth-submit">Sign in</button>
          <div class="sbg-auth-error" id="sbg-login-error"></div>
        </form>
        <form id="sbg-signup-form" class="hidden">
          <label>Name</label>
          <input type="text" name="name" autocomplete="name">
          <label>Email</label>
          <input type="email" name="email" required autocomplete="email">
          <label>Password (min 8 chars)</label>
          <input type="password" name="password" required minlength="8" autocomplete="new-password">
          <button type="submit" class="sbg-auth-submit">Create account</button>
          <div class="sbg-auth-error" id="sbg-signup-error"></div>
          <div class="sbg-auth-hint" id="sbg-first-admin-hint"></div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  function show() { document.getElementById('sbg-auth-overlay').classList.remove('hidden'); }
  function hide() { document.getElementById('sbg-auth-overlay').classList.add('hidden'); }

  function wireTabs() {
    const buttons = document.querySelectorAll('.sbg-auth-tabs button');
    const loginForm = document.getElementById('sbg-login-form');
    const signupForm = document.getElementById('sbg-signup-form');
    buttons.forEach(b => b.addEventListener('click', () => {
      buttons.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      if (b.dataset.tab === 'login') {
        loginForm.classList.remove('hidden'); signupForm.classList.add('hidden');
      } else {
        loginForm.classList.add('hidden'); signupForm.classList.remove('hidden');
      }
    }));
  }

  async function handleLogin(e) {
    e.preventDefault();
    const errEl = document.getElementById('sbg-login-error');
    errEl.textContent = '';
    const fd = new FormData(e.target);
    const submit = e.target.querySelector('button[type=submit]');
    submit.disabled = true;
    try {
      const r = await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'login failed');
      auth.setSession(data);
      hide();
      // Re-trigger the app's state load now that we're authed.
      if (typeof loadState === 'function') loadState();
      if (typeof syncStateFromServer === 'function') syncStateFromServer().then(() => typeof render === 'function' && render());
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  }

  async function handleSignup(e) {
    e.preventDefault();
    const errEl = document.getElementById('sbg-signup-error');
    errEl.textContent = '';
    const fd = new FormData(e.target);
    const submit = e.target.querySelector('button[type=submit]');
    submit.disabled = true;
    try {
      const r = await fetch(BASE + '/api/auth/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: fd.get('email'), password: fd.get('password'), name: fd.get('name')
        })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'signup failed');
      auth.setSession(data);
      hide();
      if (typeof loadState === 'function') loadState();
      if (typeof syncStateFromServer === 'function') syncStateFromServer().then(() => typeof render === 'function' && render());
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  }

  async function refreshConfig() {
    try {
      const r = await fetch(BASE + '/api/auth/config');
      if (!r.ok) return;
      const cfg = await r.json();
      const tab = document.getElementById('sbg-signup-tab');
      const hint = document.getElementById('sbg-first-admin-hint');
      if (!cfg.signupEnabled) {
        tab.style.display = 'none';
      }
      if (cfg.isFirstUser) {
        hint.textContent = 'You are the first user — your account will be the admin.';
      } else {
        hint.textContent = '';
      }
    } catch (e) { /* ignore */ }
  }

  async function checkSession() {
    if (!auth.token) { show(); return; }
    try {
      const r = await fetch(BASE + '/api/auth/me', { headers: { 'Authorization': 'Bearer ' + auth.token } });
      if (!r.ok) { auth.clearSession(); show(); return; }
      const { user } = await r.json();
      auth.user = user;
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      hide();
    } catch (e) {
      // Backend unreachable -- if we have a cached user, let the app boot in degraded mode.
      // The app's own offline fallback (localStorage) will take over.
      if (!auth.user) show();
      else hide();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    injectOverlay();
    wireTabs();
    document.getElementById('sbg-login-form').addEventListener('submit', handleLogin);
    document.getElementById('sbg-signup-form').addEventListener('submit', handleSignup);
    refreshConfig();
    checkSession();
  });
})();
