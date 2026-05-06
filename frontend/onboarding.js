// All user-visible strings here flow through window.t() (see /static/i18n.js).
// Keep static-HTML strings synced with the data-i18n attributes in onboarding.html.

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  step: 1,
  providers: [],
  selectedProvider: null,
  accounts: [],     // populated from /api/setup/accounts
};

// ── Provider hints + service domains ─────────────────────────────────────────
// Email + password placeholders are pulled from the i18n table by provider type
// so they translate alongside the rest of the UI.
function providerHint(type) {
  const t = String(type || 'imap').toLowerCase();
  return {
    email:    window.t(`provider.${t}.email_ph`)    || window.t('provider.imap.email_ph'),
    password: window.t(`provider.${t}.password_ph`) || window.t('provider.imap.password_ph'),
  };
}

// Map provider type → public domain whose favicon we display. Same logic as
// settings.js so the wizard and the settings modal use identical logos.
const SERVICE_DOMAINS = {
  gmail:    'google.com',
  outlook:  'outlook.com',
  yahoo:    'yahoo.com',
  proton:   'proton.me',
  orange:   'orange.fr',
  ovh:      'ovhcloud.com',
  icloud:   'icloud.com',
  free:     'free.fr',
};

function providerLogoHtml(provider) {
  const type = String(provider?.type || '').toLowerCase();
  const domain = SERVICE_DOMAINS[type];
  const fallback = `<i data-lucide="mail"></i>`;
  if (!domain) return fallback;
  const src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
  return `<img src="${src}" alt=""
            loading="lazy"
            onload="if(this.naturalWidth<=16)this.replaceWith(Object.assign(document.createElement('i'),{outerHTML:'<i data-lucide=&quot;mail&quot;></i>'}))"
            onerror="this.outerHTML='<i data-lucide=&quot;mail&quot;></i>';if(window.lucide)window.lucide.createIcons();">`;
}

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

// ── API helpers ──────────────────────────────────────────────────────────────
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  let payload = null;
  try { payload = await r.json(); } catch { /* empty body */ }
  if (!r.ok) {
    const msg = payload?.detail || payload?.error || r.statusText;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return payload;
}

// ── UI helpers ───────────────────────────────────────────────────────────────
function toast(message, type = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast show ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3500);
}

function goToStep(n) {
  for (let i = 1; i <= 4; i++) {
    document.getElementById(`step-${i}`).classList.toggle('hidden', i !== n);
    const dot = document.getElementById(`dot-${i}`);
    dot.classList.remove('active', 'done');
    if (i < n) dot.classList.add('done');
    else if (i === n) dot.classList.add('active');
  }
  for (let i = 1; i <= 3; i++) {
    document.getElementById(`line-${i}`).classList.toggle('done', i < n);
  }
  state.step = n;
  window.scrollTo(0, 0);

  if (n === 2) refreshAccountsList();
  if (n === 4) finalizeSetup();
}

function setBusy(btnId, busy, label) {
  const b = document.getElementById(btnId);
  if (!b) return;
  if (busy) {
    b.dataset._label = b.innerHTML;
    b.innerHTML = `<span class="spinner"></span> ${label || window.t('ob.busy.working')}`;
    b.disabled = true;
  } else {
    if (b.dataset._label) b.innerHTML = b.dataset._label;
    b.disabled = false;
  }
}

// ── Step 1 — OpenAI ──────────────────────────────────────────────────────────
async function saveOpenAIAndNext() {
  const key = document.getElementById('openai-key').value.trim();
  const model = document.getElementById('openai-model').value;
  if (!key) {
    toast(window.t('ob.toast.openai_required'), 'err');
    return;
  }
  try {
    await api('POST', '/api/setup/openai', { api_key: key, model });
    goToStep(2);
  } catch (e) {
    toast(window.t('ob.toast.error', { error: e.message }), 'err');
  }
}

// ── Step 2 — Accounts ────────────────────────────────────────────────────────
// Returns the localised display name for a provider, falling back to
// whatever the backend sent if no override is registered.
function providerDisplayName(p) {
  const k = `provider.${p.id}.name`;
  const localised = window.t(k);
  return localised && localised !== k ? localised : p.name;
}

