// SPDX-License-Identifier: GPL-3.0-or-later
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
  // Provider logos come from OUR backend (/api/brand-logo — fetched from
  // the provider's own domain, cached on disk), so the wizard never talks
  // to a third-party favicon service. The glyph renders underneath; the
  // logo stacks on top and is dropped on 404 by the delegated error
  // handler below, letting the glyph show through.
  const glyph = `<i data-lucide="mail"></i>`;
  const domain = SERVICE_DOMAINS[(provider?.type || '').toLowerCase()] || '';
  if (!domain) return glyph;
  // Eager: eight favicons in a wizard grid — nothing to lazy-load.
  return glyph + `<img class="provider-logo-img" src="/api/brand-logo/${encodeURIComponent(domain)}"
    alt="" decoding="async" referrerpolicy="no-referrer">`;
}

// `error` doesn't bubble — capture phase catches every broken provider
// logo with one listener (this page doesn't load app.js, which does the
// same for the mailbox).
document.addEventListener('error', (e) => {
  const el = e.target;
  if (el && el.tagName === 'IMG' && el.classList
      && el.classList.contains('provider-logo-img')) {
    el.remove();
  }
}, true);

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
// Delegates to the shared RailToast component (loaded via /static/rail-toast.js).
// Rendered in detached mode (centered bottom) since the onboarding wizard
// has no rail to anchor to.
function toast(message, type = 'ok') {
  const variant = type === 'err' ? 'error' : 'success';
  if (window.railToast && typeof window.railToast.show === 'function') {
    return window.railToast.show({
      variant,
      message,
      duration: variant === 'error' ? 4500 : 3500,
      detached: true,
    });
  }
  // RailToast not yet loaded — fall back to a console hint.
  console.warn('[onboarding] RailToast not ready:', message);
  return null;
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

// "Utiliser sans IA" — persist an empty key so the rest of the wizard
// proceeds in no-AI mode. The user can still flip AI on later from
// Settings → Intelligence artificielle.
async function skipOpenAIAndNext() {
  const model = document.getElementById('openai-model').value || 'gpt-4o-mini';
  try {
    await api('POST', '/api/setup/openai', { api_key: '', model });
    goToStep(2);
  } catch (e) {
    toast(window.t('ob.toast.error', { error: e.message }), 'err');
  }
}

// ── Step 1 — Local LLM ───────────────────────────────────────────────────────
// Hero panel in Step 1. Fetches hardware + model catalog at boot, picks the
// recommended analyzer + drafter for the detected tier, and exposes a single
// "Download and activate" button that:
//   1. streams the analyzer GGUF over SSE → progress bar
//   2. streams the drafter GGUF over SSE → progress bar
//   3. POSTs /api/llm/activate → flips config to provider=local + restarts services
//   4. navigates to Step 2.
//
// When both GGUFs are already on disk (rerun of onboarding, dev machine), we
// skip directly to the activate step. The button label adapts to reflect that.

const local = {
  hw: null,
  models: [],     // catalog with `downloaded` state
  analyzer: null, // chosen analyzer model id
  drafter: null,  // chosen drafter model id
  inFlight: false,
};

// Pick the best model for a role given the detected tier. Logic mirrors
// settings.js _defaultModelId: prefer exact `recommended_for_tier == tier`,
// then fall back to the smallest model of that role (so a low-RAM machine
// never auto-selects a model heavier than its tier).
const _TIER_RANK = { light: 1, medium: 2, heavy: 3 };
function _pickModelForTier(models, role, tier) {
  const ofRole = models.filter(m => m.role === role);
  if (!ofRole.length) return null;
  const exact = ofRole.find(m => m.recommended_for_tier === tier);
  if (exact) return exact.id;
  // No exact match — pick the heaviest model that still fits in the tier
  // (i.e. recommended_for_tier <= detected tier). Falls back to smallest.
  const maxRank = _TIER_RANK[tier] || 2;
  const fitting = ofRole
    .filter(m => (_TIER_RANK[m.recommended_for_tier] || 2) <= maxRank)
    .sort((a, b) => b.size_bytes - a.size_bytes);
  if (fitting.length) return fitting[0].id;
  return [...ofRole].sort((a, b) => a.size_bytes - b.size_bytes)[0].id;
}

function _humanGb(bytes) {
  return (bytes / (1024 ** 3)).toFixed(1);
}

function _renderHwBanner() {
  const ramEl  = document.getElementById('ob-hw-ram-text');
  const tierEl = document.getElementById('ob-hw-tier-text');
  const arrow  = document.querySelector('#ob-hw-banner .hw-arrow');
  if (!ramEl) return;
  if (!local.hw) {
    ramEl.textContent = window.t('ob.step1.local.hw_error');
    if (tierEl) tierEl.textContent = '';
    if (arrow) arrow.style.display = 'none';
    return;
  }
  const tierLabel = window.t(`set.llm.tier_${local.hw.recommended_tier}`) || local.hw.recommended_tier;
  ramEl.textContent  = window.t('ob.step1.local.hw_ram',  { ram: local.hw.ram_gb });
  if (tierEl) tierEl.textContent = window.t('ob.step1.local.hw_tier', { tier: tierLabel });
  if (arrow) arrow.style.display = '';
  refreshIcons();
}

function _renderModelPills() {
  const wrap = document.getElementById('ob-models-pills');
  if (!wrap) return;
  const a = local.models.find(m => m.id === local.analyzer);
  const d = local.models.find(m => m.id === local.drafter);
  // Onboarding pill: role label + size + downloaded check. We deliberately
  // hide the technical model name (e.g. "Phi-3.5-mini-instruct-Q4_K_M") —
  // it means nothing to a typical user. The choice of which model is being
  // downloaded happens automatically based on the detected tier; power
  // users can swap models later from Settings → IA.
  const renderOne = (model, roleLabelKey, icon) => {
    if (!model) return '';
    const sizeGb = _humanGb(model.size_bytes);
    const doneCls = model.downloaded ? 'is-done' : '';
    return `
      <div class="role-pill ${doneCls}" data-model-id="${escapeAttr(model.id)}">
        <span class="pill-ic"><i data-lucide="${icon}"></i></span>
        <span class="pill-role">${escapeHtml(window.t(roleLabelKey))}</span>
        <span class="pill-size">${model.downloaded ? '✓ ' : ''}${sizeGb} GB</span>
      </div>`;
  };
  wrap.innerHTML = renderOne(a, 'ob.step1.local.analyzer_role', 'search')
                 + renderOne(d, 'ob.step1.local.drafter_role', 'pen-line');
  refreshIcons();
}

function _renderTotalSize() {
  const a = local.models.find(m => m.id === local.analyzer);
  const d = local.models.find(m => m.id === local.drafter);
  const allDownloaded = a && d && a.downloaded && d.downloaded;
  const totalBytes = (a?.size_bytes || 0) + (d?.size_bytes || 0);
  const remaining = (a && !a.downloaded ? a.size_bytes : 0)
                  + (d && !d.downloaded ? d.size_bytes : 0);
  const totalEl = document.getElementById('ob-total-size');
  const etaEl = document.getElementById('ob-eta-hint');
  if (totalEl) {
    totalEl.textContent = allDownloaded
      ? window.t('ob.step1.local.already_present')
      : window.t('ob.step1.local.total_size', { size: _humanGb(remaining) });
  }
  if (etaEl) {
    if (allDownloaded) {
      etaEl.textContent = '';
    } else {
      // 100 Mb/s fibre ≈ 12.5 MB/s. Round to nearest minute, min 1.
      const seconds = remaining / (12.5 * 1024 * 1024);
      const minutes = Math.max(1, Math.round(seconds / 60));
      etaEl.textContent = window.t('ob.step1.local.eta_hint', { minutes });
    }
  }
  // Button label changes based on whether we still need to download.
  const lbl = document.getElementById('ob-local-btn-label');
  const ic = document.querySelector('#ob-local-btn i');
  if (lbl) {
    lbl.textContent = allDownloaded
      ? window.t('ob.step1.local.activate_only_btn')
      : window.t('ob.step1.local.download_btn');
  }
  if (ic) ic.setAttribute('data-lucide', allDownloaded ? 'zap' : 'download');
  refreshIcons();
}

async function loadLocalLLM() {
  // We fire hardware + catalog in parallel. Hardware is cheap (psutil call)
  // but the catalog touches the filesystem to check which GGUFs are on disk
  // — both finish well under 100 ms in practice.
  try {
    const [hw, models] = await Promise.all([
      api('GET', '/api/llm/hardware'),
      api('GET', '/api/llm/models'),
    ]);
    local.hw = hw;
    local.models = models;
    local.analyzer = _pickModelForTier(models, 'analyzer', hw.recommended_tier);
    local.drafter = _pickModelForTier(models, 'drafter', hw.recommended_tier);
    _renderHwBanner();
    _renderModelPills();
    _renderTotalSize();
    // Enable the action button now that we have a recommendation.
    const btn = document.getElementById('ob-local-btn');
    if (btn) btn.disabled = false;
  } catch (e) {
    // Hardware/catalog fetch failed — surface a non-blocking error and let
    // the user fall back to OpenAI or skip-AI. We don't disable the button
    // forever because the local providers might be temporarily unavailable
    // (e.g. llama_cpp not yet installed on a dev rebuild).
    _renderHwBanner();
    const err = document.getElementById('ob-local-error');
    if (err) {
      err.classList.remove('hidden');
      err.innerHTML = `<i data-lucide="alert-triangle" style="width:15px;height:15px;flex-shrink:0;margin-top:1px"></i>
        <span>${escapeHtml(window.t('set.llm.load_error', { msg: e.message }))}</span>`;
      refreshIcons();
    }
  }
}

// SSE stream wrapper. fetch() exposes a ReadableStream we decode line-by-line.
// We don't use EventSource because POST is required (sse_starlette quirk +
// our endpoint shape). On done, calls `onDone(payload)`. On error or HTTP !ok,
// calls `onError(message)`.
async function _streamDownload(modelId, { onProgress, onDone, onError }) {
  let resp;
  try {
    resp = await fetch(`/api/llm/models/${encodeURIComponent(modelId)}/download`, {
      method: 'POST',
    });
  } catch (e) {
    onError(e.message);
    return;
  }
  if (!resp.ok || !resp.body) {
    onError(`HTTP ${resp.status}`);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const evt = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      // Each SSE event is `data: {json}` — parse and dispatch.
      const dataLine = evt.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) continue;
      let payload;
      try {
        payload = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (payload.error) { onError(payload.error); return; }
      if (payload.done) { onDone(payload); return; }
      onProgress(payload);
    }
  }
  // Stream closed without a `done` marker. Treat as error.
  onError('stream closed unexpectedly');
}

