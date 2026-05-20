// auth.js — magic-link auth gate + header signed-in indicator.

import { initSupabase, getSupabase, setSession, getCurrentUser } from './db.js';

const LOGIN_HTML = `
  <div class="login-card">
    <div class="login-mark">Okos / <span>Proposal Generator</span></div>
    <h1 class="login-title">Sign in to Proposal Generator</h1>
    <p class="login-sub">Enter your email and we'll send you a magic link.</p>
    <form class="login-form" id="loginForm">
      <input type="email" id="loginEmail" placeholder="you@company.com" autocomplete="email" required>
      <button class="btn btn-primary" id="loginSubmit" type="submit" style="width:100%;justify-content:center;">
        Continue
      </button>
      <div class="login-error" id="loginError"></div>
    </form>
    <div class="login-sent" id="loginSent" style="display:none;">
      Check your inbox — we sent a sign-in link to <strong id="loginSentEmail"></strong>.
    </div>
  </div>
`;

let _onSignedInCb = null;
let _onSignedOutCb = null;

export async function startAuth({ onSignedIn, onSignedOut }) {
  _onSignedInCb = onSignedIn;
  _onSignedOutCb = onSignedOut;

  initSupabase();
  ensureLoginOverlay();
  attachLoginHandlers();

  const supabase = getSupabase();

  // Initial session check
  const { data } = await supabase.auth.getSession();
  applySession(data.session);

  // Listen for changes (magic-link redirect, sign-out, refresh)
  supabase.auth.onAuthStateChange((_event, session) => applySession(session));
}

function applySession(session) {
  setSession(session);
  if (session) {
    setBodyState('app');
    renderHeaderUser();
    _onSignedInCb?.(session.user);
  } else {
    resetLoginForm();
    setBodyState('login');
    renderHeaderUser();
    _onSignedOutCb?.();
  }
}

function setBodyState(state) {
  document.body.classList.remove('app-state-login', 'app-state-app', 'app-state-history', 'app-state-loading');
  document.body.classList.add(`app-state-${state}`);
}

function ensureLoginOverlay() {
  if (document.getElementById('loginOverlay')) return;
  const div = document.createElement('div');
  div.id = 'loginOverlay';
  div.className = 'login-overlay';
  div.innerHTML = LOGIN_HTML;
  document.body.appendChild(div);
}

function attachLoginHandlers() {
  const form = document.getElementById('loginForm');
  if (!form || form.dataset.bound) return;
  form.dataset.bound = '1';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailEl = document.getElementById('loginEmail');
    const submit = document.getElementById('loginSubmit');
    const errEl = document.getElementById('loginError');
    const email = emailEl.value.trim();
    if (!email) return;
    errEl.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Sending…';
    try {
      const { error } = await getSupabase().auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin + window.location.pathname },
      });
      if (error) throw error;
      document.getElementById('loginSentEmail').textContent = email;
      document.getElementById('loginForm').style.display = 'none';
      document.getElementById('loginSent').style.display = 'block';
    } catch (err) {
      // Friendly copy when Pattern A (invite-only) blocks an uninvited email.
      const msg = String(err?.message || '');
      const friendly = /signups? not allowed|user not allowed/i.test(msg)
        ? "This email isn't on the access list. Ask your admin to invite you."
        : (err?.message || 'Could not send sign-in link.');
      errEl.textContent = friendly;
      submit.disabled = false;
      submit.textContent = 'Continue';
    }
  });
}

function resetLoginForm() {
  const form = document.getElementById('loginForm');
  const sent = document.getElementById('loginSent');
  if (form) form.style.display = '';
  if (sent) sent.style.display = 'none';
  const submit = document.getElementById('loginSubmit');
  if (submit) { submit.disabled = false; submit.textContent = 'Send magic link'; }
  const errEl = document.getElementById('loginError');
  if (errEl) errEl.textContent = '';
}

function renderHeaderUser() {
  const slot = document.getElementById('headerUserSlot');
  if (!slot) return;
  const user = getCurrentUser();
  if (!user) {
    slot.innerHTML = '';
    return;
  }
  slot.innerHTML = `
    <span class="user-email" title="${escapeAttr(user.email)}">${escapeText(user.email)}</span>
    <button class="user-signout" id="userSignout" type="button">Sign out</button>
  `;
  slot.querySelector('#userSignout').addEventListener('click', async () => {
    await getSupabase().auth.signOut();
  });
}

function escapeText(s) { return String(s ?? '').replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])); }
function escapeAttr(s) { return escapeText(s).replace(/"/g, '&quot;'); }