async function loadProviders() {
  state.providers = await api('GET', '/api/setup/providers');
  const grid = document.getElementById('provider-grid');
  grid.innerHTML = state.providers.map(p => `
    <button type="button" class="provider-card" data-id="${escapeAttr(p.id)}" onclick="selectProvider('${escapeAttr(p.id)}')">
      <span class="provider-logo">${providerLogoHtml(p)}</span>
      <span class="provider-name">${escapeHtml(providerDisplayName(p))}</span>
    </button>
  `).join('');
  refreshIcons();
}

function selectProvider(id) {
  const p = state.providers.find(x => x.id === id);
  if (!p) return;
  state.selectedProvider = p;
  document.querySelectorAll('.provider-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  document.getElementById('acc-host').value = p.imap_host;
  document.getElementById('acc-port').value = p.imap_port;
  document.getElementById('acc-ssl').checked = p.ssl;
  document.getElementById('acc-starttls').checked = p.starttls;
  document.getElementById('acc-verify').checked = p.verify_ssl;

  // Concrete email + password placeholders for THIS provider so the user
  // sees the right kind of credential to paste. Pulled from the i18n table.
  const hint = providerHint(p.type);
  document.getElementById('acc-email').placeholder = hint.email;
  document.getElementById('acc-password').placeholder = hint.password;

  // Quick deep-link to the provider's app-password page (Gmail, Yahoo,
  // iCloud, …). Hidden when the provider doesn't expose one.
  const aLink = document.getElementById('app-pwd-link');
  if (p.app_password_url) {
    aLink.href = p.app_password_url;
    aLink.classList.remove('hidden');
  } else {
    aLink.classList.add('hidden');
    aLink.href = '#';
  }

  // Help banner — we override the backend's help string with our localized
  // version (keyed on provider type). The backend's help_url is reused as-is
  // because URLs are language-agnostic (or English-only by default).
  const help = document.getElementById('provider-help');
  const helpText = window.t(`provider.${p.type}.help`);
  if (helpText && helpText !== `provider.${p.type}.help`) {
    help.classList.remove('hidden');
    const link = p.help_url
      ? ` <a href="${p.help_url}" target="_blank" rel="noopener">${escapeHtml(window.t('ob.help.aide_officielle'))}</a>`
      : '';
    help.innerHTML = helpText + link;
  } else {
    help.classList.add('hidden');
  }
  if (!document.getElementById('acc-name').value) {
    document.getElementById('acc-name').value = providerDisplayName(p);
  }
  document.getElementById('test-result').innerHTML = '';
}

function readAccountForm() {
  const email = document.getElementById('acc-email').value.trim();
  return {
    name: document.getElementById('acc-name').value.trim() || email,
    type: state.selectedProvider?.type || 'imap',
    email,
    imap_host: document.getElementById('acc-host').value.trim(),
    imap_port: parseInt(document.getElementById('acc-port').value, 10) || 993,
    username: email,
    password: document.getElementById('acc-password').value,
    ssl: document.getElementById('acc-ssl').checked,
    starttls: document.getElementById('acc-starttls').checked,
    verify_ssl: document.getElementById('acc-verify').checked,
    enabled: true,
  };
}

function validateAccount(acc) {
  if (!acc.email || !acc.email.includes('@')) return window.t('ob.toast.invalid_email');
  if (!acc.imap_host) return window.t('ob.toast.host_required');
  if (!acc.password) return window.t('ob.toast.password_required');
  return null;
}

async function testConnection() {
  const acc = readAccountForm();
  const err = validateAccount(acc);
  if (err) { toast(err, 'err'); return; }
  setBusy('btn-test', true, window.t('ob.busy.testing'));
  document.getElementById('test-result').innerHTML = '';
  try {
    const r = await api('POST', '/api/setup/accounts/test', acc);
    if (r.ok) {
      const msg = r.mailbox_count
        ? window.t('ob.test.ok_count', { count: r.mailbox_count })
        : window.t('ob.test.ok') + '.';
      document.getElementById('test-result').innerHTML = `<div class="test-ok">${escapeHtml(msg)}</div>`;
    } else {
      document.getElementById('test-result').innerHTML =
        `<div class="test-err">${window.t('ob.test.err_prefix')} ${escapeHtml(r.error)}<div class="text-xs mt-1" style="color: var(--muted);">${escapeHtml(r.detail || '')}</div></div>`;
    }
  } catch (e) {
    document.getElementById('test-result').innerHTML =
      `<div class="test-err">${window.t('ob.test.err_prefix')} ${escapeHtml(window.t('ob.toast.error', { error: e.message }))}</div>`;
  } finally {
    setBusy('btn-test', false);
  }
}

async function addAccount() {
  const acc = readAccountForm();
  const err = validateAccount(acc);
  if (err) { toast(err, 'err'); return; }
  // The backend now runs an IMAP login right after writing config.yaml,
  // so the response carries `test: { ok, error, detail }`. Communicate
  // that wait to the user — IMAP login on a misconfigured host can take
  // up to 15 s to time out.
  setBusy('btn-add-acc', true, window.t('ob.busy.adding'));
  try {
    const resp = await api('POST', '/api/setup/accounts', acc);
    const t = resp?.test;
    const resultEl = document.getElementById('test-result');
    if (t && t.ok === false) {
      // Save succeeded, test failed — keep the form filled in so the
      // user can fix the bad field (typo in password / wrong port).
      // Account stays in the list with a warning.
      const msg = `${t.error || 'Test échoué'}${t.detail ? ' — ' + t.detail : ''}`;
      toast(`⚠ ${acc.email} ajoutée mais test KO : ${msg}`, 'err');
      if (resultEl) {
        resultEl.innerHTML = `<div class="test-err">${window.t('ob.test.err_prefix')} ${escapeHtml(t.error)}<div class="text-xs mt-1" style="color: var(--muted);">${escapeHtml(t.detail || '')}</div></div>`;
      }
    } else if (t && t.ok) {
      toast(`✓ ${window.t('ob.toast.added', { email: acc.email })}`, 'ok');
      document.getElementById('acc-name').value = '';
      document.getElementById('acc-email').value = '';
      document.getElementById('acc-password').value = '';
      if (resultEl) resultEl.innerHTML = '';
    } else {
      // No test field (legacy / unexpected) — fall back to old behaviour.
      toast(window.t('ob.toast.added', { email: acc.email }), 'ok');
      document.getElementById('acc-name').value = '';
      document.getElementById('acc-email').value = '';
      document.getElementById('acc-password').value = '';
      if (resultEl) resultEl.innerHTML = '';
    }
    await refreshAccountsList();
  } catch (e) {
    toast(window.t('ob.toast.error', { error: e.message }), 'err');
  } finally {
    setBusy('btn-add-acc', false);
  }
}

async function refreshAccountsList() {
  state.accounts = await api('GET', '/api/setup/accounts');
  const list = document.getElementById('accounts-list');
  if (!state.accounts.length) {
    list.innerHTML = `<div style="color: var(--muted);" class="text-sm italic">${escapeHtml(window.t('ob.step2.no_accounts'))}</div>`;
    document.getElementById('btn-next-accounts').disabled = true;
    return;
  }
  const removeLabel = window.t('ob.step2.remove');
  list.innerHTML = state.accounts.map(a => {
    const provider = state.providers.find(p => p.type === (a.type || 'imap'))
      || { type: a.type || 'imap' };
    return `
      <div class="acc-row">
        <span class="provider-logo">${providerLogoHtml(provider)}</span>
        <div class="flex-1 min-w-0">
          <div class="font-medium text-sm flex items-center gap-2">
            ${escapeHtml(a.name)}
            <span class="badge">${escapeHtml(a.type || 'imap')}</span>
          </div>
          <div class="text-xs font-mono" style="color: var(--muted);">${escapeHtml(a.email)}</div>
        </div>
        <button class="btn btn-ghost" style="color: var(--danger); border-color: color-mix(in oklab, var(--danger) 40%, transparent);"
                onclick="removeAccount('${escapeAttr(a.email)}')">
          ${escapeHtml(removeLabel)}
        </button>
      </div>
    `;
  }).join('');
  document.getElementById('btn-next-accounts').disabled = false;
  refreshIcons();
}

async function removeAccount(email) {
  if (!confirm(window.t('ob.confirm.remove', { email }))) return;
  try {
    await api('DELETE', `/api/setup/accounts/${encodeURIComponent(email)}`);
    await refreshAccountsList();
  } catch (e) {
    toast(window.t('ob.toast.error', { error: e.message }), 'err');
  }
}

// ── Step 3 — ntfy ────────────────────────────────────────────────────────────
function generateTopic() {
  const rand = Math.random().toString(36).slice(2, 8);
  document.getElementById('ntfy-topic').value = `lullmail-${rand}`;
}

async function skipNtfyAndFinish() {
  try {
    await api('POST', '/api/setup/ntfy', {
      enabled: false, server: 'https://ntfy.sh', topic: '', min_importance: 7,
    });
    goToStep(4);
  } catch (e) { toast(window.t('ob.toast.error', { error: e.message }), 'err'); }
}

async function saveNtfyAndFinish() {
  const enabled = document.getElementById('ntfy-enabled').checked;
  const topic = document.getElementById('ntfy-topic').value.trim();
  const min = parseInt(document.getElementById('ntfy-min').value, 10);
  if (enabled && !topic) {
    toast(window.t('ob.toast.topic_required'), 'err');
    return;
  }
  try {
    await api('POST', '/api/setup/ntfy', {
      enabled, server: 'https://ntfy.sh', topic, min_importance: min,
    });
    goToStep(4);
  } catch (e) { toast(window.t('ob.toast.error', { error: e.message }), 'err'); }
}

// ── Step 4 — Finalize ────────────────────────────────────────────────────────
async function finalizeSetup() {
  const target = document.getElementById('finalize-status');
  target.innerHTML = `<span class="spinner" style="color: var(--accent);"></span> ${escapeHtml(window.t('ob.step4.starting'))}`;
  try {
    await api('POST', '/api/setup/finalize');
    target.innerHTML = `<span class="test-ok">${escapeHtml(window.t('ob.step4.ok'))}</span>`;
  } catch (e) {
    target.innerHTML = `<span class="test-err">${window.t('ob.test.err_prefix')} ${escapeHtml(e.message)}</span>
      <div class="text-xs mt-2" style="color: var(--muted);">
        ${escapeHtml(window.t('ob.step4.fail_hint'))}
      </div>`;
  }
}

// ── Misc ─────────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function escapeAttr(s) {
  return String(s ?? '').replace(/['"\\]/g, '\\$&');
}

document.getElementById('ntfy-enabled').addEventListener('change', e => {
  document.getElementById('ntfy-fields').classList.toggle('hidden', !e.target.checked);
  document.getElementById('ntfy-toggle-row')?.classList.toggle('is-on', e.target.checked);
});

// ── Model custom dropdown ─────────────────────────────────────────────────────
(function initModelDrop() {
  const wrap  = document.getElementById('openai-model-wrap');
  const btn   = document.getElementById('openai-model-btn');
  const menu  = document.getElementById('openai-model-drop');
  const input = document.getElementById('openai-model');
  const label = document.getElementById('openai-model-label');
  if (!wrap || !menu) return;

  document.body.appendChild(menu);

  function positionMenu() {
    const r = btn.getBoundingClientRect();
    menu.style.top   = (r.bottom + 4) + 'px';
    menu.style.left  = r.left + 'px';
    menu.style.width = r.width + 'px';
  }

  function openMenu() {
    positionMenu();
    menu.style.display = 'flex';
    wrap.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    menu.style.display = 'none';
    wrap.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.style.display === 'flex' ? closeMenu() : openMenu();
  });

  menu.querySelectorAll('.ob-drop-opt').forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      input.value = opt.dataset.val;
      // The button's collapsed label is the localised long form. data-label-key
      // points at the i18n key — fall back to the option's own text content.
      const key = opt.dataset.labelKey;
      label.textContent = key ? window.t(key) : (opt.textContent || opt.dataset.val).trim();
      menu.querySelectorAll('.ob-drop-opt').forEach(o => {
        o.classList.toggle('active', o === opt);
        o.setAttribute('aria-selected', o === opt);
      });
      closeMenu();
    });
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target) && !menu.contains(e.target)) closeMenu();
  });
})();

// On load
refreshIcons();
loadProviders().catch(e => toast(window.t('ob.toast.providers_failed', { error: e.message }), 'err'));
