// SPDX-License-Identifier: GPL-3.0-or-later
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

// Map an account `type` (and email fallback) to a public domain whose logo
// we display. Custom-domain mailboxes (e.g. you@yourdomain.com hosted on
// Proton) still get their *service* logo instead of their custom-domain
// favicon, which is what users expect.
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
  // Provider logos come from OUR backend (/api/brand-logo — fetched from
  // the provider's own domain and cached on disk), so the client never
  // talks to a third-party favicon service. The privacy pass had reduced
  // this to a bare glyph because the old implementation hit google.com.
  //
  // The lucide glyph renders underneath; the logo <img> stacks on top and
  // is dropped by app.js's delegated error handler when the backend has no
  // logo (404), letting the glyph show through. No inline onerror.
  const glyph = `<i data-lucide="mail" class="set-svc-logo"></i>`;
  const type = (account?.type || '').toLowerCase();
  let domain = SERVICE_DOMAINS[type] || '';
  if (!domain && account?.email) {
    const at = account.email.lastIndexOf('@');
    const d = at >= 0 ? account.email.slice(at + 1).toLowerCase().trim() : '';
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) domain = d;
  }
  if (!domain) return glyph;
  // Eager on purpose: a dozen tiny favicons at most (account rows + the
  // provider grid in the modal) — lazy-loading buys nothing here and its
  // IntersectionObserver gate can delay images that are already on screen.
  // The mailbox list, with hundreds of rows, is where lazy belongs.
  return glyph + `<img class="set-svc-img" src="/api/brand-logo/${encodeURIComponent(domain)}"
    alt="" decoding="async" referrerpolicy="no-referrer">`;
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

  // Listeners on `document` outlive host.innerHTML = '' — the router only
  // wipes the view element. Register them through this helper so the
  // cleanup below can actually take them back down; otherwise every visit
  // to Settings left another live handler running `wrap.contains(e.target)`
  // against detached DOM on every click in the app, holding the whole view
  // closure alive with it.
  const _docTeardown = [];
  const onDoc = (type, fn, opt) => {
    document.addEventListener(type, fn, opt);
    _docTeardown.push(() => document.removeEventListener(type, fn, opt));
  };

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

        <!-- IA — provider radio + sous-panneaux OpenAI / Local -->
        <section class="card col-6" id="ai-section">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="sparkles" class="w-4 h-4"></i>${t('set.ai.title')}
            </span>
          </h3>

          <!-- Provider tiles — click to pick the AI backend. "APIs" groups
               both cloud providers (OpenAI, Claude) behind one tile; the
               actual fournisseur choice lives in its sub-panel and only
               becomes the active backend when a key is saved. -->
          <div class="ai-tiles ai-tiles--3" id="ai-tiles" role="radiogroup" aria-label="${t('set.llm.provider_label')}">
            <button class="ai-tile" type="button" data-provider="local" role="radio" aria-checked="false">
              <i data-lucide="cpu" class="w-5 h-5"></i>
              <span class="ai-tile-name">${t('set.llm.tile_local')}</span>
              <span class="ai-tile-sub">${t('set.llm.tile_local_sub')}</span>
            </button>
            <button class="ai-tile" type="button" data-provider="ollama" role="radio" aria-checked="false">
              <i data-lucide="server" class="w-5 h-5"></i>
              <span class="ai-tile-name">Ollama</span>
              <span class="ai-tile-sub">${t('set.llm.tile_ollama_sub')}</span>
            </button>
            <button class="ai-tile" type="button" data-provider="apis" role="radio" aria-checked="false">
              <i data-lucide="cloud" class="w-5 h-5"></i>
              <span class="ai-tile-name">${t('set.apis.title')}</span>
              <span class="ai-tile-sub">${t('set.llm.tile_cloud_sub')}</span>
            </button>
          </div>

          <!-- Sous-panneau Local (mode 100% gratuit + privé, peuplé à la volée).
               Le bandeau matériel a été retiré : quand on est ici, l'utilisateur
               a déjà activé le local depuis l'onboarding et n'a plus besoin de
               voir "Détecté : X GB RAM → tier Y" — seule la sélection compte. -->
          <div id="ai-panel-local" class="hidden" style="margin-top:8px">
            <div id="llm-models-list" class="set-llm-models">
              <div class="sub" style="font-style:italic">${t('set.loading')}</div>
            </div>
            <div class="set-llm-footer">
              <span id="llm-disk-usage" class="sub"></span>
              <button class="mb-cta set-btn" id="btn-activate-local" disabled>
                ${t('set.llm.apply_btn')}
              </button>
            </div>
          </div>

          <!-- Sous-panneau Ollama -->
          <div id="ai-panel-ollama" class="hidden" style="margin-top:8px">
            <p class="set-hint" style="margin-bottom:10px">${t('set.ollama.intro')}</p>
            <div class="set-grid">
              <label class="set-field">
                <span class="set-label">${t('set.ollama.url_label')}</span>
                <input id="ollama-url" type="text" class="set-input mono" placeholder="http://localhost:11434" />
              </label>
              <label class="set-field">
                <span class="set-label">${t('set.ollama.model_label')}</span>
                <div style="display:flex;gap:8px;align-items:center">
                  <select id="ollama-model" class="set-input" style="flex:1"></select>
                  <button class="mb-cta set-btn-ghost" id="ollama-refresh" type="button" title="${t('set.ollama.refresh')}">
                    <i data-lucide="refresh-cw" class="w-4 h-4"></i>
                  </button>
                </div>
                <span class="set-hint" id="ollama-status"></span>
              </label>
            </div>
            <div class="set-actions">
              <button class="mb-cta set-btn" id="btn-save-ollama">${t('set.save')}</button>
            </div>
          </div>

          <!-- Sous-panneau APIs (OpenAI / Claude) — un formulaire
               fournisseur + clé. Enregistrer la clé rend ce fournisseur
               actif ; le simple clic sur la tuile ne bascule rien. -->
          <div id="ai-panel-apis" class="hidden" style="margin-top:8px">
            <p class="set-hint" style="margin-bottom:10px">${t('set.apis.intro')}</p>
            <div id="api-active-note" class="set-hint hidden" style="margin-bottom:10px"></div>
            <div class="set-grid">
              <label class="set-field">
                <span class="set-label">${t('set.apis.provider_label')}</span>
                <select id="api-provider" class="set-input">
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Claude</option>
                  <option value="openrouter">OpenRouter</option>
                </select>
              </label>
              <label class="set-field">
                <span class="set-label">${t('set.ai.model_label')}</span>
                <select id="api-model" class="set-input"></select>
              </label>
            </div>
            <label class="set-field" style="margin-top:12px">
              <span class="set-label">${t('set.apis.key_label')}</span>
              <input id="api-key" type="password" class="set-input mono" autocomplete="new-password" />
              <span class="set-hint" id="api-key-hint">${t('set.apis.key_hint')}</span>
            </label>
            <div class="set-actions">
              <button class="mb-cta set-btn" id="btn-save-api">${t('set.apis.save')}</button>
            </div>
          </div>

        </section>

        <!-- Notifications -->
        <section class="card col-6">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="bell" class="w-4 h-4"></i>${t('set.notif.title')}
            </span>
            <div class="set-provider-radio set-notif-seg" role="radiogroup" aria-label="${escapeAttr(t('set.notif.seg_aria'))}">
              <label class="set-prov-opt" title="${escapeAttr(t('set.notif.toggle_off_title'))}">
                <input type="radio" name="ntfy-seg" id="ntfy-seg-off" value="0" />
                <i data-lucide="bell-off" class="set-notif-seg-ic" aria-hidden="true"></i>
              </label>
              <label class="set-prov-opt" title="${escapeAttr(t('set.notif.toggle_on_title'))}">
                <input type="radio" name="ntfy-seg" id="ntfy-seg-on" value="1" />
                <i data-lucide="bell" class="set-notif-seg-ic" aria-hidden="true"></i>
              </label>
            </div>
          </h3>
          <div class="set-notif-fields-row">
            <div class="set-grid" style="flex:1;min-width:0">
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
            <div class="set-actions set-actions--rail">
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
          <div class="set-inline-save-row">
            <div class="set-grid set-grid-3" style="flex:1">
              <label class="set-field">
                <span class="set-label">${t('set.polling.interval_label')}</span>
                <div style="display:flex;align-items:center;gap:8px">
                  <input id="general-interval" type="number" min="1" max="1440" class="set-input" style="max-width:72px" />
                  <span style="color:var(--muted);font-size:13px">minutes</span>
                </div>
                <span class="set-hint">${t('set.polling.interval_hint')}</span>
              </label>
              <label class="set-field">
                <span class="set-label">${t('set.injection.label')}</span>
                <select id="general-injection" class="set-input" style="max-width:220px">
                  <option value="hybrid">${t('set.injection.hybrid')}</option>
                  <option value="local">${t('set.injection.local')}</option>
                  <option value="llm">${t('set.injection.llm')}</option>
                  <option value="off">${t('set.injection.off')}</option>
                </select>
                <span class="set-hint">${t('set.injection.hint')}</span>
              </label>
              <div class="set-field">
                <span class="set-label">${t('set.polling.status_label')}</span>
                <div id="set-services" class="set-status">…</div>
              </div>
            </div>
            <div class="set-actions set-actions--rail">
              <button class="mb-cta set-btn" id="btn-save-general">${t('set.save')}</button>
            </div>
          </div>
        </section>

        <!-- Storage -->
        <section class="card col-6 set-card--fill-body">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="hard-drive" class="w-4 h-4"></i>${t('set.storage.title')}
            </span>
          </h3>
          <div class="set-storage-body">
            <div id="view-storage-main" class="set-storage-view">
              <div class="set-storage-field-wrap">
                <div class="set-field" style="flex:1;min-width:0">
                  <span class="set-label">${t('set.storage.dir_label')}</span>
                  <div id="set-data-dir" class="set-path mono">—</div>
                  <span class="set-hint">${t('set.storage.dir_hint')}</span>
                </div>
                <div class="set-actions-rail">
                  <button class="mb-cta set-btn-ghost" id="btn-storage-actions" type="button">
                    <i data-lucide="menu" class="w-4 h-4"></i>
                    <span>${t('set.storage.actions_btn')}</span>
                  </button>
                </div>
              </div>
            </div>
            <div id="view-storage-actions" class="set-storage-view hidden">
              <div class="set-storage-view__head">
                <span class="set-storage-view__title">${t('set.storage.actions_btn')}</span>
                <button class="set-icon-btn" id="btn-storage-actions-back" type="button" aria-label="${t('set.close')}">
                  <i data-lucide="x" class="w-4 h-4"></i>
                </button>
              </div>
              <div class="set-storage-actions-grid">
                <button class="mb-cta set-btn-ghost" id="btn-open-data" type="button">
                  <i data-lucide="folder-open" class="w-3.5 h-3.5"></i>
                  <span>${t('set.storage.open_btn')}</span>
                </button>
                <button class="mb-cta set-btn-ghost" id="btn-export-config" type="button">
                  <i data-lucide="download" class="w-3.5 h-3.5"></i>
                  <span>${t('set.storage.export_btn')}</span>
                </button>
                <button class="mb-cta set-btn-ghost" id="btn-import-config" type="button">
                  <i data-lucide="upload" class="w-3.5 h-3.5"></i>
                  <span>${t('set.storage.import_btn')}</span>
                </button>
                <button class="mb-cta set-btn-ghost" id="btn-wipe-ai" type="button"
                        title="${t('set.storage.wipe_ai_hint')}">
                  <i data-lucide="sparkles" class="w-3.5 h-3.5"></i>
                  <span>${t('set.storage.wipe_ai_btn')}</span>
                </button>
              </div>
              <hr class="set-storage-view__sep">
              <button class="mb-cta set-btn-danger" id="btn-wipe-data" type="button">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
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

        <!-- Per-account AI: three self-explanatory option rows instead of the
             old loose stack (bare checkbox / stray narrow field / bare
             checkbox). The two dependent rows dim while the master toggle
             is off — they mean nothing without it. -->
        <div class="set-subhead">${t('set.account.ai_section')}</div>
        <div class="set-ai-opts" id="m-ai-opts">
          <label class="set-opt">
            <input id="m-ai-enabled" type="checkbox" checked />
            <span class="set-opt-body">
              <span class="set-opt-label">${t('set.account.ai_enabled')}</span>
              <span class="set-opt-hint">${t('set.account.ai_enabled_hint')}</span>
            </span>
          </label>
          <label class="set-opt" data-ai-dep>
            <input id="m-auto-draft" type="checkbox" />
            <span class="set-opt-body">
              <span class="set-opt-label">${t('set.account.auto_draft')}</span>
              <span class="set-opt-hint">${t('set.account.auto_draft_hint')}</span>
            </span>
          </label>
          <div class="set-opt set-opt-static" data-ai-dep>
            <span class="set-opt-body">
              <span class="set-opt-label">${t('set.account.ai_threshold')}</span>
              <span class="set-opt-hint">${t('set.account.ai_threshold_hint')}</span>
            </span>
            <input id="m-ai-threshold" type="number" min="0" max="10"
                   class="set-input set-opt-input"
                   placeholder="${t('set.account.ai_threshold_ph')}"
                   aria-label="${t('set.account.ai_threshold')}" />
          </div>
        </div>

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
    // On-device AI provider tiles/panels — section IA
    aiTiles:         host.querySelector('#ai-tiles'),
    panelLocal:      host.querySelector('#ai-panel-local'),
    panelOllama:     host.querySelector('#ai-panel-ollama'),
    panelApis:       host.querySelector('#ai-panel-apis'),
    ollamaUrl:       host.querySelector('#ollama-url'),
    ollamaModel:     host.querySelector('#ollama-model'),
    ollamaStatus:    host.querySelector('#ollama-status'),
    // Cloud APIs — section APIs (OpenAI / Claude behind one fournisseur + clé)
    apiProvider:     host.querySelector('#api-provider'),
    apiModel:        host.querySelector('#api-model'),
    apiKey:          host.querySelector('#api-key'),
    apiKeyHint:      host.querySelector('#api-key-hint'),
    apiActiveNote:   host.querySelector('#api-active-note'),
    llmModelsList:   host.querySelector('#llm-models-list'),
    llmDiskUsage:    host.querySelector('#llm-disk-usage'),
    btnActivateLocal:host.querySelector('#btn-activate-local'),
    ntfySegOff: host.querySelector('#ntfy-seg-off'),
    ntfySegOn:  host.querySelector('#ntfy-seg-on'),
    ntfyTopic:   host.querySelector('#ntfy-topic'),
    ntfyMin:     host.querySelector('#ntfy-min'),
    genInterval: host.querySelector('#general-interval'),
    genInjection: host.querySelector('#general-injection'),
    btnAdd:    host.querySelector('#btn-add-acc'),
    btnSaveApi: host.querySelector('#btn-save-api'),
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
    mAiEnabled:   host.querySelector('#m-ai-enabled'),
    mAiThreshold: host.querySelector('#m-ai-threshold'),
    mAutoDraft:   host.querySelector('#m-auto-draft'),
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

  const state = {
    providers: [], config: null, status: null,
    // LLM local : chargé à la demande au premier switch vers "Local"
    // pour ne pas tirer /api/llm/hardware + /api/llm/models quand l'user
    // reste sur OpenAI. Re-fetchés à chaque toggle pour rafraîchir l'état
    // "downloaded" après un download/delete.
    localLoaded: false,
    hardware: null,
    models: [],
    selectedAnalyzer: null,
    selectedDrafter:  null,
    downloadsInFlight: new Set(),  // model_ids en cours de DL — bloque l'Activate
  };

  // The OpenAI model picker used a custom body-portaled dropdown; the APIs
  // section now uses a plain <select id="api-model">, so that widget is gone.

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

  // ── Local LLM panel ───────────────────────────────────────────────
  // Charge le hardware + le catalog côté API, peuple la liste, et
  // bind les boutons Download/Delete par modèle. Re-callable pour
  // rafraîchir l'état après un download.

  async function loadLocalLLM() {
    try {
      const [hw, models] = await Promise.all([
        api('GET', '/api/llm/hardware'),
        api('GET', '/api/llm/models'),
      ]);
      state.hardware = hw;
      state.models = models;
      state.localLoaded = true;
      // Pré-sélection : on respecte la config persistée UNIQUEMENT si le
      // modèle qu'elle pointe est effectivement téléchargé. Sinon (cas
      // typique : fresh install, ou config porte un défaut de skeleton
      // obsolète qui pointe vers un modèle jamais downloadé), on tombe
      // sur le modèle recommandé pour le tier détecté. Évite que le
      // radio reste figé sur "Mistral 7B" quand l'user n'a rien
      // installé encore.
      //
      // IMPORTANT : loadLocalLLM est aussi rappelé après chaque
      // download/delete pour rafraîchir l'état `downloaded`. Dans ce
      // cas, l'utilisateur peut avoir déjà changé son radio en pending
      // (sans avoir cliqué Appliquer) — on doit PRÉSERVER cette
      // sélection in-memory, sinon le radio retombe sur la valeur
      // persistée à chaque refresh et l'utilisateur perd son choix.
      const llmLocal = (state.config.llm && state.config.llm.local) || {};
      const modelIds = new Set(models.map(m => m.id));
      state.selectedAnalyzer = (state.selectedAnalyzer && modelIds.has(state.selectedAnalyzer))
        ? state.selectedAnalyzer
        : _initialSelection(models, 'analyzer', hw.recommended_tier, llmLocal.analyzer_model_id);
      state.selectedDrafter = (state.selectedDrafter && modelIds.has(state.selectedDrafter))
        ? state.selectedDrafter
        : _initialSelection(models, 'drafter', hw.recommended_tier, llmLocal.drafter_model_id);
      renderLocalLLM();
    } catch (e) {
      els.llmModelsList.innerHTML = `<div class="sub" style="color:var(--danger)">${t('set.llm.load_error', { msg: e.message || e })}</div>`;
    }
  }

  function _initialSelection(models, role, tier, configId) {
    // Si l'user a une valeur dans la config, on la respecte — qu'elle soit
    // déjà téléchargée ou non. Précédemment on gatait sur `m.downloaded`,
    // ce qui faisait silencieusement reverter la sélection vers le modèle
    // recommandé après un Appliquer + reload sur un drafter non DL : le
    // user voyait sa préférence ignorée sans message, le radio se figeait
    // de force sur la reco. On ne replie sur la reco que si la config est
    // vide ou pointe vers un modèle qui n'existe plus dans le catalogue
    // (typique d'un schéma renommé entre versions).
    if (configId) {
      const m = models.find(x => x.id === configId && x.role === role);
      if (m) return configId;
    }
    return _defaultModelId(models, role, tier);
  }

  function _defaultModelId(models, role, tier) {
    const _tierRank = { light: 0, medium: 1, heavy: 2 };
    const match = models.find(m => m.role === role && m.recommended_for_tier === tier);
    if (match) return match.id;
    // Fallback : 1er modèle compatible (tier ≤ détecté)
    const compat = models.find(m => m.role === role && _tierRank[m.tier] <= _tierRank[tier]);
    return compat ? compat.id : (models.find(m => m.role === role)?.id || null);
  }

  // Transforme un nom de modèle "API" en libellé humain lisible.
  // "Phi-3.5 Mini Instruct (Q4_K_M)"               → "Phi 3.5 Mini"
  // "Qwen 2.5 3B Instruct (Q4_K_M) — Drafter léger" → "Qwen 2.5 3B"
  // "Mistral 7B Instruct v0.3 (Q4_K_M)"             → "Mistral 7B"
  //
  // La quantif (Q4_K_M), le label "Instruct", la version mineure (v0.3) et
  // les suffixes éditoriaux (" — Drafter léger") ne disent rien à un user
  // lambda. On garde uniquement la famille + la taille (3B/7B), reconnaissables.
  function _friendlyModelName(rawName) {
    return String(rawName || '')
      .replace(/\s+—\s+.*$/, '')              // " — Drafter léger"
      .replace(/\s*\(Q\d+(?:_K_[A-Z])?\)$/i, '')  // " (Q4_K_M)" / " (Q5)"
      .replace(/\s+Instruct\b/i, '')          // "Instruct"
      .replace(/\s+v\d+\.\d+\b/i, '')         // "v0.3"
      .replace(/-(\d)/g, ' $1')               // "Phi-3.5" → "Phi 3.5"
      .replace(/\s+/g, ' ')
      .trim();
  }

  function renderLocalLLM() {
    const hw = state.hardware;
    const tier = hw.recommended_tier;
    // Hardware banner retiré : à ce stade l'utilisateur a déjà choisi
    // d'utiliser le local et n'a plus besoin du rappel matériel. On
    // garde `hw` en mémoire parce que le RAM warning et la pré-sélection
    // du modèle recommandé continuent de s'en servir plus bas.

    // Estimation du RAM résident d'un modèle quand il tourne. C'est
    // l'overhead du wheel llama_cpp + KV cache + le poids du modèle.
    // Empiriquement (Phase 0 bis) : ~1.3x la taille du GGUF Q4 sur disque.
    const _estimatedResidentBytes = (m) => m.size_bytes * 1.3;
    // RAM totale dont on dispose après baseline OS + app + WebView2.
    // 3.5 Go sur Windows / Linux, 2.5 Go sur Apple Silicon (macOS optimisé).
    const baselineGb = hw.is_apple_silicon ? 2.5 : 3.5;
    const usableRamGb = Math.max(0, hw.ram_gb - baselineGb);
    // L'analyseur est toujours chargé en parallèle du drafter. Pour les
    // drafters, on calcule l'overhead "analyseur + drafter simultanés".
    const analyzerMeta = state.models.find(m => m.id === state.selectedAnalyzer);
    const analyzerResidentGb = analyzerMeta
      ? _estimatedResidentBytes(analyzerMeta) / 1024**3
      : 0;

    // Liste : analyzers d'abord, drafters ensuite. On grise les modèles
    // d'un tier supérieur à celui détecté (warning RAM).
    //
    // Pour le badge "recommandé", on utilise la MÊME logique que
    // `_defaultModelId` (qui pré-sélectionne le radio) : le modèle dont
    // `recommended_for_tier == userTier` SI il existe, sinon le premier
    // modèle compatible (tier ≤ userTier). Comme ça Phi-3.5-mini reste
    // marqué "recommandé" en analyseur même sur Heavy (le catalog n'a
    // qu'un seul analyseur — pas la peine d'en ajouter un par tier).
    const _tierRank = { light: 0, medium: 1, heavy: 2 };
    const userTierRank = _tierRank[tier];
    const recommendedIds = {
      analyzer: _defaultModelId(state.models, 'analyzer', tier),
      drafter:  _defaultModelId(state.models, 'drafter',  tier),
    };
    const html = ['analyzer', 'drafter'].map(role => {
      const roleLabel = t('set.llm.role_' + role);
      const roleDesc  = t('set.llm.role_' + role + '_desc') || '';
      const items = state.models
        .filter(m => m.role === role)
        .map(m => {
          const overTier = _tierRank[m.tier] > userTierRank;
          const isRecommended = m.id === recommendedIds[role];
          const isSelected = (role === 'analyzer' ? state.selectedAnalyzer : state.selectedDrafter) === m.id;
          const sizeGb = (m.size_bytes / 1024 / 1024 / 1024).toFixed(1);
          // Nom propre pour humains : "Phi-3.5 Mini Instruct (Q4_K_M)" → "Phi 3.5 Mini".
          const friendlyName = _friendlyModelName(m.name);
          const vendor = m.vendor || '';

          // RAM warning identique à l'ancienne logique.
          const modelResidentGb = _estimatedResidentBytes(m) / 1024**3;
          const peakResidentGb = role === 'analyzer'
            ? modelResidentGb
            : modelResidentGb + analyzerResidentGb;
          const exceedsRam = peakResidentGb > usableRamGb;
          const ramWarningMsg = exceedsRam
            ? t('set.llm.ram_warning', {
                peak: peakResidentGb.toFixed(1),
                usable: usableRamGb.toFixed(1),
              })
            : '';
          const tooltip = exceedsRam ? ramWarningMsg
                       : overTier ? t('set.llm.heavy_warning')
                       : '';
          // Téléchargement et sélection sont DÉCOUPLÉS : un user veut
          // pouvoir tester plusieurs rédacteurs avant de figer son choix
          // dans Appliquer. Forcer un select-then-download créait un piège
          // (le radio repassait sur l'ancienne valeur après échec d'apply
          // sur un modèle pas encore DL, et l'utilisateur ne pouvait
          // jamais lancer le DL). Le bouton Download reste accessible
          // sur chaque ligne tant que le modèle n'est pas déjà sur disque.
          return `
            <label class="set-llm-model ${exceedsRam ? 'ram-warning' : ''} ${overTier && !exceedsRam ? 'disabled' : ''} ${isRecommended ? 'recommended' : ''} ${isSelected ? 'is-selected' : ''} ${m.downloaded ? 'is-dl' : 'is-not-dl'}"
                   data-model-id="${escapeAttr(m.id)}" data-role="${role}" title="${escapeAttr(tooltip)}">
              <input type="radio" name="select-${role}" ${isSelected ? 'checked' : ''}
                     class="set-llm-radio"
                     data-select-id="${escapeAttr(m.id)}" data-select-role="${role}">
              <div class="set-llm-model-info">
                <div class="set-llm-model-line">
                  <span class="set-llm-model-name">${escapeHtml(friendlyName)}</span>
                  ${isRecommended ? `<span class="set-llm-pill set-llm-pill-recommend"><i data-lucide="star" class="w-3 h-3"></i>${t('set.llm.recommended_badge')}</span>` : ''}
                  ${m.downloaded ? `<span class="set-llm-pill set-llm-pill-downloaded"><i data-lucide="check" class="w-3 h-3"></i>${t('set.llm.dl_done_short')}</span>` : ''}
                </div>
                <div class="set-llm-model-sub">
                  ${vendor ? `${escapeHtml(vendor)} · ` : ''}${sizeGb} GB${m.license ? ' · ' + escapeHtml(m.license) : ''}
                </div>
                ${exceedsRam ? `
                  <div class="set-llm-ram-warning">
                    <i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i>
                    ${escapeHtml(ramWarningMsg)}
                  </div>` : ''}
                <div id="dl-progress-${escapeAttr(m.id)}" class="set-llm-progress" style="display:none">
                  <div class="set-llm-progress-bar" style="width:0%"></div>
                </div>
                <div id="dl-progress-text-${escapeAttr(m.id)}" class="set-llm-progress-text" style="display:none"></div>
              </div>
              <div class="set-llm-model-action">
                ${m.downloaded
                  ? `<button class="set-llm-btn danger" data-act="delete" data-id="${escapeAttr(m.id)}" title="${escapeAttr(t('set.llm.delete_btn'))}"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>`
                  : `<button class="set-llm-btn primary" data-act="download" data-id="${escapeAttr(m.id)}"><i data-lucide="download" class="w-3.5 h-3.5"></i>${t('set.llm.download_btn')}</button>`
                }
              </div>
            </label>
          `;
        })
        .join('');
      return `
        <div class="set-llm-role-group">
          <div class="set-llm-role-header">
            <span class="set-llm-role-title">${escapeHtml(roleLabel)}</span>
            ${roleDesc ? `<span class="set-llm-role-desc">${escapeHtml(roleDesc)}</span>` : ''}
          </div>
          ${items}
        </div>
      `;
    }).join('');
    els.llmModelsList.innerHTML = html;

    // Disk usage footer
    const totalBytes = state.models.reduce((s, m) => s + (m.downloaded ? m.downloaded_bytes : 0), 0);
    const totalGb = (totalBytes / 1024 / 1024 / 1024).toFixed(2);
    els.llmDiskUsage.textContent = t('set.llm.disk_usage', { size: totalGb });

    // Bind buttons. Le `<label>` parent englobe la card entière (clic =
    // sélectionne le radio), donc on stoppe la propagation côté bouton
    // pour que cliquer "Télécharger" / "Supprimer" ne déclenche pas
    // accidentellement la sélection.
    els.llmModelsList.querySelectorAll('[data-act]').forEach(btn => {
      btn.setAttribute('type', 'button');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.dataset.id;
        if (btn.dataset.act === 'download') downloadModel(id);
        if (btn.dataset.act === 'delete')   deleteModel(id);
      });
    });
    // Bind radios (sélection analyzer/drafter). On met à jour l'état et
    // on toggle la classe `is-selected` sur la ligne courante du rôle,
    // sans toucher aux boutons Download — chaque ligne garde le sien
    // accessible indépendamment, pour qu'un user puisse télécharger
    // plusieurs rédacteurs avant de figer son choix dans Appliquer.
    els.llmModelsList.querySelectorAll('[data-select-id]').forEach(rad => {
      rad.addEventListener('change', () => {
        const role = rad.dataset.selectRole;
        const id = rad.dataset.selectId;
        if (role === 'analyzer') state.selectedAnalyzer = id;
        else                     state.selectedDrafter = id;
        els.llmModelsList.querySelectorAll(`label.set-llm-model[data-role="${role}"]`).forEach(lbl => {
          lbl.classList.toggle('is-selected', lbl.dataset.modelId === id);
        });
        _updateActivateButtonState();
      });
    });

    _updateActivateButtonState();
    refreshIcons();
  }

  function _updateActivateButtonState() {
    // Trois états explicites pour clarifier l'utilité du bouton :
    //   1. "clean"   — le provider est déjà local ET la sélection radio
    //                 matche la config persistée. Le bouton affiche
    //                 "Mode local actif ✓" en disabled : signal clair que
    //                 rien à faire.
    //   2. "dirty"  — l'utilisateur a changé sa sélection (ou bascule
    //                 d'OpenAI vers local). Bouton activé en accent avec
    //                 "Appliquer les changements".
    //   3. "blocked"— l'analyzer choisi n'est pas téléchargé OU un DL est
    //                 en cours. Bouton disabled avec tooltip explicatif.
    const a = state.models.find(m => m.id === state.selectedAnalyzer);
    const downloaded = !!(a && a.downloaded);
    const dlInFlight = state.downloadsInFlight.size > 0;

    const cfgLlm   = (state.config && state.config.llm) || {};
    const cfgLocal = cfgLlm.local || {};
    const isLocalProvider = cfgLlm.provider === 'local';
    const matchesPersisted =
      isLocalProvider
      && state.selectedAnalyzer === cfgLocal.analyzer_model_id
      && state.selectedDrafter  === cfgLocal.drafter_model_id;

    const btn = els.btnActivateLocal;
    btn.classList.remove('is-active-state');

    if (!downloaded) {
      btn.disabled = true;
      btn.textContent = t('set.llm.apply_btn');
      btn.title = t('set.llm.need_download');
    } else if (dlInFlight) {
      btn.disabled = true;
      btn.textContent = t('set.llm.apply_btn');
      btn.title = t('set.llm.dl_in_progress');
    } else if (matchesPersisted) {
      btn.disabled = true;
      btn.textContent = t('set.llm.applied_state');
      btn.title = t('set.llm.applied_hint');
      btn.classList.add('is-active-state');
    } else {
      btn.disabled = false;
      btn.textContent = t('set.llm.apply_btn');
      btn.title = '';
    }
  }

  async function downloadModel(modelId) {
    state.downloadsInFlight.add(modelId);
    _updateActivateButtonState();

    const progressEl = host.querySelector(`#dl-progress-${CSS.escape(modelId)}`);
    const textEl     = host.querySelector(`#dl-progress-text-${CSS.escape(modelId)}`);
    const bar = progressEl?.querySelector('.set-llm-progress-bar');
    if (progressEl) progressEl.style.display = 'block';
    if (textEl)     textEl.style.display = 'block';

    // Désactive le bouton DL pendant l'opération
    const btn = host.querySelector(`[data-act="download"][data-id="${CSS.escape(modelId)}"]`);
    if (btn) { btn.disabled = true; btn.textContent = t('set.llm.downloading'); }

    // Toast persistant pendant le DL. Sans ça, un échec silencieux
    // (HTTP 4xx, rate-limit 429, perte réseau) laissait juste un mini
    // message dans le panneau, immédiatement écrasé par le refresh du
    // catalogue → l'user voyait "rien ne se passe".
    const friendly = _friendlyModelName((state.models.find(m => m.id === modelId) || {}).name) || modelId;
    const toast = (typeof window !== 'undefined' && window.railToast)
      ? window.railToast.show({
          variant: 'loading',
          message: t('set.llm.downloading') + ' — ' + friendly,
          progress: 0,
          duration: 0,
          collapseAfter: 0,
        })
      : null;

    let succeeded = false;

    try {
      const resp = await fetch(`/api/llm/models/${encodeURIComponent(modelId)}/download`, {
        method: 'POST',
      });
      if (!resp.ok || !resp.body) {
        let detail = '';
        try { detail = (await resp.text()).slice(0, 200); } catch {}
        throw new Error(`HTTP ${resp.status}${detail ? ' — ' + detail : ''}`);
      }
      // Parse SSE stream manuellement (pas d'EventSource pour POST)
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const evt of events) {
          if (!evt.startsWith('data: ')) continue;
          const data = JSON.parse(evt.slice(6));
          if (data.error) {
            throw new Error(data.error);
          }
          const pct = Math.round((data.progress || 0) * 100);
          if (bar) bar.style.width = `${pct}%`;
          if (toast) toast.update({ progress: pct });
          if (textEl) {
            if (data.done) {
              textEl.textContent = data.sha_ok ? t('set.llm.dl_done') : t('set.llm.dl_failed');
              succeeded = !!data.sha_ok;
            } else {
              textEl.textContent = `${(data.downloaded_bytes / 1024 / 1024).toFixed(0)} / ${(data.total_bytes / 1024 / 1024).toFixed(0)} Mo · ${data.speed_mbps?.toFixed(1) || 0} Mo/s`;
            }
          }
        }
      }
    } catch (e) {
      const msg = t('set.llm.dl_failed') + ' — ' + (e.message || e);
      if (textEl) textEl.textContent = msg;
      // Le toast d'erreur est SURTOUT là parce que le finally appelle
      // loadLocalLLM() côté succès, ce qui re-render la liste et écrase
      // le textEl ci-dessus. Côté erreur, on skip ce reload pour ne pas
      // perdre le message inline, mais un toast garantit la visibilité
      // même quand l'user a déjà scrollé ailleurs.
      if (toast) toast.error(msg);
      else if (typeof window !== 'undefined' && window.railToast) window.railToast.show({ variant: 'error', message: msg });
    } finally {
      state.downloadsInFlight.delete(modelId);
      if (succeeded) {
        if (toast) toast.success(t('set.llm.dl_done') + ' — ' + friendly);
        // Re-fetch le catalog pour avoir l'état downloaded à jour
        await loadLocalLLM();
      } else {
        // Échec : ne PAS rappeler loadLocalLLM qui detruirait le textEl
        // d'erreur et le state.downloadsInFlight déjà vidé. On restaure
        // juste le bouton Download pour que l'user puisse réessayer.
        if (btn) {
          btn.disabled = false;
          btn.textContent = t('set.llm.download_btn');
        }
        _updateActivateButtonState();
      }
    }
  }

  async function deleteModel(modelId) {
    if (!confirm(t('set.llm.delete_confirm'))) return;
    try {
      await api('DELETE', `/api/llm/models/${encodeURIComponent(modelId)}`);
      await loadLocalLLM();
    } catch (e) {
      alert(t('set.llm.delete_failed') + ' — ' + (e.message || e));
    }
  }

  async function activateLocal() {
    if (!state.selectedAnalyzer) return;
    els.btnActivateLocal.disabled = true;
    els.btnActivateLocal.textContent = t('set.llm.activating');
    try {
      const out = await api('POST', '/api/llm/activate', {
        analyzer_model_id: state.selectedAnalyzer,
        drafter_model_id: state.selectedDrafter || state.selectedAnalyzer,
      });
      if (out.warning) {
        alert(t('set.llm.activate_warning_' + out.warning) || out.warning);
      }
      // Reload pour rafraîchir le banner "services running"
      await loadAll();
    } catch (e) {
      alert(t('set.llm.activate_failed') + ' — ' + (e.message || e));
    } finally {
      _updateActivateButtonState();
    }
  }

  function setActiveProvider(provider, { skipPersist = false } = {}) {
    // "apis" is a UI grouping, not a backend provider: one tile covers both
    // cloud providers (OpenAI / Claude), whose real fournisseur choice lives
    // in the sub-panel. The tile highlights when either cloud provider is
    // the active backend, and clicking it only reveals the panel — the
    // backend switches to the chosen cloud provider when a key is saved
    // (saveApi), never on tile click, so a keyless click can't break AI.
    const cloud = provider === 'apis' || provider === 'openai'
      || provider === 'anthropic' || provider === 'openrouter';
    host.querySelectorAll('#ai-tiles .ai-tile').forEach((tile) => {
      const on = tile.dataset.provider === provider
        || (tile.dataset.provider === 'apis' && cloud);
      tile.classList.toggle('is-active', on);
      tile.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    els.panelLocal.classList.toggle('hidden', provider !== 'local');
    els.panelOllama.classList.toggle('hidden', provider !== 'ollama');
    els.panelApis.classList.toggle('hidden', !cloud);

    if (skipPersist || cloud) return;
    // Persist the switch, then refresh (local lazy-loads its model list;
    // ollama refreshes its model dropdown).
    api('POST', '/api/setup/llm', { provider })
      .then(() => {
        if (provider === 'local' && !state.localLoaded) loadLocalLLM();
        if (provider === 'ollama') refreshOllamaModels();
        return loadAll();  // refresh services_running banner
      })
      .catch((e) => {
        alert(t('set.llm.switch_failed') + ' — ' + (e.message || e));
      });
  }

  // ── Ollama panel ──────────────────────────────────────────────
  async function refreshOllamaModels() {
    const base = (els.ollamaUrl.value || 'http://localhost:11434').trim();
    els.ollamaStatus.textContent = t('set.ollama.checking');
    els.ollamaStatus.style.color = 'var(--muted)';
    try {
      const r = await api('GET', '/api/llm/ollama/models?base_url=' + encodeURIComponent(base));
      const models = r.models || [];
      const wanted = state._ollamaModelWanted || els.ollamaModel.value || '';
      els.ollamaModel.innerHTML = models
        .map((m) => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`).join('');
      if (wanted && models.includes(wanted)) els.ollamaModel.value = wanted;
      if (!r.ok) {
        els.ollamaStatus.textContent = t('set.ollama.unreachable');
        els.ollamaStatus.style.color = 'var(--danger)';
      } else {
        els.ollamaStatus.textContent = models.length
          ? t('set.ollama.found', { n: models.length }) : t('set.ollama.none');
        els.ollamaStatus.style.color = models.length ? 'var(--success)' : 'var(--warning)';
      }
    } catch (e) {
      els.ollamaStatus.textContent = t('set.ollama.unreachable');
      els.ollamaStatus.style.color = 'var(--danger)';
    }
  }

  async function saveOllama() {
    try {
      await api('POST', '/api/setup/llm/ollama', {
        base_url: (els.ollamaUrl.value || 'http://localhost:11434').trim(),
        model: els.ollamaModel.value || '',
      });
      window.toast?.(t('set.toast.saved'));
      await loadAll();
    } catch (e) { window.toast?.(t('set.toast.error', { msg: e.message }), 3500); }
  }

  // ── APIs section (OpenAI / Claude) ────────────────────────────
  // One "fournisseur + clé" form for both cloud providers. Model options
  // and the "key already set" placeholder follow the picked provider.
  const API_MODELS = {
    openai:     ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    anthropic:  ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest', 'claude-3-7-sonnet-latest'],
    // OpenRouter slugs (vendor/model) — a small curated spread across
    // vendors; the aggregator carries hundreds more. gemini-2.5-flash-lite
    // is the budget pick (~$0.10/$0.40 per M, reliable JSON mode + tools);
    // the paid nemotron-3-super is the open-weights alternative at the same
    // price point. Its :free variant is deliberately NOT listed — NVIDIA's
    // free endpoint logs usage to improve their products, and what this app
    // sends the model is the user's email content.
    openrouter: ['google/gemini-2.5-flash-lite', 'openai/gpt-4o-mini',
                 'anthropic/claude-3.5-haiku', 'nvidia/nemotron-3-super-120b-a12b',
                 'deepseek/deepseek-chat'],
  };

  function _apiCfg(provider) {
    // OpenAI key lives at config.openai (legacy layout); Claude and
    // OpenRouter under config.llm.<provider>. All mask a stored key
    // rather than echo it.
    const cfg = state.config || {};
    if (provider === 'openai') {
      const oa = cfg.openai || {};
      return { key: oa.api_key, model: oa.model || 'gpt-4o-mini' };
    }
    if (provider === 'openrouter') {
      const orc = (cfg.llm || {}).openrouter || {};
      return { key: orc.api_key, model: orc.model || 'openai/gpt-4o-mini' };
    }
    const an = (cfg.llm || {}).anthropic || {};
    return { key: an.api_key, model: an.model || 'claude-3-5-haiku-latest' };
  }

  function syncApiProviderUI() {
    if (!els.apiProvider) return;
    const provider = els.apiProvider.value;
    const { key, model } = _apiCfg(provider);
    const models = API_MODELS[provider] || [];
    els.apiModel.innerHTML = models
      .map((m) => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`).join('');
    els.apiModel.value = models.includes(model) ? model : (models[0] || '');
    // Never re-display a stored key — placeholder just signals it's set.
    els.apiKey.value = '';
    els.apiKey.placeholder = key ? t('set.ai.key_ph_set') : t('set.apis.key_ph');
  }

  async function saveApi() {
    const provider = els.apiProvider.value;
    const raw = els.apiKey.value.trim();
    const model = els.apiModel.value;
    // Empty field with a key already on file → MASK keeps it; empty with no
    // stored key → nothing to save.
    const hasStored = els.apiKey.placeholder === t('set.ai.key_ph_set');
    const api_key = raw !== '' ? raw : (hasStored ? MASK : '');
    if (!api_key) { window.toast?.(t('set.apis.need_key'), 3500); return; }
    setBusy(els.btnSaveApi, true, t('set.busy.saving'));
    try {
      if (provider === 'openai') {
        await api('POST', '/api/setup/openai', { api_key, model });
      } else if (provider === 'openrouter') {
        await api('POST', '/api/setup/llm/openrouter', { api_key, model });
      } else {
        await api('POST', '/api/setup/llm/anthropic', { api_key, model });
      }
      // Saving a cloud key makes that provider the active LLM backend.
      await api('POST', '/api/setup/llm', { provider });
      window.toast?.(t('set.toast.ai_on'));
      els.apiKey.value = '';
      window.dispatchEvent(new CustomEvent('ai-config-changed', { detail: { enabled: true } }));
      await loadAll();
    } catch (e) {
      window.toast?.(t('set.toast.error', { msg: e.message }), 3500);
    } finally {
      setBusy(els.btnSaveApi, false);
    }
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

    // ── IA — Provider tiles + sous-panneaux ───────────────────────
    const llmCfg = state.config.llm || { provider: 'openai' };
    const _validProv = ['openai', 'local', 'ollama', 'anthropic', 'openrouter'];
    const providerActive = _validProv.includes(llmCfg.provider) ? llmCfg.provider : 'openai';
    setActiveProvider(providerActive, { skipPersist: true });

    // Sous-panneau Ollama
    const ol = llmCfg.ollama || {};
    els.ollamaUrl.value = ol.base_url || 'http://localhost:11434';
    state._ollamaModelWanted = ol.model || '';
    if (providerActive === 'ollama') refreshOllamaModels();

    // ── APIs section (OpenAI / Claude) ────────────────────────────
    // Default the fournisseur dropdown to the active cloud provider when one
    // is active; otherwise leave it on OpenAI. syncApiProviderUI fills the
    // model list + "key set" placeholder for whatever's selected.
    if (els.apiProvider) {
      const cloudNames = { openai: 'OpenAI', anthropic: 'Claude', openrouter: 'OpenRouter' };
      const cloudActive = providerActive in cloudNames;
      els.apiProvider.value = cloudActive ? providerActive : 'openai';
      syncApiProviderUI();
      els.apiActiveNote.classList.toggle('hidden', !cloudActive);
      if (cloudActive) {
        els.apiActiveNote.textContent = t('set.apis.active_note', {
          name: cloudNames[providerActive],
        });
      }
    }

    // Sous-panneau Local — chargé à la demande la 1ère fois qu'on bascule.
    if (providerActive === 'local' && !state.localLoaded) {
      loadLocalLLM().catch((e) => console.error('loadLocalLLM:', e));
    }

    // ntfy
    const ntfy = state.config.ntfy || {};
    els.ntfySegOn.checked = !!ntfy.topic;
    els.ntfySegOff.checked = !ntfy.topic;
    _syncNtfySegActive();
    els.ntfyTopic.value = ntfy.topic || '';
    els.ntfyMin.value = ntfy.min_importance || 7;

    // General
    els.genInterval.value = (state.config.polling || {}).interval_minutes || 10;
    if (els.genInjection) {
      els.genInjection.value =
        ((state.config.security || {}).injection_scan || {}).mode || 'hybrid';
    }

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
  async function saveNtfy() {
    const enabled = els.ntfySegOn.checked;
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
    const injectionMode = els.genInjection?.value || 'hybrid';
    setBusy(els.btnSaveGn, true, t('set.busy.saving'));
    try {
      await api('POST', '/api/setup/general', {
        polling_interval_minutes: polling,
        injection_scan_mode: injectionMode,
      });
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

  // Dim + disable the AI rows that depend on the master "analyse this
  // account" toggle: threshold and auto-draft mean nothing while it is
  // off. Called on toggle AND on both modal-open paths, because a
  // programmatic `.checked =` never fires 'change'.
  function syncAiOptRows() {
    const on = !els.mAiEnabled || els.mAiEnabled.checked;
    host.querySelectorAll('#m-ai-opts [data-ai-dep]').forEach((row) => {
      row.classList.toggle('is-disabled', !on);
      row.querySelectorAll('input').forEach((inp) => { inp.disabled = !on; });
    });
  }

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
    // AI profile defaults (blank threshold = inherit global)
    if (els.mAiEnabled)   els.mAiEnabled.checked = true;
    if (els.mAiThreshold) els.mAiThreshold.value = '';
    if (els.mAutoDraft)   els.mAutoDraft.checked = false;
    syncAiOptRows();
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
    // AI profile (defaults preserve old behaviour when absent)
    if (els.mAiEnabled)   els.mAiEnabled.checked = acc.ai_account_enabled !== false;
    if (els.mAiThreshold) els.mAiThreshold.value = acc.ai_importance_threshold || '';
    if (els.mAutoDraft)   els.mAutoDraft.checked = !!acc.auto_draft;
    syncAiOptRows();

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
      // Per-account AI profile. Blank threshold → 0 = inherit global.
      ai_account_enabled: els.mAiEnabled ? els.mAiEnabled.checked : true,
      ai_importance_threshold: parseInt(els.mAiThreshold?.value, 10) || 0,
      auto_draft: els.mAutoDraft ? els.mAutoDraft.checked : false,
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

  function _syncNtfySegActive() {
    host.querySelectorAll('.set-notif-seg .set-prov-opt').forEach(opt => {
      const inp = opt.querySelector('input');
      opt.classList.toggle('is-active', !!(inp && inp.checked));
    });
  }

  // ── Wire events ──
  els.ntfySegOff?.addEventListener('change', _syncNtfySegActive);
  els.ntfySegOn?.addEventListener('change', _syncNtfySegActive);
  els.btnAdd.addEventListener('click', openModal);
  // APIs section — swap model list / key placeholder on provider change; save.
  els.apiProvider?.addEventListener('change', syncApiProviderUI);
  els.btnSaveApi?.addEventListener('click', saveApi);
  // Provider tiles — pick an on-device backend: show its panel + persist via /api/setup/llm.
  els.aiTiles?.querySelectorAll('.ai-tile').forEach((tile) => {
    tile.addEventListener('click', () => setActiveProvider(tile.dataset.provider));
  });
  host.querySelector('#ollama-refresh')?.addEventListener('click', refreshOllamaModels);
  host.querySelector('#btn-save-ollama')?.addEventListener('click', saveOllama);
  els.btnActivateLocal.addEventListener('click', activateLocal);
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

  // Wipe IA seul — moins destructif que le wipe global (les emails sont
  // gardés, seuls les champs analysés par l'IA sont remis à zéro). Au
  // prochain sync le scheduler retraitera tout via le provider actif.
  // Confirmation simple via window.confirm (pas de modal type-à-confirmer
  // — l'opération est réversible : re-faire un sync restaure tout).
  host.querySelector('#btn-wipe-ai')?.addEventListener('click', async () => {
    if (!window.confirm(t('set.storage.wipe_ai_confirm'))) return;
    const btn = host.querySelector('#btn-wipe-ai');
    setBusy(btn, true, t('set.busy.deleting'));
    try {
      const r = await api('POST', '/api/setup/wipe-ai-analyses', { confirm: 'SUPPRIMER' });
      window.toast?.(t('set.storage.wipe_ai_done', { count: r.reset_count || 0 }), 'ok');
    } catch (e) {
      window.toast?.(t('set.toast.load_failed', { msg: e.message }), 'err');
    } finally {
      setBusy(btn, false);
    }
  });
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

  // Export config — fetch the full config as JSON and download it.
  host.querySelector('#btn-export-config')?.addEventListener('click', async () => {
    const btn = host.querySelector('#btn-export-config');
    setBusy(btn, true, t('set.busy.loading'));
    try {
      const config = await api('POST', '/api/setup/export');
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'lull-mail-config.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      window.toast?.(t('set.toast.exported'), 'ok');
    } catch (e) {
      window.toast?.(t('set.toast.load_failed', { msg: e.message }), 'err');
    } finally {
      setBusy(btn, false);
    }
  });

  // Import config — pick a JSON file, then POST it to the backend.
  host.querySelector('#btn-import-config')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const btn = host.querySelector('#btn-import-config');
      setBusy(btn, true, t('set.busy.loading'));
      try {
        const text = await file.text();
        const config = JSON.parse(text);
        const r = await api('POST', '/api/setup/import', { config });
        window.toast?.(r.message || t('set.toast.imported'), 'ok');
      } catch (e) {
        window.toast?.(t('set.toast.load_failed', { msg: e.message }), 'err');
      } finally {
        setBusy(btn, false);
      }
    });
    input.click();
  });

  // ── Storage actions view swap ─────────────────────────────────────
  const viewMain = host.querySelector('#view-storage-main');
  const viewActions = host.querySelector('#view-storage-actions');
  function showActionsView(show) {
    viewMain?.classList.toggle('hidden', show);
    viewActions?.classList.toggle('hidden', !show);
  }
  host.querySelector('#btn-storage-actions')?.addEventListener('click', () => showActionsView(true));
  host.querySelector('#btn-storage-actions-back')?.addEventListener('click', () => showActionsView(false));
  // Provider tiles wire their own click handlers in render()
  els.mClose.addEventListener('click', closeModal);
  els.mCancel.addEventListener('click', closeModal);
  els.mAiEnabled?.addEventListener('change', syncAiOptRows);
  els.mTest.addEventListener('click', modalTest);
  els.mAdd.addEventListener('click', modalAdd);
  els.modal.addEventListener('click', e => { if (e.target === els.modal) closeModal(); });

  await loadAll().catch(e => window.toast?.(t('set.toast.load_failed', { msg: e.message }), 3500));

  // Cleanup callback for the router.
  return () => { _docTeardown.forEach((off) => off()); _docTeardown.length = 0; };
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
    /* Provider logo from /api/brand-logo, stacked over the lucide glyph.
       On 404 the delegated error handler removes the img and the glyph
       shows through. .set-svc must be a positioning context for it. */
    .set-svc { position: relative; }
    .set-svc-img {
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      object-fit: contain;
      padding: 5px;
      background: #fff;
      pointer-events: none;
    }

    /* Per-account AI options — structured rows: checkbox, label, hint,
       and the threshold input pinned right. Dependent rows dim while the
       master toggle is off. */
    .set-ai-opts { display: flex; flex-direction: column; gap: 8px; }
    .set-opt {
      display: flex; align-items: flex-start; gap: 11px;
      padding: 10px 12px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      cursor: pointer;
      transition: border-color 140ms ease, opacity 140ms ease;
    }
    .set-opt:hover { border-color: var(--accent); }
    .set-opt input[type="checkbox"] {
      margin-top: 2px;
      width: 15px; height: 15px;
      flex-shrink: 0;
      accent-color: var(--accent);
      cursor: pointer;
    }
    .set-opt-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .set-opt-label { font-size: 13px; font-weight: 600; color: var(--text); }
    .set-opt-hint { font-size: 12px; color: var(--muted); line-height: 1.45; }
    .set-opt-static { cursor: default; align-items: center; }
    .set-opt-static:hover { border-color: var(--border); }
    .set-opt-input { max-width: 84px; text-align: center; flex-shrink: 0; }
    .set-opt.is-disabled { opacity: 0.45; pointer-events: none; }

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
    .set-field--grow { flex: 1; min-width: 0; }
    .set-notif-fields-row {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-top: 10px;
    }
    .set-notif-fields-row .set-grid { min-width: 0; }

    .set-inline-save-row {
      display: flex; align-items: center; gap: 16px;
    }

    .set-actions--rail {
      margin-top: 0 !important; padding-top: 0 !important; border-top: none !important;
      border-left: 1px solid var(--border-2);
      padding-left: 16px;
      flex-shrink: 0;
      align-self: center;
    }
    .set-card--fill-body {
      min-height: 0;
    }
    .set-card--fill-body > :not(h3) {
      flex: 1;
      min-height: 0;
      width: 100%;
      display: flex;
      align-items: center;
    }
    .set-storage-body {
      display: flex;
      flex-direction: column;
      gap: 0;
      width: 100%;
      flex: 1;
      min-width: 0;
    }
    .set-storage-body .set-path { font-size: 12px; }
    .set-storage-body .set-hint { font-size: 10.5px; }
    .set-storage-field-wrap {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .set-actions-rail {
      flex-shrink: 0;
    }
    .set-actions-rail .mb-cta {
      white-space: nowrap;
      padding: 7px 11px;
      font-size: 12px;
    }
    /* ── View swap ── */
    .set-storage-view {
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex: 1;
    }
    .set-storage-view.hidden { display: none; }
    .set-storage-view__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 2px;
    }
    .set-storage-view__title {
      font-size: 11px; font-weight: 600; letter-spacing: 0.04em;
      text-transform: uppercase; color: var(--muted);
    }
    .set-storage-actions-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
    }
    .set-storage-actions-grid .mb-cta {
      justify-content: flex-start;
      padding: 8px 10px;
      font-size: 12px;
      border-radius: 8px;
      width: 100%;
    }
    .set-storage-actions-grid .mb-cta span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .set-storage-view__sep {
      border: none;
      height: 1px;
      background: var(--border-2);
      margin: 2px 0;
    }
    .set-storage-view > .set-btn-danger {
      justify-content: flex-start;
      padding: 8px 12px;
      font-size: 12px;
      border-radius: 8px;
      width: 100%;
    }

    .set-notif-seg .set-prov-opt {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 12px;
      min-width: 40px;
    }
    .set-notif-seg .set-prov-opt .set-notif-seg-ic,
    .set-notif-seg .set-prov-opt i,
    .set-notif-seg .set-prov-opt svg {
      width: 18px; height: 18px;
      stroke-width: 2.25;
    }

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

    /* ── Provider radio (OpenAI / Local) ──────────────────────────
       Pattern visuel : segmented control. Le label sélectionné est
       souligné par un fond accent ; les autres restent surface-2. */
    /* ── AI provider tiles ── */
    .ai-tiles {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;
      margin: 4px 0 6px;
    }
    /* Three tiles: Intégré / Ollama / APIs (the two cloud providers merged
       behind one tile whose sub-panel carries the fournisseur choice). */
    .ai-tiles--3 { grid-template-columns: repeat(3, 1fr); }
    .ai-tile {
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      padding: 12px 8px; cursor: pointer; text-align: center;
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border); border-radius: 12px;
      transition: border-color .14s, background .14s, box-shadow .14s;
    }
    .ai-tile:hover { border-color: var(--accent); background: var(--surface-2); }
    .ai-tile.is-active {
      border-color: var(--accent); background: var(--accent-soft);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }
    .ai-tile i { color: var(--muted); }
    .ai-tile.is-active i { color: var(--accent); }
    .ai-tile-name { font-size: 13px; font-weight: 600; }
    .ai-tile-sub { font-size: 11px; color: var(--muted); line-height: 1.2; }
    .ai-tile.is-active .ai-tile-sub { color: var(--accent); }
    @media (max-width: 560px) { .ai-tiles { grid-template-columns: repeat(2, 1fr); } }

    .set-provider-radio {
      display: inline-flex; padding: 3px;
      background: var(--surface-2); border-radius: 10px;
      border: 1px solid var(--border);
    }
    .set-provider-radio .set-prov-opt {
      position: relative; cursor: pointer;
      padding: 6px 14px; font-size: 13px; font-weight: 500;
      color: var(--muted); border-radius: 7px;
      transition: background 140ms ease, color 140ms ease;
    }
    .set-provider-radio .set-prov-opt:hover { color: var(--text); }
    .set-provider-radio .set-prov-opt input { position: absolute; opacity: 0; pointer-events: none; }
    .set-provider-radio .set-prov-opt:has(input:checked) {
      background: var(--accent); color: var(--accent-on);
    }
    /* Fallback pour les navigateurs sans :has — l'état est aussi piloté
       par une classe .is-active posée par le JS. */
    .set-provider-radio .set-prov-opt.is-active {
      background: var(--accent); color: var(--accent-on);
    }

    /* ── Sous-panneau LLM local ───────────────────────────────── */
    /* Bandeau matériel : chips au lieu d'une longue phrase qui wrap. */
    .set-llm-banner {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; margin-bottom: 14px;
      background: var(--surface-2); border-radius: 10px;
      border: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .set-hw-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 10px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 12.5px; font-weight: 500;
      color: var(--text);
      white-space: nowrap;
    }
    .set-hw-chip i, .set-hw-chip svg {
      color: var(--muted-2);
      flex-shrink: 0;
    }
    .set-hw-chip-muted { color: var(--muted); }
    .set-hw-chip-muted i, .set-hw-chip-muted svg { color: var(--muted); opacity: 0.7; }
    .set-hw-chip-tier {
      background: var(--accent-soft);
      border-color: color-mix(in oklab, var(--accent) 30%, transparent);
      color: var(--accent-ink);
      font-weight: 600;
    }
    [data-theme="dark"] .set-hw-chip-tier { color: var(--accent); }
    .set-hw-chip-tier i, .set-hw-chip-tier svg { color: var(--accent-ink); opacity: 1; }
    [data-theme="dark"] .set-hw-chip-tier i, [data-theme="dark"] .set-hw-chip-tier svg { color: var(--accent); }
    .set-hw-arrow {
      width: 13px; height: 13px;
      color: var(--muted); opacity: 0.55;
      flex-shrink: 0;
    }

    /* Groupes Analyseur / Rédacteur avec en-tête lisible.
       Compaction : gap réduit (10px au lieu de 16px), header serré contre
       la première ligne, padding/font sizes plus petits pour faire tenir
       3 cartes (Notifications / Sync / Storage) à droite. */
    .set-llm-models {
      display: flex; flex-direction: column; gap: 10px;
    }
    .set-llm-role-group {
      display: flex; flex-direction: column; gap: 4px;
    }
    .set-llm-role-header {
      display: flex; align-items: baseline; gap: 6px;
      margin: 2px 2px 2px;
      flex-wrap: wrap;
    }
    .set-llm-role-title {
      font-size: 11.5px; font-weight: 700;
      color: var(--text);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .set-llm-role-desc {
      font-size: 11.5px; color: var(--muted);
      font-weight: 400;
    }

    /* Carte modèle individuelle : grille radio + texte + action.
       Le label englobe l'input pour que cliquer n'importe où sélectionne. */
    .set-llm-model {
      display: grid; grid-template-columns: auto 1fr auto;
      align-items: center; gap: 11px;
      padding: 9px 11px;
      background: var(--surface-2); border-radius: 9px;
      border: 1px solid var(--border);
      cursor: pointer;
      transition: border-color 140ms ease, background 140ms ease;
    }
    .set-llm-model:hover:not(.disabled) {
      border-color: color-mix(in oklab, var(--accent) 35%, var(--border));
    }
    /* Sélection : fond légèrement teinté + bordure accent, sans box-shadow
       qui agressait l'œil. */
    .set-llm-model.is-selected {
      border-color: color-mix(in oklab, var(--accent) 55%, var(--border));
      background: color-mix(in oklab, var(--accent-soft) 22%, var(--surface-2));
    }
    .set-llm-model.disabled {
      opacity: 0.65;
      cursor: default;
    }

    /* Radio custom — accessible, gros, visible. */
    .set-llm-radio {
      appearance: none;
      -webkit-appearance: none;
      width: 18px; height: 18px;
      border: 2px solid var(--border);
      border-radius: 50%;
      background: var(--surface);
      cursor: pointer;
      margin: 0;
      flex-shrink: 0;
      transition: border-color 140ms ease, background 140ms ease;
      position: relative;
    }
    .set-llm-radio:hover:not(:disabled) { border-color: var(--accent); }
    .set-llm-radio:checked {
      border-color: var(--accent);
      background: var(--accent);
    }
    .set-llm-radio:checked::after {
      content: "";
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--surface);
    }
    .set-llm-radio:disabled { cursor: not-allowed; opacity: 0.5; }
    .set-llm-radio:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px var(--accent-soft);
    }

    .set-llm-model-info {
      display: flex; flex-direction: column; gap: 2px; min-width: 0;
    }
    .set-llm-model-line {
      display: flex; align-items: center; gap: 7px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .set-llm-model-name {
      font-size: 13.5px; font-weight: 600; color: var(--text);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .set-llm-model-sub {
      font-size: 11.5px; color: var(--muted);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    /* Pills inline (recommandé, téléchargé). Petits, calmes, scannables. */
    .set-llm-pill {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 10.5px; font-weight: 600;
      letter-spacing: 0.02em;
      flex-shrink: 0;
    }
    .set-llm-pill i, .set-llm-pill svg {
      width: 11px; height: 11px;
      stroke-width: 2.5;
    }
    .set-llm-pill-recommend {
      background: var(--accent-soft);
      color: var(--accent-ink);
    }
    [data-theme="dark"] .set-llm-pill-recommend { color: var(--accent); }
    .set-llm-pill-downloaded {
      background: color-mix(in oklab, var(--success) 14%, transparent);
      color: var(--success);
    }

    .set-llm-model-action {
      flex-shrink: 0;
    }
    .set-llm-btn {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 6px 11px;
      font-size: 12px; font-weight: 600;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 7px; color: var(--text); cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    }
    .set-llm-btn i, .set-llm-btn svg { flex-shrink: 0; }
    .set-llm-btn:hover { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-ink); }
    [data-theme="dark"] .set-llm-btn:hover { color: var(--accent); }
    .set-llm-btn.primary {
      background: var(--accent);
      color: var(--accent-on);
      border-color: var(--accent);
    }
    .set-llm-btn.primary:hover:not(:disabled) {
      filter: brightness(1.08);
      color: var(--accent-on);
    }
    .set-llm-btn:disabled {
      cursor: not-allowed;
      opacity: 0.45;
      background: var(--surface);
      color: var(--muted);
      border-color: var(--border);
    }
    .set-llm-btn.primary:disabled {
      /* override l'accent fill quand disabled pour donner un signal clair. */
      background: var(--surface);
      color: var(--muted);
    }
    .set-llm-btn.danger {
      padding: 6px 8px;
      color: var(--muted);
    }
    .set-llm-btn.danger:hover {
      background: color-mix(in oklab, var(--danger) 10%, transparent);
      border-color: var(--danger);
      color: var(--danger);
    }
    .set-llm-model.ram-warning {
      /* Bordure orange + fond légèrement teinté pour signaler que ce
         modèle va swapper sur la RAM système de l'utilisateur. */
      border-color: var(--warning);
      background: color-mix(in oklab, var(--warning) 6%, var(--surface-2));
    }
    .set-llm-ram-warning {
      display: flex; align-items: center; gap: 6px;
      margin-top: 6px; padding: 5px 8px;
      background: color-mix(in oklab, var(--warning) 12%, transparent);
      border-radius: 6px;
      font-size: 11px; color: var(--warning);
      font-weight: 500;
    }
    .set-llm-ram-warning i { flex-shrink: 0; }
    .set-llm-progress {
      width: 100%; height: 4px; border-radius: 2px;
      background: var(--surface); overflow: hidden;
      margin-top: 6px;
    }
    .set-llm-progress-bar {
      height: 100%; background: var(--accent);
      transition: width 200ms ease;
    }
    .set-llm-progress-text {
      font-size: 10px; color: var(--muted); margin-top: 2px;
    }
    .set-llm-footer {
      display: flex; justify-content: space-between; align-items: center;
      margin-top: auto; padding-top: 12px;
      border-top: 1px solid var(--border-2);
    }
    /* Bouton "Activer/Appliquer" en mode déjà-actif : signal vert
       passif au lieu de l'aspect "disabled gris" qui faisait croire à
       un bouton cassé. La main reste "default" pour signaler qu'aucune
       action n'est dispo. */
    #btn-activate-local.is-active-state {
      background: color-mix(in oklab, var(--success) 14%, transparent) !important;
      color: var(--success) !important;
      border: 1px solid color-mix(in oklab, var(--success) 35%, transparent) !important;
      opacity: 1 !important;
      cursor: default;
    }
    #btn-activate-local.is-active-state::before {
      content: "✓";
      margin-right: 6px;
      font-weight: 700;
    }
    /* Le panel local devient un flex-col qui remplit la card, pour que
       le footer (Activer + disque) reste ancré au bas même quand l'IA
       section est étirée par le grid-row: span 3. */
    #ai-panel-local:not(.hidden) {
      display: flex; flex-direction: column; flex: 1; min-height: 0;
    }
    #llm-models-list { flex: 0 0 auto; }

    /* Layout Settings : AI prend la colonne gauche pleine hauteur, et
       Notifications + Sync + Storage s'empilent à droite. Activé seulement
       quand on a 2 colonnes (≥ 721px) — en mobile, chaque card prend une
       row complète, span 3 n'aurait aucun sens. */
    @media (min-width: 721px) {
      #ai-section { grid-row: span 3; }
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
    .set-checks input[type="checkbox"] {
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
    .set-checks input[type="checkbox"]:hover {
      border-color: var(--accent);
    }
    .set-checks input[type="checkbox"]:checked {
      background: var(--accent);
      border-color: var(--accent);
    }
    .set-checks input[type="checkbox"]:checked::after {
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
    .set-checks input[type="checkbox"]:focus-visible {
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
