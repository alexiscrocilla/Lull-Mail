// Settings page — mounted as an SPA route inside the main shell.
// Reuses the .dash / .card / .col-N grid system + theme tokens from
// style.css so it visually matches Inbox / Dashboard / Cleanup.

const MASK = '***';

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  let payload = null;
  try { payload = await r.json(); } catch { /* */ }
  if (!r.ok) {
    const msg = payload?.detail || payload?.error || r.statusText;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return payload;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function escapeAttr(s) { return String(s ?? '').replace(/['"\\]/g, '\\$&'); }

// Map an account `type` (and email fallback) to a public domain whose
// favicon we can display via Google's s2 service. Custom-domain mailboxes
// (e.g. you@yourdomain.com hosted on Proton) still get their *service* logo
// instead of their custom-domain favicon, which is what users expect.
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
function serviceLogoHtml(account) {
  const type = String(account?.type || '').toLowerCase();
  const email = String(account?.email || '');
  const at = email.lastIndexOf('@');
  const emailDomain = at >= 0 ? email.slice(at + 1).toLowerCase() : '';
  const domain = SERVICE_DOMAINS[type] || emailDomain;
  if (!domain) return '';
  const src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
  // Hide if Google returns the generic globe (naturalWidth ≤ 16) or 404s.
  return `<img class="set-svc-logo" src="${src}" alt=""
    loading="lazy"
    onload="if(this.naturalWidth<=16)this.style.display='none'"
    onerror="this.style.display='none'">`;
}

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

function setBusy(el, busy, label) {
  if (!el) return;
  if (busy) {
    el.dataset._label = el.innerHTML;
    el.innerHTML = `<span class="set-spinner"></span> ${label || ''}`;
    el.disabled = true;
  } else {
    if (el.dataset._label) el.innerHTML = el.dataset._label;
    el.disabled = false;
  }
}

export async function mountSettings(host, opts = {}) {
  const t = window.t || ((k) => k);
  host.innerHTML = `
    <div class="dash">
      <div class="dash-head">
        <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
          <h1>${t('set.title')}</h1>
        </div>
      </div>

      <div id="set-banner" class="set-banner hidden"></div>

      <div class="dash-grid dash-grid--fill">
        <!-- Accounts -->
        <section class="card col-12">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="at-sign" class="w-4 h-4"></i>${t('set.accounts.title')}
            </span>
            <button class="mb-cta" style="margin:0;padding:7px 12px;font-size:13px" id="btn-add-acc">
              <i data-lucide="plus" class="w-4 h-4"></i><span>${t('set.accounts.add_btn')}</span>
            </button>
          </h3>
          <div id="accounts-list" class="set-list">
            <div class="sub" style="font-style:italic">${t('set.loading')}</div>
          </div>
        </section>

        <!-- OpenAI -->
        <section class="card col-6">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="sparkles" class="w-4 h-4"></i>${t('set.ai.title')}
            </span>
            <label class="set-toggle">
              <input id="ai-enabled" type="checkbox" />
              <span>${t('set.ai.toggle')}</span>
            </label>
          </h3>
          <div id="ai-disabled-msg" class="sub hidden" style="margin-top:8px">
            ${t('set.ai.disabled_msg')}
          </div>
          <div id="ai-fields" style="display:flex;align-items:center;gap:16px;margin-top:10px">
            <div class="set-grid" style="flex:1">
              <label class="set-field">
                <span class="set-label">${t('set.ai.key_label')}</span>
                <input id="openai-key" type="password" class="set-input mono" placeholder="${t('set.ai.key_ph_empty')}" autocomplete="new-password" />
                <span class="set-hint">${t('set.ai.key_hint')}</span>
              </label>
              <label class="set-field">
                <span class="set-label">${t('set.ai.model_label')}</span>
                <input type="hidden" id="openai-model" value="gpt-4o-mini" />
                <div class="set-drop-wrap" id="openai-model-wrap">
                  <button class="set-drop-btn" id="openai-model-btn" type="button" aria-haspopup="listbox" aria-expanded="false">
                    <span id="openai-model-label">gpt-4o-mini</span>
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  <div class="set-drop-menu" id="openai-model-drop" role="listbox">
                    ${['gpt-4o-mini','gpt-4o','gpt-4.1-mini'].map(v => `
                      <div class="acc-select-opt" data-val="${v}" role="option">${v}</div>
                    `).join('')}
                  </div>
                </div>
              </label>
            </div>
            <div class="set-actions" style="margin-top:0;padding-top:0;border-top:none;border-left:1px solid var(--border-2);padding-left:16px;flex-shrink:0">
              <button class="mb-cta set-btn" id="btn-save-openai">${t('set.save')}</button>
            </div>
          </div>
        </section>

        <!-- Notifications -->
        <section class="card col-6">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="bell" class="w-4 h-4"></i>${t('set.notif.title')}
            </span>
            <label class="set-toggle">
              <input id="ntfy-enabled" type="checkbox" />
              <span>${t('set.notif.toggle')}</span>
            </label>
          </h3>
          <div style="display:flex;align-items:center;gap:16px;margin-top:10px">
            <div class="set-grid" style="flex:1">
              <label class="set-field">
                <span class="set-label">${t('set.notif.topic_label')}</span>
                <input id="ntfy-topic" class="set-input mono" placeholder="lullmail-vous-x7k2p" />
                <span class="set-hint">${t('set.notif.topic_hint')}</span>
              </label>
              <label class="set-field">
                <span class="set-label">${t('set.notif.min_label')}</span>
                <input id="ntfy-min" type="number" min="1" max="10" class="set-input" />
                <span class="set-hint">${t('set.notif.min_hint')}</span>
              </label>
            </div>
            <div class="set-actions" style="margin-top:0;padding-top:0;border-top:none;border-left:1px solid var(--border-2);padding-left:16px;flex-shrink:0">
              <button class="mb-cta set-btn" id="btn-save-ntfy">${t('set.save')}</button>
            </div>
          </div>
        </section>

        <!-- General -->
        <section class="card col-6">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="refresh-cw" class="w-4 h-4"></i>${t('set.polling.title')}
            </span>
          </h3>
          <div style="display:flex;align-items:center;gap:16px">
            <div class="set-grid" style="flex:1">
              <label class="set-field">
                <span class="set-label">${t('set.polling.interval_label')}</span>
                <div style="display:flex;align-items:center;gap:8px">
                  <input id="general-interval" type="number" min="1" max="1440" class="set-input" style="max-width:72px" />
                  <span style="color:var(--muted);font-size:13px">minutes</span>
                </div>
                <span class="set-hint">${t('set.polling.interval_hint')}</span>
              </label>
              <div class="set-field">
                <span class="set-label">${t('set.polling.status_label')}</span>
                <div id="set-services" class="set-status">…</div>
              </div>
            </div>
            <div class="set-actions" style="margin-top:0;padding-top:0;border-top:none;border-left:1px solid var(--border-2);padding-left:16px;flex-shrink:0">
              <button class="mb-cta set-btn" id="btn-save-general">${t('set.save')}</button>
            </div>
          </div>
        </section>

        <!-- Storage -->
        <section class="card col-6">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="hard-drive" class="w-4 h-4"></i>${t('set.storage.title')}
            </span>
          </h3>
          <div style="display:flex;align-items:center;gap:16px">
            <div class="set-field" style="flex:1;min-width:0">
              <span class="set-label">${t('set.storage.dir_label')}</span>
              <div id="set-data-dir" class="set-path mono">—</div>
              <span class="set-hint">${t('set.storage.dir_hint')}</span>
            </div>
            <div class="set-actions" style="margin-top:0;padding-top:0;border-top:none;border-left:1px solid var(--border-2);padding-left:16px;flex-shrink:0;flex-direction:column;align-items:stretch">
              <button class="mb-cta set-btn-ghost" id="btn-open-data" type="button">
                <i data-lucide="folder-open" class="w-4 h-4"></i>
                <span>${t('set.storage.open_btn')}</span>
              </button>
              <button class="mb-cta set-btn-danger" id="btn-wipe-data" type="button">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
                <span>${t('set.storage.wipe_btn')}</span>
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- Wipe-data confirmation modal -->
    <div id="wipe-modal" class="set-modal hidden">
      <div class="set-modal-card" style="max-width:460px">
        <div class="set-modal-head">
          <h3 style="display:flex;align-items:center;gap:8px;color:var(--danger)">
            <i data-lucide="alert-triangle" class="w-4 h-4"></i>
            ${t('set.wipe.title')}
          </h3>
          <button class="set-icon-btn" id="wipe-close" aria-label="${t('set.close')}">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>
        <!-- Warning banner -->
        <div style="background:color-mix(in oklab,var(--danger) 10%,transparent);border:1px solid color-mix(in oklab,var(--danger) 28%,transparent);border-radius:10px;padding:12px 14px;display:flex;gap:10px;align-items:flex-start">
          <i data-lucide="triangle-alert" style="width:15px;height:15px;flex-shrink:0;color:var(--danger);margin-top:1px"></i>
          <p style="margin:0;font-size:13px;color:var(--danger);line-height:1.5">
            ${t('set.wipe.warning_html')}
          </p>
        </div>

        <!-- What gets deleted -->
        <div style="display:flex;flex-direction:column;gap:6px;padding:4px 0">
          ${[
            ['key-round',   t('set.wipe.item_key')],
            ['mail',        t('set.wipe.item_accounts')],
            ['sparkles',    t('set.wipe.item_emails')],
            ['paperclip',   t('set.wipe.item_attachments')],
          ].map(([icon, label]) => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--surface-2);border-radius:8px">
            <i data-lucide="${icon}" style="width:14px;height:14px;flex-shrink:0;color:var(--muted)"></i>
            <span style="font-size:13px;color:var(--text)">${label}</span>
          </div>`).join('')}
        </div>

        <!-- Confirm input -->
        <label class="set-field" style="margin-bottom:0">
          <span class="set-label">${t('set.wipe.confirm_label')}</span>
          <input id="wipe-confirm-input" class="set-input mono" placeholder="SUPPRIMER" autocomplete="off" />
        </label>
        <div id="wipe-status" class="set-test-result" style="display:none;margin-top:4px"></div>
        <p class="set-hint" style="margin-top:2px">${t('set.wipe.hint')}</p>

        <div class="set-modal-actions">
          <button class="mb-cta set-btn-ghost" id="wipe-cancel">${t('set.wipe.cancel')}</button>
          <button class="mb-cta set-btn-danger" id="wipe-confirm" disabled>
            <i data-lucide="trash-2" class="w-4 h-4"></i>
            <span>${t('set.wipe.confirm_btn')}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Add / edit account modal -->
    <div id="set-modal" class="set-modal hidden">
      <div class="set-modal-card">
        <div class="set-modal-head">
          <h3 id="m-title">${t('set.modal.add_title')}</h3>
          <button class="set-icon-btn" id="m-close" aria-label="${t('set.close')}">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>

        <div class="set-field">
          <span class="set-label">${t('set.modal.provider_label')}</span>
          <div id="m-providers" class="m-providers"></div>
        </div>

        <div id="m-help" class="set-help hidden"></div>

        <div class="set-grid">
          <label class="set-field">
            <span class="set-label">${t('set.modal.name_label')}</span>
            <input id="m-name" class="set-input" placeholder="${t('set.modal.name_ph')}" />
          </label>
          <label class="set-field">
            <span class="set-label">${t('set.modal.email_label')}</span>
            <input id="m-email" type="email" class="set-input" placeholder="${t('set.modal.email_ph')}" />
          </label>
        </div>

        <label class="set-field">
          <div class="set-label-row">
            <span class="set-label">${t('set.modal.pwd_label')}</span>
            <a id="m-app-pwd-link" class="set-quick-link hidden" target="_blank" rel="noopener" href="#">
              <i data-lucide="external-link" class="w-3 h-3"></i>
              <span>${t('set.modal.app_pwd_link')}</span>
            </a>
          </div>
          <input id="m-password" type="password" class="set-input mono" autocomplete="new-password" placeholder="${t('set.modal.pwd_ph')}" />
        </label>

        <details class="set-advanced">
          <summary>${t('set.modal.advanced')}</summary>
          <div class="set-subhead">${t('set.modal.imap_head')}</div>
          <div class="set-grid set-grid-3">
            <label class="set-field" style="grid-column: span 2">
              <span class="set-label">${t('set.modal.host_label')}</span>
              <input id="m-host" class="set-input" placeholder="${t('set.imap.host_ph')}" />
            </label>
            <label class="set-field">
              <span class="set-label">${t('set.modal.port_label')}</span>
              <input id="m-port" type="number" class="set-input" placeholder="993" />
            </label>
          </div>
          <div class="set-checks">
            <label><input id="m-ssl" type="checkbox" /> SSL</label>
            <label><input id="m-starttls" type="checkbox" /> STARTTLS</label>
            <label><input id="m-verify" type="checkbox" /> ${t('set.modal.verify')}</label>
          </div>
          <div class="set-subhead">${t('set.modal.smtp_head')}</div>
          <div class="set-grid set-grid-3">
            <label class="set-field" style="grid-column: span 2">
              <span class="set-label">${t('set.modal.host_label')}</span>
              <input id="m-smtp-host" class="set-input" placeholder="${t('set.smtp.host_ph')}" />
            </label>
            <label class="set-field">
              <span class="set-label">${t('set.modal.port_label')}</span>
              <input id="m-smtp-port" type="number" class="set-input" placeholder="587" />
            </label>
          </div>
          <div class="set-checks">
            <label><input id="m-smtp-ssl" type="checkbox" /> SMTPS</label>
            <label><input id="m-smtp-starttls" type="checkbox" /> STARTTLS</label>
          </div>
        </details>

        <div id="m-test-result" class="set-test-result"></div>

        <div class="set-modal-actions">
          <button class="mb-cta set-btn-ghost" id="m-cancel">${t('set.modal.cancel')}</button>
          <button class="mb-cta set-btn-ghost" id="m-test">${t('set.modal.test')}</button>
          <button class="mb-cta set-btn" id="m-add">${t('set.modal.add')}</button>
        </div>
      </div>
    </div>
  `;

  injectStyles();
  refreshIcons();

  const els = {
    banner:   host.querySelector('#set-banner'),
    dataDir:  host.querySelector('#set-data-dir'),
    services: host.querySelector('#set-services'),
    accList:  host.querySelector('#accounts-list'),
    openaiKey:   host.querySelector('#openai-key'),
    openaiModel: host.querySelector('#openai-model'),
    aiEnabled:   host.querySelector('#ai-enabled'),
    aiFields:    host.querySelector('#ai-fields'),
    aiDisabledMsg: host.querySelector('#ai-disabled-msg'),
    ntfyEnabled: host.querySelector('#ntfy-enabled'),
    ntfyTopic:   host.querySelector('#ntfy-topic'),
    ntfyMin:     host.querySelector('#ntfy-min'),
    genInterval: host.querySelector('#general-interval'),
    btnAdd:    host.querySelector('#btn-add-acc'),
    btnSaveOA: host.querySelector('#btn-save-openai'),
    btnSaveNt: host.querySelector('#btn-save-ntfy'),
    btnSaveGn: host.querySelector('#btn-save-general'),
    modal:    host.querySelector('#set-modal'),
    mProviders: host.querySelector('#m-providers'),
    mHelp:    host.querySelector('#m-help'),
    mName:    host.querySelector('#m-name'),
    mEmail:   host.querySelector('#m-email'),
    mPwd:     host.querySelector('#m-password'),
    mHost:    host.querySelector('#m-host'),
    mPort:    host.querySelector('#m-port'),
    mSsl:     host.querySelector('#m-ssl'),
    mStartTls:host.querySelector('#m-starttls'),
    mVerify:  host.querySelector('#m-verify'),
    mSmtpHost:    host.querySelector('#m-smtp-host'),
    mSmtpPort:    host.querySelector('#m-smtp-port'),
    mSmtpSsl:     host.querySelector('#m-smtp-ssl'),
    mSmtpStartTls:host.querySelector('#m-smtp-starttls'),
    mTestRes: host.querySelector('#m-test-result'),
    mClose:   host.querySelector('#m-close'),
    mCancel:  host.querySelector('#m-cancel'),
    mTest:    host.querySelector('#m-test'),
    mAdd:     host.querySelector('#m-add'),
    mTitle:   host.querySelector('#m-title'),
    mAppPwdLink: host.querySelector('#m-app-pwd-link'),
  };

  const state = { providers: [], config: null, status: null };

  // ── Model custom dropdown ──────────────────────────────────
  (function initModelDrop() {
    const wrap  = host.querySelector('#openai-model-wrap');
    const btn   = host.querySelector('#openai-model-btn');
    const menu  = host.querySelector('#openai-model-drop');
    const input = host.querySelector('#openai-model');
    const label = host.querySelector('#openai-model-label');
    if (!wrap) return;

    // Move menu to body so no ancestor overflow/transform clips it
    document.body.appendChild(menu);

    function syncLabel(val) {
      label.textContent = val || input.value;
      menu.querySelectorAll('.acc-select-opt').forEach(opt => {
        const active = opt.dataset.val === (val || input.value);
        opt.classList.toggle('active', active);
        opt.setAttribute('aria-selected', active);
      });
    }

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

    menu.querySelectorAll('.acc-select-opt').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        input.value = opt.dataset.val;
        closeMenu();
        syncLabel(opt.dataset.val);
      });
    });

    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target) && !menu.contains(e.target)) closeMenu();
    });

    // Expose sync so renderConfig can call it after setting input.value
    wrap._sync = syncLabel;
  })();

  // ── Data ──
  async function loadAll() {
    const [status, config, providers] = await Promise.all([
      api('GET', '/api/setup/status'),
      api('GET', '/api/setup/config'),
      api('GET', '/api/setup/providers'),
    ]);
    state.status = status;
    state.config = config;
    state.providers = providers;
    render();
  }

  function render() {
    els.dataDir.textContent = state.status.data_dir;

    // Status banner
    if (!state.status.configured) {
      els.banner.classList.remove('hidden');
      els.banner.dataset.tone = 'warn';
      els.banner.innerHTML = `<i data-lucide="alert-triangle" class="w-4 h-4"></i>
        <span>${t('set.banner.not_ready')}</span>`;
    } else if (!state.status.services_running) {
      els.banner.classList.remove('hidden');
      els.banner.dataset.tone = 'warn';
      els.banner.innerHTML = `<i data-lucide="alert-triangle" class="w-4 h-4"></i>
        <span>${t('set.banner.paused')}</span>
        <button class="set-banner-btn" id="set-restart">${t('set.restart_btn')}</button>`;
      els.banner.querySelector('#set-restart').onclick = restart;
    } else {
      els.banner.classList.add('hidden');
    }

    // Services status indicator
    if (state.status.services_running) {
      els.services.innerHTML = `<span class="set-dot ok"></span>${t('set.status.running')}`;
    } else if (state.status.configured) {
      els.services.innerHTML = `<span class="set-dot warn"></span>${t('set.status.paused')}`;
    } else {
      els.services.innerHTML = `<span class="set-dot warn"></span>${t('set.status.not_ready')}`;
    }

    // Accounts
    const accounts = state.config.accounts || [];
    if (!accounts.length) {
      els.accList.innerHTML = `<div class="sub" style="font-style:italic">${t('set.accounts.empty')}</div>`;
    } else {
      els.accList.innerHTML = accounts.map(a => {
        const isOn = a.enabled !== false;
        return `
        <div class="set-acc-row${isOn ? '' : ' is-disabled'}">
          <span class="set-svc">${serviceLogoHtml(a)}</span>
          <div class="set-acc-info">
            <div class="set-acc-name">
              ${escapeHtml(a.name || a.email)}
              ${isOn ? '' : `<span class="set-badge warn">${t('set.acc.paused_badge')}</span>`}
            </div>
            <div class="set-acc-sub">${escapeHtml(a.email)}</div>
          </div>
          <div class="set-acc-actions">
            <button class="set-switch ${isOn ? 'is-on' : 'is-off'}" data-act="toggle-enabled" data-email="${escapeAttr(a.email)}" role="switch" aria-checked="${isOn}" title="${isOn ? t('set.acc.pause') : t('set.acc.resume')}">
              <span class="set-switch-track"><span class="set-switch-thumb"></span></span>
            </button>
            ${testStatusIconHtml(a)}
            <button class="set-icon-btn" data-act="edit" data-email="${escapeAttr(a.email)}" title="${t('set.acc.edit')}">
              <i data-lucide="pencil" class="w-4 h-4"></i>
            </button>
            <button class="set-icon-btn danger" data-act="remove" data-email="${escapeAttr(a.email)}" title="${t('set.acc.remove')}">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        </div>
        `;
      }).join('');
      els.accList.querySelectorAll('[data-act]').forEach(btn => {
        const act = btn.dataset.act;
        const email = btn.dataset.email;
        btn.addEventListener('click', () => {
          if (act === 'test')           return testExisting(email);
          if (act === 'edit')           return openModalForEdit(email);
          if (act === 'remove')         return removeAccount(email);
          if (act === 'toggle-enabled') return toggleAccountEnabled(email);
        });
      });
    }

    // OpenAI
    const oa = state.config.openai || {};
    // The backend returns "***" when a key is set, "" when AI is off.
    // Use that to drive the section's disabled/enabled visual state.
    const aiOn = !!oa.api_key;
    els.aiEnabled.checked = aiOn;
    els.aiFields.classList.toggle('hidden', !aiOn);
    els.aiDisabledMsg.classList.toggle('hidden', aiOn);
    els.openaiKey.value = '';
    els.openaiKey.placeholder = aiOn ? t('set.ai.key_ph_set') : t('set.ai.key_ph_empty');
    els.openaiModel.value = oa.model || 'gpt-4o-mini';
    const _mWrap = host.querySelector('#openai-model-wrap');
    if (_mWrap && _mWrap._sync) _mWrap._sync(els.openaiModel.value);

    // ntfy
    const ntfy = state.config.ntfy || {};
    els.ntfyEnabled.checked = !!ntfy.topic;
    els.ntfyTopic.value = ntfy.topic || '';
    els.ntfyMin.value = ntfy.min_importance || 7;

    // General
    els.genInterval.value = (state.config.polling || {}).interval_minutes || 10;

    // Modal provider tiles — visual grid with logos. Click to select.
    // Falls back to a generic envelope icon when the provider has no
    // mappable logo (the "Autre" tile).
    els.mProviders.innerHTML = state.providers.map(p => {
      const logo = serviceLogoHtml({ type: p.type, email: '' });
      const fallback = `<span class="m-prov-glyph"><i data-lucide="mail" class="w-5 h-5"></i></span>`;
      return `
        <button type="button" class="m-prov-tile" data-id="${escapeAttr(p.id)}" data-type="${escapeAttr(p.type)}">
          <span class="set-svc">${logo || fallback}</span>
          <span class="m-prov-name">${escapeHtml(p.name)}</span>
        </button>`;
    }).join('');
    els.mProviders.querySelectorAll('.m-prov-tile').forEach(btn => {
      btn.addEventListener('click', () => selectProvider(btn.dataset.id));
    });

    refreshIcons();
  }

  // ── Saves ──
  async function saveOpenAI() {
    const key = els.openaiKey.value.trim();
    const model = els.openaiModel.value;
    const enabled = els.aiEnabled.checked;
    // Three cases drive the api_key payload:
    //   • toggle off   → "" (backend purges keyring, no-AI mode)
    //   • toggle on, new key typed → that key
    //   • toggle on, field empty   → MASK (keep existing)
    let apiKey;
    if (!enabled) {
      apiKey = '';
    } else if (key) {
      apiKey = key;
    } else {
      apiKey = MASK;
    }
    setBusy(els.btnSaveOA, true, t('set.busy.saving'));
    try {
      await api('POST', '/api/setup/openai', { api_key: apiKey, model });
      window.toast?.(enabled ? t('set.toast.ai_on') : t('set.toast.ai_off'));
      els.openaiKey.value = '';
      // Notify the rest of the SPA (mailbox / dashboard) so they re-render
      // their AI-conditional UI without a hard reload.
      window.dispatchEvent(new CustomEvent('ai-config-changed', { detail: { enabled } }));
      await loadAll();
    } catch (e) { window.toast?.(t('set.toast.error', { msg: e.message }), 3500); }
    finally { setBusy(els.btnSaveOA, false); }
  }

  async function saveNtfy() {
    const enabled = els.ntfyEnabled.checked;
    const topic = els.ntfyTopic.value.trim();
    const min = parseInt(els.ntfyMin.value, 10) || 7;
    setBusy(els.btnSaveNt, true, t('set.busy.saving'));
    try {
      await api('POST', '/api/setup/ntfy', {
        enabled, server: 'https://ntfy.sh', topic, min_importance: min,
      });
      window.toast?.(t('set.toast.saved'));
      await loadAll();
    } catch (e) { window.toast?.(t('set.toast.error', { msg: e.message }), 3500); }
    finally { setBusy(els.btnSaveNt, false); }
  }

  async function saveGeneral() {
    const polling = parseInt(els.genInterval.value, 10) || 10;
    setBusy(els.btnSaveGn, true, t('set.busy.saving'));
    try {
      await api('POST', '/api/setup/general', { polling_interval_minutes: polling });
      window.toast?.(t('set.toast.saved'));
      await loadAll();
    } catch (e) { window.toast?.(t('set.toast.error', { msg: e.message }), 3500); }
    finally { setBusy(els.btnSaveGn, false); }
  }

  async function restart() {
    try {
      await api('POST', '/api/setup/finalize');
      window.toast?.(t('set.toast.restarted'));
      await loadAll();
    } catch (e) { window.toast?.(t('set.toast.error', { msg: e.message }), 3500); }
  }

  // ── Account modal ──
  // Per-provider hints used to make the form fields self-explanatory.
  // Keyed on provider.type (matches setup_api.py PROVIDERS).
  // Delegates to existing provider.* i18n keys.
  const PROVIDER_HINTS = {
    gmail:   { email: t('provider.gmail.email_ph'),   password: t('provider.gmail.password_ph') },
    outlook: { email: t('provider.outlook.email_ph'), password: t('provider.outlook.password_ph') },
    yahoo:   { email: t('provider.yahoo.email_ph'),   password: t('provider.yahoo.password_ph') },
    proton:  { email: t('provider.proton.email_ph'),  password: t('provider.proton.password_ph') },
    orange:  { email: t('provider.orange.email_ph'),  password: t('provider.orange.password_ph') },
    ovh:     { email: t('provider.ovh.email_ph'),     password: t('provider.ovh.password_ph') },
    icloud:  { email: t('provider.icloud.email_ph'),  password: t('provider.icloud.password_ph') },
    free:    { email: t('provider.free.email_ph'),    password: t('provider.free.password_ph') },
    imap:    { email: t('provider.imap.email_ph'),    password: t('provider.imap.password_ph') },
  };

  function openModal() {
    state.editingEmail = null;
    els.mTitle.textContent = t('set.modal.add_title');
    els.mAdd.textContent = t('set.modal.add');
    els.mEmail.disabled = false;
    els.modal.classList.remove('hidden');
    els.mName.value = '';
    els.mEmail.value = '';
    els.mPwd.value = '';
    els.mPwd.placeholder = t('set.modal.pwd_ph');
    els.mTestRes.innerHTML = '';
    state.selectedProviderId = null;
    if (state.providers.length) {
      selectProvider(state.providers[0].id);
    }
    els.mEmail.focus();
  }

  // Open the same modal pre-filled with an existing account so the user
  // can update credentials, IMAP settings or the friendly name. The
  // password field stays empty + uses a "leave blank to keep" placeholder
  // since the backend masks the real password as "***".
  function openModalForEdit(email) {
    const acc = (state.config.accounts || []).find(a => a.email.toLowerCase() === email.toLowerCase());
    if (!acc) return;
    openModal();  // reset everything first
    state.editingEmail = acc.email;
    els.mTitle.textContent = t('set.modal.edit_title');
    els.mAdd.textContent = t('set.modal.save');
    els.mEmail.disabled = true;  // email is the primary key — can't change it

    // Pre-select the matching provider tile (by type)
    const matchingProvider = state.providers.find(p => p.type === acc.type) || state.providers.find(p => p.id === 'custom');
    if (matchingProvider) selectProvider(matchingProvider.id);

    // Override pre-filled values with the actual account
    els.mName.value = acc.name || '';
    els.mEmail.value = acc.email || '';
    els.mPwd.value = '';
    els.mPwd.placeholder = t('set.modal.pwd_ph_edit');
    els.mHost.value = acc.imap_host || '';
    els.mPort.value = acc.imap_port || 993;
    els.mSsl.checked = !!acc.ssl;
    els.mStartTls.checked = !!acc.starttls;
    els.mVerify.checked = !!acc.verify_ssl;
    // SMTP — empty when no per-account override is set; the backend
    // falls back to the provider preset for `type` at send time.
    els.mSmtpHost.value = acc.smtp_host || '';
    els.mSmtpPort.value = acc.smtp_port ? acc.smtp_port : '';
    els.mSmtpSsl.checked = !!acc.smtp_ssl;
    els.mSmtpStartTls.checked = acc.smtp_starttls !== false;

    els.mName.focus();
    els.mName.select();
  }

  function closeModal() { els.modal.classList.add('hidden'); }

  function selectProvider(id) {
    const p = state.providers.find(x => x.id === id);
    if (!p) return;
    state.selectedProviderId = id;

    // Highlight the active tile
    els.mProviders.querySelectorAll('.m-prov-tile').forEach(tile => {
      tile.classList.toggle('is-active', tile.dataset.id === id);
    });

    // Pre-fill the technical fields (still editable in the Avancé section)
    els.mHost.value = p.imap_host;
    els.mPort.value = p.imap_port;
    els.mSsl.checked = p.ssl;
    els.mStartTls.checked = p.starttls;
    els.mVerify.checked = p.verify_ssl;
    // Mirror SMTP defaults from the preset. If the user only edits IMAP
    // these will be saved as-is (matching the provider's standard SMTP
    // endpoint); blank means "let the backend resolve at send time".
    els.mSmtpHost.value = p.smtp_host || '';
    els.mSmtpPort.value = p.smtp_port || '';
    els.mSmtpSsl.checked = !!p.smtp_ssl;
    els.mSmtpStartTls.checked = p.smtp_starttls !== false;

    // Dynamic placeholders so users see a concrete example for THIS provider
    const hint = PROVIDER_HINTS[p.type] || PROVIDER_HINTS.imap;
    els.mEmail.placeholder = hint.email;
    els.mPwd.placeholder = hint.password;

    // Quick deep-link to the provider's app-password creation page (Gmail,
    // Yahoo, iCloud, …). Hidden when the provider doesn't expose one.
    if (els.mAppPwdLink) {
      if (p.app_password_url) {
        els.mAppPwdLink.href = p.app_password_url;
        els.mAppPwdLink.classList.remove('hidden');
      } else {
        els.mAppPwdLink.classList.add('hidden');
        els.mAppPwdLink.href = '#';
      }
    }

    // Helpful guidance from the backend (where to find the password, etc.)
    if (p.help) {
      const link = p.help_url
        ? ` <a href="${p.help_url}" target="_blank" rel="noopener">Aide officielle ↗</a>`
        : '';
      els.mHelp.innerHTML = p.help + link;
      els.mHelp.classList.remove('hidden');
    } else {
      els.mHelp.classList.add('hidden');
    }
  }

  function readModal() {
    const p = state.providers.find(x => x.id === state.selectedProviderId);
    const email = els.mEmail.value.trim();
    const editing = !!state.editingEmail;
    // In edit mode, an empty password means "keep the existing one" —
    // the backend understands the MASK sentinel for that.
    const pwd = els.mPwd.value;
    return {
      name: els.mName.value.trim() || email,
      type: p?.type || 'imap',
      email,
      imap_host: els.mHost.value.trim(),
      imap_port: parseInt(els.mPort.value, 10) || 993,
      username: email,
      password: editing && !pwd ? MASK : pwd,
      ssl: els.mSsl.checked,
      starttls: els.mStartTls.checked,
      verify_ssl: els.mVerify.checked,
      // The "Boîte active" toggle now lives on each row in the
      // accounts list, not in this modal. Editing fields here must
      // not silently flip the enabled state — preserve whatever is
      // currently saved in config.
      enabled: editing
        ? ((state.config.accounts || []).find(a => (a.email || '').toLowerCase() === (state.editingEmail || '').toLowerCase())?.enabled !== false)
        : true,
      smtp_host: els.mSmtpHost.value.trim(),
      smtp_port: parseInt(els.mSmtpPort.value, 10) || 0,
      smtp_ssl: els.mSmtpSsl.checked,
      smtp_starttls: els.mSmtpStartTls.checked,
    };
  }

  function validateModal(acc) {
    if (!acc.email || !acc.email.includes('@')) return t('set.err.invalid_email');
    if (!acc.imap_host) return t('set.err.no_host');
    // In edit mode, MASK in `password` means "keep what's saved" — that's fine.
    if (!acc.password) return t('set.err.no_pwd');
    return null;
  }

  async function modalTest() {
    const acc = readModal();
    const err = validateModal(acc);
    if (err) { els.mTestRes.innerHTML = `<div class="set-err"><i data-lucide="x-circle" style="width:15px;height:15px;flex-shrink:0;margin-top:1px"></i><span>${err}</span></div>`; return; }
    setBusy(els.mTest, true, t('set.busy.testing'));
    els.mTestRes.innerHTML = '';
    try {
      const r = await api('POST', '/api/setup/accounts/test', acc);
      els.mTestRes.innerHTML = r.ok
        ? `<div class="set-ok"><i data-lucide="check-circle-2" style="width:15px;height:15px;flex-shrink:0;margin-top:1px"></i><span>${r.mailbox_count ? t('set.test.ok_count', { count: r.mailbox_count }) : t('set.test.ok')}</span></div>`
        : `<div class="set-err"><i data-lucide="x-circle" style="width:15px;height:15px;flex-shrink:0;margin-top:1px"></i><span>${escapeHtml(r.error)}${r.detail ? `<div class="sub">${escapeHtml(r.detail)}</div>` : ''}</span></div>`;
    } catch (e) {
      els.mTestRes.innerHTML = `<div class="set-err"><i data-lucide="x-circle" style="width:15px;height:15px;flex-shrink:0;margin-top:1px"></i><span>${escapeHtml(e.message)}</span></div>`;
    } finally { setBusy(els.mTest, false); if (window.lucide) window.lucide.createIcons(); }
  }

  async function modalAdd() {
    const acc = readModal();
    const err = validateModal(acc);
    if (err) { els.mTestRes.innerHTML = `<div class="set-err"><i data-lucide="x-circle" style="width:15px;height:15px;flex-shrink:0;margin-top:1px"></i><span>${err}</span></div>`; return; }
    const editing = !!state.editingEmail;
    // The save endpoint runs an IMAP login on the backend AFTER writing
    // config.yaml, so the response can take a few seconds. Communicate
    // that to the user — "Enregistrement & test…" instead of "Ajout…".
    setBusy(els.mAdd, true, editing ? t('set.busy.editing') : t('set.busy.adding'));
    try {
      let resp;
      if (editing) {
        resp = await api('PUT', `/api/setup/accounts/${encodeURIComponent(state.editingEmail)}`, acc);
      } else {
        resp = await api('POST', '/api/setup/accounts', acc);
      }
      const testRes = resp?.test;
      if (testRes && testRes.ok === false) {
        // Save succeeded but test failed — surface the failure clearly.
        const msg = `${testRes.error || t('set.test.failed')}${testRes.detail ? ' — ' + testRes.detail : ''}`;
        window.toast?.(t('set.toast.saved_test_fail', { email: acc.email, msg }), 6000);
      } else if (testRes && testRes.ok) {
        const verb = editing ? t('set.verb.updated') : t('set.verb.added');
        window.toast?.(t('set.toast.saved_ok', { email: acc.email, verb }), 3000);
      } else {
        const verb = editing ? t('set.verb.updated') : t('set.verb.added');
        window.toast?.(t('set.toast.saved_simple', { email: acc.email, verb }));
      }
      closeModal();
      await loadAll();
      // Restart so polling picks up the new credentials / account changes.
      try { await api('POST', '/api/setup/finalize'); await loadAll(); } catch { /* tolerated */ }
    } catch (e) {
      els.mTestRes.innerHTML = `<div class="set-err"><i data-lucide="x-circle" style="width:15px;height:15px;flex-shrink:0;margin-top:1px"></i><span>${escapeHtml(e.message)}</span></div>`;
    } finally { setBusy(els.mAdd, false); }
  }

  // ── Test-status badge ─────────────────────────────────────────────
  // Each account row shows a single icon that summarises the latest
  // auto-test outcome:
  //   • Spinner → currently testing
  //   • Green check → last test ok
  //   • Red cross → last test failed (tooltip = error message)
  //   • Grey question mark → never tested (only happens if the auto-test
  //     on save was skipped because of TLS lock or similar)
  // Click triggers a fresh test through /api/setup/accounts/test —
  // the password is sent as MASK so the backend looks it up.
  function testStatusIconHtml(a) {
    const tested = !!a.last_test_at;
    const ok = tested && !a.last_test_error;
    const failed = tested && !!a.last_test_error;
    let icon, klass, title;
    if (failed) {
      icon = 'x-circle';
      klass = 'set-icon-btn test-status test-fail';
      title = t('set.test_status.fail', { error: a.last_test_error });
    } else if (ok) {
      icon = 'check-circle-2';
      klass = 'set-icon-btn test-status test-ok';
      title = t('set.test_status.ok', { date: a.last_test_at });
    } else {
      icon = 'help-circle';
      klass = 'set-icon-btn test-status test-unknown';
      title = t('set.test_status.unknown');
    }
    return `<button class="${klass}" data-act="test" data-email="${escapeAttr(a.email)}" title="${escapeAttr(title)}">
      <i data-lucide="${icon}" class="w-4 h-4"></i>
    </button>`;
  }

  // Replace the icon inline (no full re-render) so the click target
  // doesn't disappear while the test is running.
  function setRowTestState(email, kind, message) {
    const btn = host.querySelector(`.test-status[data-email="${cssEscape(email)}"]`);
    if (!btn) return;
    btn.classList.remove('test-ok', 'test-fail', 'test-unknown', 'test-busy');
    let icon = 'help-circle';
    if (kind === 'busy') { icon = 'loader-2'; btn.classList.add('test-busy'); }
    else if (kind === 'ok') { icon = 'check-circle-2'; btn.classList.add('test-ok'); }
    else if (kind === 'fail') { icon = 'x-circle'; btn.classList.add('test-fail'); }
    else { btn.classList.add('test-unknown'); }
    btn.setAttribute('title', message || '');
    btn.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4"></i>`;
    window.lucide?.createIcons({ el: btn });
  }

  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, c =>
      '\\' + c.charCodeAt(0).toString(16).padStart(2, '0') + ' '
    );
  }

  async function testExisting(email) {
    const acc = (state.config.accounts || []).find(a => a.email.toLowerCase() === email.toLowerCase());
    if (!acc) return;
    setRowTestState(email, 'busy', t('set.test_status.busy'));
    try {
      // MASK in the password tells the backend to use the saved value.
      const payload = { ...acc, password: MASK };
      const r = await api('POST', '/api/setup/accounts/test', payload);
      if (r.ok) {
        setRowTestState(email, 'ok', t('set.test_status.ok', { date: new Date().toLocaleDateString() }));
        window.toast?.(`✓ ${email} fonctionne`, 2500);
      } else {
        setRowTestState(email, 'fail', t('set.test_status.fail', { error: `${r.error || ''}${r.detail ? ' — ' + r.detail : ''}` }));
        window.toast?.(`✗ ${email} — ${r.error}`, 4000);
      }
    } catch (e) {
      setRowTestState(email, 'fail', e.message);
      window.toast?.(t('set.toast.error', { msg: e.message }), 3500);
    }
  }

  async function removeAccount(email) {
    if (!confirm(t('set.confirm.remove', { email }))) return;
    try {
      await api('DELETE', `/api/setup/accounts/${encodeURIComponent(email)}`);
      window.toast?.(t('set.toast.removed', { email }));
      await loadAll();
    } catch (e) { window.toast?.(t('set.toast.error', { msg: e.message }), 3500); }
  }

  // Flip the per-account `enabled` flag. The PUT endpoint requires a
  // full AccountPayload, so we replay the whole stored row with MASK
  // for the password (the backend keeps the keyring sentinel when it
  // sees MASK). The scheduler only fetches accounts where enabled=true,
  // so this gates polling on/off without touching credentials.
  async function toggleAccountEnabled(email) {
    const acc = (state.config.accounts || []).find(a => (a.email || '').toLowerCase() === email.toLowerCase());
    if (!acc) return;
    const next = acc.enabled === false; // currently off → turn on, and vice versa
    const payload = {
      name: acc.name || acc.email,
      type: acc.type || 'imap',
      email: acc.email,
      imap_host: acc.imap_host || '',
      imap_port: acc.imap_port || 993,
      username: acc.username || acc.email,
      password: MASK,
      ssl: !!acc.ssl,
      starttls: !!acc.starttls,
      verify_ssl: !!acc.verify_ssl,
      enabled: next,
      smtp_host: acc.smtp_host || '',
      smtp_port: acc.smtp_port || 0,
      smtp_ssl: !!acc.smtp_ssl,
      smtp_starttls: acc.smtp_starttls !== false,
    };
    try {
      await api('PUT', `/api/setup/accounts/${encodeURIComponent(email)}`, payload);
      window.toast?.(next ? t('set.toast.enabled', { email }) : t('set.toast.disabled', { email }));
      await loadAll();
    } catch (e) { window.toast?.(t('set.toast.error', { msg: e.message }), 3500); }
  }

  // ── Wire events ──
  els.btnAdd.addEventListener('click', openModal);
  els.btnSaveOA.addEventListener('click', saveOpenAI);
  // Live toggle: reveal/hide the key+model form as the user flips the
  // switch. The actual disable/enable is committed only on Enregistrer.
  els.aiEnabled.addEventListener('change', () => {
    const on = els.aiEnabled.checked;
    els.aiFields.classList.toggle('hidden', !on);
    els.aiDisabledMsg.classList.toggle('hidden', on);
  });
  els.btnSaveNt.addEventListener('click', saveNtfy);
  els.btnSaveGn.addEventListener('click', saveGeneral);
  host.querySelector('#btn-open-data')?.addEventListener('click', async () => {
    try {
      await api('POST', '/api/setup/open-data-dir');
    } catch (e) { window.toast?.(t('set.toast.error', { msg: e.message }), 3500); }
  });

  // ── Wipe data flow ─────────────────────────────────────────────────────────
  // Type-to-confirm pattern: the destructive button only enables when the
  // user types the literal "SUPPRIMER" — same word the backend requires
  // in the body, so a misclick can't trigger it.
  const wipeModal = host.querySelector('#wipe-modal');
  const wipeInput = host.querySelector('#wipe-confirm-input');
  const wipeBtn   = host.querySelector('#wipe-confirm');
  const wipeStatus = host.querySelector('#wipe-status');

  function setWipeStatus(html) {
    wipeStatus.innerHTML = html;
    wipeStatus.style.display = html ? 'block' : 'none';
  }

  function openWipeModal() {
    wipeInput.value = '';
    wipeBtn.disabled = true;
    setWipeStatus('');
    wipeModal.classList.remove('hidden');
    setTimeout(() => wipeInput.focus(), 50);
  }
  function closeWipeModal() { wipeModal.classList.add('hidden'); }

  host.querySelector('#btn-wipe-data')?.addEventListener('click', openWipeModal);
  host.querySelector('#wipe-close')?.addEventListener('click', closeWipeModal);
  host.querySelector('#wipe-cancel')?.addEventListener('click', closeWipeModal);
  wipeModal?.addEventListener('click', e => { if (e.target === wipeModal) closeWipeModal(); });
  wipeInput?.addEventListener('input', () => {
    wipeBtn.disabled = wipeInput.value.trim() !== 'SUPPRIMER';
  });
  wipeBtn?.addEventListener('click', async () => {
    setBusy(wipeBtn, true, t('set.busy.deleting'));
    setWipeStatus('');
    try {
      const r = await api('POST', '/api/setup/wipe', { confirm: 'SUPPRIMER' });
      if (r.failed && r.failed.length) {
        setWipeStatus(`<span style="color:var(--warning)">${t('set.wipe.partial_fail', { files: r.failed.map(escapeHtml).join(', ') })}</span>`);
      }
      // Hard reload so the FastAPI redirect rule sends us to /onboarding.
      window.location.href = '/';
    } catch (e) {
      setWipeStatus(`<span style="color:var(--danger)">✗ ${escapeHtml(e.message)}</span>`);
      setBusy(wipeBtn, false);
    }
  });
  // Provider tiles wire their own click handlers in render()
  els.mClose.addEventListener('click', closeModal);
  els.mCancel.addEventListener('click', closeModal);
  els.mTest.addEventListener('click', modalTest);
  els.mAdd.addEventListener('click', modalAdd);
  els.modal.addEventListener('click', e => { if (e.target === els.modal) closeModal(); });

  await loadAll().catch(e => window.toast?.(t('set.toast.load_failed', { msg: e.message }), 3500));

  // Cleanup callback for the router.
  return () => { /* no timers / listeners outside the host element */ };
}