async function downloadAndActivateLocal() {
  if (local.inFlight) return;
  if (!local.analyzer || !local.drafter) {
    toast(window.t('set.llm.load_error', { msg: 'no model selected' }), 'err');
    return;
  }
  local.inFlight = true;

  const btn = document.getElementById('ob-local-btn');
  const progress = document.getElementById('ob-local-progress');
  const errEl = document.getElementById('ob-local-error');
  const fill = document.getElementById('ob-dl-fill');
  const labelEl = document.getElementById('ob-dl-label');
  const statsEl = document.getElementById('ob-dl-stats');

  if (errEl) errEl.classList.add('hidden');
  if (btn) btn.disabled = true;

  // Build the queue: only models not yet on disk.
  const queue = [];
  for (const id of [local.analyzer, local.drafter]) {
    const meta = local.models.find(m => m.id === id);
    if (meta && !meta.downloaded) queue.push(meta);
  }

  const setBtn = (key, busy = true) => {
    const lbl = document.getElementById('ob-local-btn-label');
    if (lbl) lbl.innerHTML = busy
      ? `<span class="spinner"></span> ${window.t(key)}`
      : window.t(key);
    if (btn) btn.disabled = busy;
  };

  // Download each missing model sequentially. Two simultaneous SSE streams
  // would saturate the host's CPU during SHA verification and the analyzer
  // would block the drafter anyway (single-threaded chunked reader).
  for (let i = 0; i < queue.length; i++) {
    const meta = queue[i];
    if (progress) progress.classList.remove('hidden');
    if (labelEl) labelEl.textContent = window.t('ob.step1.local.downloading', {
      current: i + 1, total: queue.length, model: meta.name,
    });
    if (fill) fill.style.width = '0%';
    if (statsEl) statsEl.textContent = '';

    setBtn('ob.step1.local.downloading', true);

    let dlError = null;
    await new Promise(resolve => {
      _streamDownload(meta.id, {
        onProgress: (p) => {
          const pct = Math.max(0, Math.min(1, p.progress || 0));
          if (fill) fill.style.width = `${(pct * 100).toFixed(1)}%`;
          if (statsEl) {
            const speed = p.speed_mbps ? `${p.speed_mbps.toFixed(1)} MB/s` : '';
            const eta = (p.eta_sec !== null && p.eta_sec !== undefined && p.eta_sec >= 0)
              ? `ETA ${Math.max(1, Math.round(p.eta_sec))}s`
              : '';
            statsEl.textContent = `${(pct * 100).toFixed(0)}%  ${speed}  ${eta}`.trim();
          }
        },
        onDone: (p) => {
          if (fill) fill.style.width = '100%';
          meta.downloaded = true;
          resolve();
        },
        onError: (msg) => { dlError = msg; resolve(); },
      });
    });

    if (dlError) {
      local.inFlight = false;
      if (errEl) {
        errEl.classList.remove('hidden');
        errEl.innerHTML = `<i data-lucide="x-circle" style="width:15px;height:15px;flex-shrink:0;margin-top:1px"></i>
          <span>${escapeHtml(window.t('ob.step1.local.dl_failed', { msg: dlError }))}</span>`;
        refreshIcons();
      }
      _renderModelPills();
      _renderTotalSize();
      if (btn) btn.disabled = false;
      return;
    }
  }

  // All models present — activate.
  if (progress) progress.classList.add('hidden');
  setBtn('ob.step1.local.activating', true);
  try {
    await api('POST', '/api/llm/activate', {
      analyzer_model_id: local.analyzer,
      drafter_model_id: local.drafter,
    });
    if (btn) btn.disabled = true;
    setBtn('ob.step1.local.activated', false);
    // Tiny pause so the user sees the "activated" state before transition.
    setTimeout(() => goToStep(2), 450);
  } catch (e) {
    local.inFlight = false;
    if (errEl) {
      errEl.classList.remove('hidden');
      errEl.innerHTML = `<i data-lucide="x-circle" style="width:15px;height:15px;flex-shrink:0;margin-top:1px"></i>
        <span>${escapeHtml(window.t('ob.step1.local.activate_failed', { msg: e.message }))}</span>`;
      refreshIcons();
    }
    setBtn('ob.step1.local.download_btn', false);
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
      document.getElementById('test-result').innerHTML = `<div class="test-ok"><i data-lucide="check-circle-2" style="width:15px;height:15px;flex-shrink:0;margin-top:1px"></i><span>${escapeHtml(msg)}</span></div>`;
    } else {
      document.getElementById('test-result').innerHTML =
        `<div class="test-err"><i data-lucide="x-circle" style="width:15px;height:15px;flex-shrink:0;margin-top:1px"></i><span>${window.t('ob.test.err_prefix')} ${escapeHtml(r.error)}${r.detail ? `<div class="text-xs mt-1">${escapeHtml(r.detail)}</div>` : ''}</span></div>`;
    }
  } catch (e) {
    document.getElementById('test-result').innerHTML =
      `<div class="test-err"><i data-lucide="x-circle" style="width:15px;height:15px;flex-shrink:0;margin-top:1px"></i><span>${window.t('ob.test.err_prefix')} ${escapeHtml(window.t('ob.toast.error', { error: e.message }))}</span></div>`;
  } finally {
    setBusy('btn-test', false);
    if (window.lucide) window.lucide.createIcons();
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

// Step 1 accordion — Local hero and OpenAI section are mutually exclusive,
// with a height + opacity slide animation on open and close. We intercept
// the summary's click event so the native <details> instant snap is
// replaced by our slide. The accordion swap (one closes when the other
// opens) runs the two animations in parallel.
//
// Why JS instead of CSS transitions: animating `height: auto ↔ 0` requires
// `interpolate-size: allow-keywords` which is too recent (Chrome 129+).
// JS measures the natural height and animates a fixed pixel value, which
// works in every browser the app ships in.
(function initStep1Accordion() {
  const localDet  = document.getElementById('ob-local-section');
  const openaiDet = document.getElementById('ob-openai-section');
  if (!localDet || !openaiDet) return;

  const ANIM_MS = 280;
  // Each details' content wrapper. Cached so we don't query on every click.
  const localBody  = localDet.querySelector('.hero-body');
  const openaiBody = openaiDet.querySelector('.ob-openai-body');

  function syncChevron(details, expanded) {
    details.classList.toggle('is-expanded', expanded);
  }
  // Initial sync: HTML has `open` on Local, not on OpenAI.
  syncChevron(localDet, localDet.open);
  syncChevron(openaiDet, openaiDet.open);

  function animateOpen(details, body) {
    if (details.open) { syncChevron(details, true); return; }
    details.open = true;
    syncChevron(details, true);
    if (!body) return;
    // Measure target height, then animate from 0 → that.
    body.style.overflow = 'hidden';
    body.style.height = '0px';
    body.style.opacity = '0';
    // Force reflow so the browser registers the starting state before
    // we change the target, otherwise it would skip the transition.
    void body.offsetHeight;
    body.style.transition = `height ${ANIM_MS}ms cubic-bezier(.4,0,.2,1), opacity ${ANIM_MS - 60}ms ease`;
    body.style.height = body.scrollHeight + 'px';
    body.style.opacity = '1';
    setTimeout(() => {
      body.style.height = '';
      body.style.opacity = '';
      body.style.overflow = '';
      body.style.transition = '';
    }, ANIM_MS + 10);
  }

  function animateClose(details, body) {
    if (!details.open) { syncChevron(details, false); return; }
    syncChevron(details, false);
    if (!body) { details.open = false; return; }
    // Start from the natural height so the transition has a known origin.
    body.style.overflow = 'hidden';
    body.style.height = body.scrollHeight + 'px';
    body.style.opacity = '1';
    void body.offsetHeight;
    body.style.transition = `height ${ANIM_MS}ms cubic-bezier(.4,0,.2,1), opacity ${ANIM_MS - 60}ms ease`;
    body.style.height = '0px';
    body.style.opacity = '0';
    setTimeout(() => {
      details.open = false;
      body.style.height = '';
      body.style.opacity = '';
      body.style.overflow = '';
      body.style.transition = '';
    }, ANIM_MS + 10);
  }

  function bindSummary(details, body, other, otherBody) {
    const summary = details.querySelector(':scope > summary');
    if (!summary) return;
    summary.addEventListener('click', (e) => {
      e.preventDefault();
      if (details.open) {
        animateClose(details, body);
      } else {
        if (other.open) animateClose(other, otherBody);
        animateOpen(details, body);
      }
    });
  }

  bindSummary(localDet,  localBody,  openaiDet, openaiBody);
  bindSummary(openaiDet, openaiBody, localDet,  localBody);
})();

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
// Local LLM is best-effort — if the backend doesn't have llama_cpp installed
// or the endpoint errors, we surface a non-blocking notice and let the user
// fall back to OpenAI or skip.
loadLocalLLM();