// ── One-time stylesheet injection ───────────────────────────────────────────
function injectStyles() {
  const _old = document.getElementById('settings-css');
  if (_old) _old.remove();
  const css = `
    .set-banner {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px; margin-bottom: 12px;
      border: 1px solid var(--border); border-radius: 12px;
      background: var(--surface); color: var(--text); font-size: 13px;
    }
    .set-banner[data-tone="warn"] {
      border-left: 4px solid var(--warning);
    }
    .set-banner.hidden { display: none; }
    .set-banner-btn {
      margin-left: auto; padding: 4px 10px;
      border: 1px solid var(--border); background: var(--surface-2);
      border-radius: 8px; color: var(--text); font-size: 12px;
      font-weight: 600; cursor: pointer;
    }
    .set-banner-btn:hover { background: var(--accent-soft); border-color: var(--accent); }

    /* Fills the height of its parent card (which itself stretches via the
       dash-grid--fill row template). Long mailbox lists scroll inside the
       card — scrollbar hidden, like the rest of the app. */
    .set-list {
      display: flex; flex-direction: column; gap: 8px;
      flex: 1; min-height: 0; overflow-y: auto;
      scrollbar-width: none;
    }
    .set-list::-webkit-scrollbar { width: 0; height: 0; display: none; }
    .set-acc-row {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 14px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    .set-svc {
      width: 32px; height: 32px;
      flex-shrink: 0;
      border-radius: 50%;
      background: #fff;
      display: grid; place-items: center;
      overflow: hidden;
      border: 1px solid var(--border);
    }
    .set-svc-logo {
      width: 100%; height: 100%;
      object-fit: contain;
      padding: 5px;
    }

    /* Path display in the Stockage card. Mono font, subtle background,
       wraps long Windows paths cleanly. */
    .set-path {
      padding: 8px 11px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 9px;
      font-size: 12px;
      color: var(--text);
      word-break: break-all;
      line-height: 1.4;
    }

    /* Provider tile grid in the Add-mailbox modal */
    .m-providers {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      grid-template-rows: repeat(3, 1fr);
      gap: 8px;
      margin-top: 4px;
    }
    .m-prov-tile {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 12px 8px;
      background: var(--surface-2);
      border: 1.5px solid var(--border);
      border-radius: 10px;
      cursor: pointer;
      transition: border-color .15s, background .15s, transform .05s;
      font-family: inherit;
      color: var(--text);
    }
    .m-prov-tile:hover { border-color: var(--accent); }
    .m-prov-tile:active { transform: translateY(1px); }
    .m-prov-tile.is-active {
      border-color: var(--accent);
      background: var(--accent-soft);
      box-shadow: 0 0 0 2px var(--accent-soft) inset;
    }
    .m-prov-tile .set-svc {
      width: 36px; height: 36px;
    }
    .m-prov-name {
      font-size: 12px;
      font-weight: 600;
      text-align: center;
      line-height: 1.25;
      color: var(--text);
    }
    .m-prov-glyph {
      width: 100%; height: 100%;
      display: grid; place-items: center;
      color: var(--muted);
    }
    .set-acc-info { flex: 1; min-width: 0; }
    .set-acc-name {
      font-weight: 600; font-size: 14px; color: var(--text);
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    }
    .set-acc-sub {
      font-size: 12px; color: var(--muted);
      font-family: 'JetBrains Mono', monospace;
      margin-top: 2px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .set-acc-actions { display: flex; gap: 6px; flex-shrink: 0; }

    .set-badge {
      display: inline-flex; padding: 2px 8px; border-radius: 999px;
      font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
      text-transform: uppercase;
      background: var(--accent-soft); color: var(--accent-ink);
    }
    .set-badge.warn {
      background: rgba(245, 158, 11, 0.15);
      color: var(--warning);
    }

    .set-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
    }
    .set-grid-3 { grid-template-columns: 1fr 1fr 1fr; }
    @media (max-width: 720px) { .set-grid, .set-grid-3 { grid-template-columns: 1fr; } }

    .set-field { display: flex; flex-direction: column; gap: 4px; }
    .set-label {
      font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
      text-transform: uppercase; color: var(--muted);
    }
    .set-label-row {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; flex-wrap: wrap;
    }
    .set-quick-link {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11px;
      font-weight: 600;
      color: var(--accent);
      text-decoration: none;
      padding: 3px 9px;
      border-radius: 999px;
      background: var(--accent-soft);
      border: 1px solid color-mix(in oklab, var(--accent) 25%, transparent);
      letter-spacing: 0;
      text-transform: none;
      transition: filter .15s, transform .05s;
    }
    .set-quick-link.hidden { display: none; }
    .set-quick-link:hover { filter: brightness(1.08); transform: translateY(-1px); }
    .set-quick-link i, .set-quick-link svg { width: 12px; height: 12px; stroke-width: 2.5; }
    .set-hint { font-size: 11px; color: var(--muted-2); margin-top: 4px; }
    .set-input {
      width: 100%;
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 9px;
      padding: 9px 11px;
      font-size: 13px;
      font-family: inherit;
      transition: border-color .15s, box-shadow .15s;
    }
    .set-input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }
    .set-input:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      background: var(--surface-2);
    }
    .set-input.mono { font-family: 'JetBrains Mono', monospace; }
    /* ── Custom model dropdown ── */
    .set-drop-wrap { position: relative; width: 100%; }
    .set-drop-btn {
      width: 100%;
      display: flex; align-items: center; justify-content: space-between;
      gap: 8px;
      padding: 9px 11px;
      background: var(--surface-2);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 9px;
      font: inherit; font-size: 13px;
      cursor: pointer;
      transition: border-color .15s, box-shadow .15s;
      text-align: left;
    }
    .set-drop-btn:hover { border-color: var(--accent); }
    .set-drop-wrap.open .set-drop-btn {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }
    .set-drop-btn svg { opacity: 0.5; flex-shrink: 0; transition: transform 160ms ease; }
    .set-drop-wrap.open .set-drop-btn svg { transform: rotate(180deg); }
    .set-drop-menu {
      display: none;
      position: fixed;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 8px 28px var(--shadow-md);
      z-index: 9999;
      padding: 4px;
      flex-direction: column;
      gap: 2px;
      min-width: 160px;
    }
    /* open state managed by JS (menu is appended to body) */

    .set-actions {
      display: flex; justify-content: center; gap: 8px;
      margin-top: 14px; padding-top: 12px;
      border-top: 1px solid var(--border-2);
    }
    .set-btn {
      margin: 0; padding: 7px 14px; font-size: 13px;
    }
    .set-btn-ghost {
      margin: 0; padding: 7px 14px; font-size: 13px;
      background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border);
    }
    .set-btn-ghost:hover { background: var(--accent-soft); border-color: var(--accent); }

    .set-btn-danger {
      margin: 0; padding: 7px 14px; font-size: 13px;
      background: var(--danger);
      color: var(--danger-on, #fff);
      border: 1px solid var(--danger);
      display: inline-flex; align-items: center; gap: 6px;
      border-radius: 9px;
      cursor: pointer;
      font-family: inherit; font-weight: 600;
      transition: filter .15s, transform .05s;
    }
    .set-btn-danger:hover:not(:disabled) { filter: brightness(1.05); }
    .set-btn-danger:active:not(:disabled) { transform: translateY(1px); }
    .set-btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }

    .set-toggle {
      display: inline-flex; align-items: center; gap: 8px;
      font-size: 13px; color: var(--text); cursor: pointer;
      user-select: none;
    }

    .set-status {
      display: inline-flex; align-items: center; gap: 8px;
      font-size: 13px; color: var(--text);
      padding: 9px 11px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 9px;
      width: fit-content;
      max-width: 100%;
      align-self: flex-start;
    }
    .set-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--muted);
    }
    .set-dot.ok { background: var(--success); box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18); }
    .set-dot.warn { background: var(--warning); box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.18); }

    .set-icon-btn {
      width: 32px; height: 32px;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border); border-radius: 8px;
      cursor: pointer; transition: background .15s, border-color .15s, color .15s;
    }
    .set-icon-btn:hover {
      background: var(--accent-soft);
      border-color: var(--accent);
      color: var(--accent-ink);
    }
    .set-icon-btn.danger:hover {
      background: rgba(239, 68, 68, 0.12);
      border-color: var(--danger);
      color: var(--danger);
    }

    /* Account-row enable/pause switch — replaces the modal's old
       "Boîte active" checkbox. Flips the scheduler's enabled flag
       inline; visual style follows the iOS-style track + thumb. The
       outer button matches .set-icon-btn height (32px) so all action
       controls share the same baseline; the track sits centred inside. */
    .set-switch {
      width: 40px; height: 32px;
      padding: 0; border: 0; background: transparent;
      cursor: pointer; flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .set-switch-track {
      position: relative;
      width: 36px; height: 20px;
      border-radius: 999px;
      background: var(--border);
      transition: background 160ms ease;
    }
    .set-switch-thumb {
      position: absolute;
      top: 2px; left: 2px;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 2px rgba(0,0,0,0.2);
      transition: transform 160ms ease;
    }
    .set-switch.is-on .set-switch-track { background: var(--accent); }
    .set-switch.is-on .set-switch-thumb { transform: translateX(16px); }
    .set-switch:hover .set-switch-track { filter: brightness(1.05); }
    .set-switch:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
      border-radius: 999px;
    }

    /* Subtle dim on disabled rows so the visual state matches the
       switch position. Keeps the row clickable and editable so the
       user can re-enable from any control. */
    .set-acc-row.is-disabled .set-acc-name,
    .set-acc-row.is-disabled .set-acc-sub { opacity: 0.6; }

    /* Test-status icon: not a destructive action, but uses colour to
       summarise the latest auto-test outcome. Hover reveals the title. */
    .set-icon-btn.test-status.test-ok {
      background: rgba(34, 197, 94, 0.10);
      border-color: rgba(34, 197, 94, 0.45);
      color: rgb(22, 163, 74);
    }
    .set-icon-btn.test-status.test-ok:hover {
      background: rgba(34, 197, 94, 0.18);
      border-color: rgb(22, 163, 74);
      color: rgb(21, 128, 61);
    }
    .set-icon-btn.test-status.test-fail {
      background: rgba(239, 68, 68, 0.10);
      border-color: rgba(239, 68, 68, 0.45);
      color: var(--danger);
    }
    .set-icon-btn.test-status.test-fail:hover {
      background: rgba(239, 68, 68, 0.18);
      border-color: var(--danger);
      color: var(--danger);
    }
    .set-icon-btn.test-status.test-unknown {
      color: var(--muted);
    }
    /* Spinner during a re-test. The lucide loader-2 icon is animated by
       us — lucide ships static SVGs, so the spin lives in CSS. */
    .set-icon-btn.test-status.test-busy {
      pointer-events: none;
      color: var(--accent);
    }
    .set-icon-btn.test-status.test-busy svg {
      animation: set-spin 0.9s linear infinite;
    }
    @keyframes set-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }

    /* Modal */
    .set-modal {
      position: fixed; inset: 0; z-index: 80;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.55);
      animation: set-fade-in 160ms ease-out;
    }
    .set-modal.hidden { display: none; }
    .set-modal-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 22px;
      width: 92%; max-width: 560px;
      max-height: 90vh; overflow-y: auto;
      box-shadow: 0 24px 60px var(--shadow-lg);
      display: flex; flex-direction: column; gap: 12px;
    }
    .set-modal-head {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 4px;
    }
    .set-modal-head h3 { margin: 0; font-size: 16px; font-weight: 700; color: var(--text); }
    .set-modal-actions {
      display: flex; justify-content: flex-end; gap: 8px;
      margin-top: 10px; padding-top: 12px;
      border-top: 1px solid var(--border-2);
    }
    .set-help {
      padding: 10px 12px;
      background: var(--accent-soft);
      color: var(--accent-ink);
      border-radius: 9px;
      font-size: 12px;
      line-height: 1.5;
    }
    .set-help a { color: var(--accent-ink); text-decoration: underline; font-weight: 600; }
    .set-help.hidden { display: none; }
    .set-advanced > summary {
      cursor: pointer; user-select: none;
      color: var(--muted); font-size: 12px;
      padding: 4px 0;
    }
    .set-advanced > summary:hover { color: var(--text); }
    .set-subhead {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 14px 0 6px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--border-2, var(--border));
    }
    .set-subhead:first-of-type { margin-top: 8px; }
    .set-checks {
      display: flex; gap: 16px; flex-wrap: wrap;
      margin-top: 10px; font-size: 13px; color: var(--text);
    }
    .set-checks label {
      display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
    }
    /* Custom checkbox skin — replaces the native browser widget across
       the Settings modal (IMAP/SMTP toggles + the "Boîte active" row).
       The :checked state fills with the accent colour and draws a
       pseudo-element checkmark; nothing else changes the markup. */
    .set-checks input[type="checkbox"],
    .set-toggle input[type="checkbox"] {
      appearance: none;
      -webkit-appearance: none;
      width: 16px;
      height: 16px;
      margin: 0;
      border: 1.5px solid var(--border);
      border-radius: 4px;
      background: var(--bg);
      cursor: pointer;
      position: relative;
      flex-shrink: 0;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .set-checks input[type="checkbox"]:hover,
    .set-toggle input[type="checkbox"]:hover {
      border-color: var(--accent);
    }
    .set-checks input[type="checkbox"]:checked,
    .set-toggle input[type="checkbox"]:checked {
      background: var(--accent);
      border-color: var(--accent);
    }
    .set-checks input[type="checkbox"]:checked::after,
    .set-toggle input[type="checkbox"]:checked::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 4px;
      height: 8px;
      border: solid var(--accent-on, #fff);
      border-width: 0 2px 2px 0;
      /* Centre via translate, then rotate. The -60% on Y compensates
         for the visual asymmetry of a tick — the bottom-right corner
         needs to sit slightly below the geometric centre to read as
         centred. */
      transform: translate(-50%, -60%) rotate(45deg);
    }
    .set-checks input[type="checkbox"]:focus-visible,
    .set-toggle input[type="checkbox"]:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .set-test-result { font-size: 13px; min-height: 18px; }
    .set-test-result .set-ok,
    .set-test-result .set-err {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 9px 12px;
      border-radius: 9px;
      font-weight: 500;
      line-height: 1.45;
    }
    .set-test-result .set-ok {
      background: color-mix(in oklab, var(--success) 10%, transparent);
      border: 1px solid color-mix(in oklab, var(--success) 28%, transparent);
      color: var(--success);
    }
    .set-test-result .set-err {
      background: color-mix(in oklab, var(--danger) 10%, transparent);
      border: 1px solid color-mix(in oklab, var(--danger) 28%, transparent);
      color: var(--danger);
    }
    .set-test-result .set-err .sub {
      color: color-mix(in oklab, var(--danger) 75%, var(--text));
      font-size: 12px;
      margin-top: 3px;
      font-weight: 400;
    }

    .set-spinner {
      display: inline-block;
      width: 12px; height: 12px;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: set-spin .8s linear infinite;
      vertical-align: -2px;
    }

    @keyframes set-spin { to { transform: rotate(360deg); } }
    @keyframes set-fade-in { from { opacity: 0; } to { opacity: 1; } }
  `;
  const style = document.createElement('style');
  style.id = 'settings-css';
  style.textContent = css;
  document.head.appendChild(style);
}
