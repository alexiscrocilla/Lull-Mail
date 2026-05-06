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
  host.innerHTML = `
    <div class="dash">
      <div class="dash-head">
        <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
          <h1>Réglages</h1>
        </div>
      </div>

      <div id="set-banner" class="set-banner hidden"></div>

      <div class="dash-grid dash-grid--fill">
        <!-- Accounts -->
        <section class="card col-12">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="at-sign" class="w-4 h-4"></i>Boîtes mail
            </span>
            <button class="mb-cta" style="margin:0;padding:7px 12px;font-size:13px" id="btn-add-acc">
              <i data-lucide="plus" class="w-4 h-4"></i><span>Ajouter une boîte</span>
            </button>
          </h3>
          <div id="accounts-list" class="set-list">
            <div class="sub" style="font-style:italic">Chargement…</div>
          </div>
        </section>

        <!-- OpenAI -->
        <section class="card col-6">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="sparkles" class="w-4 h-4"></i>Intelligence artificielle
            </span>
          </h3>
          <div style="display:flex;align-items:center;gap:16px">
            <div class="set-grid" style="flex:1">
              <label class="set-field">
                <span class="set-label">Clé d'accès OpenAI</span>
                <input id="openai-key" type="password" class="set-input mono" placeholder="Saisissez une nouvelle clé pour la remplacer" autocomplete="new-password" />
                <span class="set-hint">Laissez vide pour conserver la clé actuelle.</span>
              </label>
              <label class="set-field">
                <span class="set-label">Modèle</span>
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
              <button class="mb-cta set-btn" id="btn-save-openai">Enregistrer</button>
            </div>
          </div>
        </section>

        <!-- Notifications -->
        <section class="card col-6">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="bell" class="w-4 h-4"></i>Notifications sur votre téléphone
            </span>
            <label class="set-toggle">
              <input id="ntfy-enabled" type="checkbox" />
              <span>M'avertir des emails importants</span>
            </label>
          </h3>
          <div style="display:flex;align-items:center;gap:16px;margin-top:10px">
            <div class="set-grid" style="flex:1">
              <label class="set-field">
                <span class="set-label">Code secret de notification</span>
                <input id="ntfy-topic" class="set-input mono" placeholder="lullmail-vous-x7k2p" />
                <span class="set-hint">À saisir dans l'application ntfy sur votre téléphone.</span>
              </label>
              <label class="set-field">
                <span class="set-label">Importance minimum</span>
                <input id="ntfy-min" type="number" min="1" max="10" class="set-input" />
                <span class="set-hint">De 1 (tout) à 10 (uniquement urgent).</span>
              </label>
            </div>
            <div class="set-actions" style="margin-top:0;padding-top:0;border-top:none;border-left:1px solid var(--border-2);padding-left:16px;flex-shrink:0">
              <button class="mb-cta set-btn" id="btn-save-ntfy">Enregistrer</button>
            </div>
          </div>
        </section>

        <!-- General -->
        <section class="card col-6">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="refresh-cw" class="w-4 h-4"></i>Vérification automatique
            </span>
          </h3>
          <div style="display:flex;align-items:center;gap:16px">
            <div class="set-grid" style="flex:1">
              <label class="set-field">
                <span class="set-label">Vérifier les nouveaux emails toutes les</span>
                <div style="display:flex;align-items:center;gap:8px">
                  <input id="general-interval" type="number" min="1" max="1440" class="set-input" style="max-width:72px" />
                  <span style="color:var(--muted);font-size:13px">minutes</span>
                </div>
                <span class="set-hint">Plus court = plus réactif, mais consomme un peu plus.</span>
              </label>
              <div class="set-field">
                <span class="set-label">État</span>
                <div id="set-services" class="set-status">…</div>
              </div>
            </div>
            <div class="set-actions" style="margin-top:0;padding-top:0;border-top:none;border-left:1px solid var(--border-2);padding-left:16px;flex-shrink:0">
              <button class="mb-cta set-btn" id="btn-save-general">Enregistrer</button>
            </div>
          </div>
        </section>

        <!-- Storage -->
        <section class="card col-6">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="hard-drive" class="w-4 h-4"></i>Stockage
            </span>
          </h3>
          <div style="display:flex;align-items:center;gap:16px">
            <div class="set-field" style="flex:1;min-width:0">
              <span class="set-label">Vos données sont enregistrées ici</span>
              <div id="set-data-dir" class="set-path mono">—</div>
              <span class="set-hint">Configuration, base de données et pièces jointes.</span>
            </div>
            <div class="set-actions" style="margin-top:0;padding-top:0;border-top:none;border-left:1px solid var(--border-2);padding-left:16px;flex-shrink:0;flex-direction:column;align-items:stretch">
              <button class="mb-cta set-btn-ghost" id="btn-open-data" type="button">
                <i data-lucide="folder-open" class="w-4 h-4"></i>
                <span>Ouvrir dans l'explorateur</span>
              </button>
              <button class="mb-cta set-btn-danger" id="btn-wipe-data" type="button">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
                <span>Supprimer mes données</span>
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
            Supprimer toutes vos données
          </h3>
          <button class="set-icon-btn" id="wipe-close" aria-label="Fermer">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>
        <!-- Warning banner -->
        <div style="background:color-mix(in oklab,var(--danger) 10%,transparent);border:1px solid color-mix(in oklab,var(--danger) 28%,transparent);border-radius:10px;padding:12px 14px;display:flex;gap:10px;align-items:flex-start">
          <i data-lucide="triangle-alert" style="width:15px;height:15px;flex-shrink:0;color:var(--danger);margin-top:1px"></i>
          <p style="margin:0;font-size:13px;color:var(--danger);line-height:1.5">
            Cette action est <strong>irréversible</strong>. Seront supprimés :
          </p>
        </div>

        <!-- What gets deleted -->
        <div style="display:flex;flex-direction:column;gap:6px;padding:4px 0">
          ${[
            ['key-round',   'Clé API OpenAI'],
            ['mail',        'Boîtes mail et identifiants'],
            ['sparkles',    'Emails analysés et résumés IA'],
            ['paperclip',   'Pièces jointes téléchargées'],
          ].map(([icon, label]) => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--surface-2);border-radius:8px">
            <i data-lucide="${icon}" style="width:14px;height:14px;flex-shrink:0;color:var(--muted)"></i>
            <span style="font-size:13px;color:var(--text)">${label}</span>
          </div>`).join('')}
        </div>

        <!-- Confirm input -->
        <label class="set-field" style="margin-bottom:0">
          <span class="set-label">Tapez <code class="mono" style="background:var(--surface-2);padding:1px 6px;border-radius:4px;font-size:11px">SUPPRIMER</code> pour confirmer</span>
          <input id="wipe-confirm-input" class="set-input mono" placeholder="SUPPRIMER" autocomplete="off" />
        </label>
        <div id="wipe-status" class="set-test-result" style="display:none;margin-top:4px"></div>
        <p class="set-hint" style="margin-top:2px">L'application redémarre automatiquement comme à la première installation.</p>

        <div class="set-modal-actions">
          <button class="mb-cta set-btn-ghost" id="wipe-cancel">Annuler</button>
          <button class="mb-cta set-btn-danger" id="wipe-confirm" disabled>
            <i data-lucide="trash-2" class="w-4 h-4"></i>
            <span>Supprimer définitivement</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Add / edit account modal -->
    <div id="set-modal" class="set-modal hidden">
      <div class="set-modal-card">
        <div class="set-modal-head">
          <h3 id="m-title">Ajouter une boîte mail</h3>
          <button class="set-icon-btn" id="m-close" aria-label="Fermer">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>

        <div class="set-field">
          <span class="set-label">Choisissez votre fournisseur</span>
          <div id="m-providers" class="m-providers"></div>
        </div>

        <div id="m-help" class="set-help hidden"></div>

        <div class="set-grid">
          <label class="set-field">
            <span class="set-label">Nom de la boîte</span>
            <input id="m-name" class="set-input" placeholder="Boulot, Perso, Asso…" />
          </label>
          <label class="set-field">
            <span class="set-label">Adresse email</span>
            <input id="m-email" type="email" class="set-input" placeholder="vous@exemple.com" />
          </label>
        </div>

        <label class="set-field">
          <div class="set-label-row">
            <span class="set-label">Mot de passe</span>
            <a id="m-app-pwd-link" class="set-quick-link hidden" target="_blank" rel="noopener" href="#">
              <i data-lucide="external-link" class="w-3 h-3"></i>
              <span>Créer un mot de passe d'application</span>
            </a>
          </div>
          <input id="m-password" type="password" class="set-input mono" autocomplete="new-password" placeholder="Votre mot de passe" />
        </label>

        <details class="set-advanced">
          <summary>Réglages techniques (rarement nécessaires)</summary>
          <div class="set-grid set-grid-3">
            <label class="set-field" style="grid-column: span 2">
              <span class="set-label">Serveur de réception</span>
              <input id="m-host" class="set-input" placeholder="imap.exemple.com" />
            </label>
            <label class="set-field">
              <span class="set-label">Port</span>
              <input id="m-port" type="number" class="set-input" placeholder="993" />
            </label>
          </div>
          <div class="set-checks">
            <label><input id="m-ssl" type="checkbox" /> Connexion sécurisée (SSL)</label>
            <label><input id="m-starttls" type="checkbox" /> Sécuriser après connexion</label>
            <label><input id="m-verify" type="checkbox" /> Vérifier le certificat</label>
          </div>
        </details>

        <div id="m-test-result" class="set-test-result"></div>

        <div class="set-modal-actions">
          <button class="mb-cta set-btn-ghost" id="m-cancel">Annuler</button>
          <button class="mb-cta set-btn-ghost" id="m-test">Vérifier que ça fonctionne</button>
          <button class="mb-cta set-btn" id="m-add">Ajouter</button>
        </div>
        <label id="m-enabled-row" class="set-toggle hidden" style="margin-top:8px">
          <input id="m-enabled" type="checkbox" checked />
          <span>Boîte active (vérification automatique)</span>
        </label>
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
    mTestRes: host.querySelector('#m-test-result'),
    mClose:   host.querySelector('#m-close'),
    mCancel:  host.querySelector('#m-cancel'),
    mTest:    host.querySelector('#m-test'),
    mAdd:     host.querySelector('#m-add'),
    mTitle:   host.querySelector('#m-title'),
    mEnabledRow: host.querySelector('#m-enabled-row'),
    mEnabled: host.querySelector('#m-enabled'),
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
        <span><strong>Pas encore prêt.</strong> Ajoutez au moins une boîte mail pour commencer.</span>`;
    } else if (!state.status.services_running) {
      els.banner.classList.remove('hidden');
      els.banner.dataset.tone = 'warn';
      els.banner.innerHTML = `<i data-lucide="alert-triangle" class="w-4 h-4"></i>
        <span><strong>La vérification automatique est en pause.</strong></span>
        <button class="set-banner-btn" id="set-restart">Reprendre</button>`;
      els.banner.querySelector('#set-restart').onclick = restart;
    } else {
      els.banner.classList.add('hidden');
    }

    // Services status indicator
    if (state.status.services_running) {
      els.services.innerHTML = `<span class="set-dot ok"></span>En cours`;
    } else if (state.status.configured) {
      els.services.innerHTML = `<span class="set-dot warn"></span>En pause`;
    } else {
      els.services.innerHTML = `<span class="set-dot warn"></span>Pas encore prêt`;
    }

    // Accounts
    const accounts = state.config.accounts || [];
    if (!accounts.length) {
      els.accList.innerHTML = `<div class="sub" style="font-style:italic">Aucune boîte mail. Cliquez sur « Ajouter une boîte » pour commencer.</div>`;
    } else {
      els.accList.innerHTML = accounts.map(a => `
        <div class="set-acc-row">
          <span class="set-svc" title="${escapeHtml(a.type || 'imap')}">${serviceLogoHtml(a)}</span>
          <div class="set-acc-info">
            <div class="set-acc-name">
              ${escapeHtml(a.name || a.email)}
              ${a.enabled === false ? '<span class="set-badge warn">en pause</span>' : ''}
            </div>
            <div class="set-acc-sub">${escapeHtml(a.email)}</div>
          </div>
          <div class="set-acc-actions">
            <button class="set-icon-btn" data-act="test" data-email="${escapeAttr(a.email)}" title="Vérifier que ça fonctionne">
              <i data-lucide="zap" class="w-4 h-4"></i>
            </button>
            <button class="set-icon-btn" data-act="edit" data-email="${escapeAttr(a.email)}" title="Modifier cette boîte">
              <i data-lucide="pencil" class="w-4 h-4"></i>
            </button>
            <button class="set-icon-btn danger" data-act="remove" data-email="${escapeAttr(a.email)}" title="Retirer cette boîte">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        </div>
      `).join('');
      els.accList.querySelectorAll('.set-icon-btn[data-act]').forEach(btn => {
        const act = btn.dataset.act;
        const email = btn.dataset.email;
        btn.addEventListener('click', () => {
          if (act === 'test')   return testExisting(email);
          if (act === 'edit')   return openModalForEdit(email);
          if (act === 'remove') return removeAccount(email);
        });
      });
    }

    // OpenAI
    const oa = state.config.openai || {};
    els.openaiKey.value = '';
    els.openaiKey.placeholder = oa.api_key ? '*** (laisser pour conserver)' : 'sk-…';
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
    setBusy(els.btnSaveOA, true, 'Enregistrement…');
    try {
      await api('POST', '/api/setup/openai', { api_key: key || MASK, model });
      window.toast?.('Clé enregistrée');
      els.openaiKey.value = '';
      await loadAll();
    } catch (e) { window.toast?.('Erreur : ' + e.message, 3500); }
    finally { setBusy(els.btnSaveOA, false); }
  }

  async function saveNtfy() {
    const enabled = els.ntfyEnabled.checked;
    const topic = els.ntfyTopic.value.trim();
    const min = parseInt(els.ntfyMin.value, 10) || 7;
    setBusy(els.btnSaveNt, true, 'Enregistrement…');
    try {
      await api('POST', '/api/setup/ntfy', {
        enabled, server: 'https://ntfy.sh', topic, min_importance: min,
      });
      window.toast?.('Préférences enregistrées');
      await loadAll();
    } catch (e) { window.toast?.('Erreur : ' + e.message, 3500); }
    finally { setBusy(els.btnSaveNt, false); }
  }

  async function saveGeneral() {
    const polling = parseInt(els.genInterval.value, 10) || 10;
    setBusy(els.btnSaveGn, true, 'Enregistrement…');
    try {
      await api('POST', '/api/setup/general', { polling_interval_minutes: polling });
      window.toast?.('Préférences enregistrées');
      await loadAll();
    } catch (e) { window.toast?.('Erreur : ' + e.message, 3500); }
    finally { setBusy(els.btnSaveGn, false); }
  }

  async function restart() {
    try {
      await api('POST', '/api/setup/finalize');
      window.toast?.('Vérification reprise');
      await loadAll();
    } catch (e) { window.toast?.('Erreur : ' + e.message, 3500); }
  }

  // ── Account modal ──
  // Per-provider hints used to make the form fields self-explanatory.
  // Keyed on provider.type (matches setup_api.py PROVIDERS).
  const PROVIDER_HINTS = {
    gmail:   { email: 'vous@gmail.com',     password: 'xxxx xxxx xxxx xxxx (mot de passe d\'application)' },
    outlook: { email: 'vous@outlook.com',   password: 'Mot de passe Microsoft ou mot de passe d\'application' },
    yahoo:   { email: 'vous@yahoo.com',     password: 'Mot de passe d\'application Yahoo (16 caractères)' },
    proton:  { email: 'vous@pm.me',         password: 'Mot de passe affiché par Proton Bridge' },
    orange:  { email: 'vous@orange.fr',     password: 'Votre mot de passe Orange' },
    ovh:     { email: 'vous@votre-domaine.fr', password: 'Mot de passe de votre boîte OVH' },
    icloud:  { email: 'vous@icloud.com',    password: 'Mot de passe pour app Apple' },
    free:    { email: 'vous@free.fr',       password: 'Votre mot de passe Free' },
    imap:    { email: 'vous@exemple.com',   password: 'Votre mot de passe IMAP' },
  };

  function openModal() {
    state.editingEmail = null;
    els.mTitle.textContent = 'Ajouter une boîte mail';
    els.mAdd.textContent = 'Ajouter';
    els.mEmail.disabled = false;
    els.mEnabledRow.classList.add('hidden');
    els.mEnabled.checked = true;
    els.modal.classList.remove('hidden');
    els.mName.value = '';
    els.mEmail.value = '';
    els.mPwd.value = '';
    els.mPwd.placeholder = 'Votre mot de passe';
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
    els.mTitle.textContent = 'Modifier la boîte mail';
    els.mAdd.textContent = 'Enregistrer';
    els.mEmail.disabled = true;  // email is the primary key — can't change it
    els.mEnabledRow.classList.remove('hidden');
    els.mEnabled.checked = acc.enabled !== false;

    // Pre-select the matching provider tile (by type)
    const matchingProvider = state.providers.find(p => p.type === acc.type) || state.providers.find(p => p.id === 'custom');
    if (matchingProvider) selectProvider(matchingProvider.id);

    // Override pre-filled values with the actual account
    els.mName.value = acc.name || '';
    els.mEmail.value = acc.email || '';
    els.mPwd.value = '';
    els.mPwd.placeholder = '••• laisser vide pour conserver';
    els.mHost.value = acc.imap_host || '';
    els.mPort.value = acc.imap_port || 993;
    els.mSsl.checked = !!acc.ssl;
    els.mStartTls.checked = !!acc.starttls;
    els.mVerify.checked = !!acc.verify_ssl;

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
      enabled: editing ? els.mEnabled.checked : true,
    };
  }

  function validateModal(acc) {
    if (!acc.email || !acc.email.includes('@')) return 'Adresse email invalide.';
    if (!acc.imap_host) return 'Serveur de réception manquant. Choisissez un fournisseur ou renseignez-le dans les réglages techniques.';
    // In edit mode, MASK in `password` means "keep what's saved" — that's fine.
    if (!acc.password) return 'Mot de passe requis.';
    return null;
  }

  async function modalTest() {
    const acc = readModal();
    const err = validateModal(acc);
    if (err) { els.mTestRes.innerHTML = `<span class="set-err">${err}</span>`; return; }
    setBusy(els.mTest, true, 'Test…');
    els.mTestRes.innerHTML = '';
    try {
      const r = await api('POST', '/api/setup/accounts/test', acc);
      els.mTestRes.innerHTML = r.ok
        ? `<span class="set-ok">✓ Tout fonctionne${r.mailbox_count ? ` — ${r.mailbox_count} dossiers détectés` : ''}</span>`
        : `<span class="set-err">✗ ${escapeHtml(r.error)}<div class="sub" style="margin-top:4px">${escapeHtml(r.detail || '')}</div></span>`;
    } catch (e) {
      els.mTestRes.innerHTML = `<span class="set-err">✗ ${escapeHtml(e.message)}</span>`;
    } finally { setBusy(els.mTest, false); }
  }

  async function modalAdd() {
    const acc = readModal();
    const err = validateModal(acc);
    if (err) { els.mTestRes.innerHTML = `<span class="set-err">${err}</span>`; return; }
    const editing = !!state.editingEmail;
    setBusy(els.mAdd, true, editing ? 'Enregistrement…' : 'Ajout…');
    try {
      if (editing) {
        await api('PUT', `/api/setup/accounts/${encodeURIComponent(state.editingEmail)}`, acc);
        window.toast?.(`${acc.email} mise à jour`);
      } else {
        await api('POST', '/api/setup/accounts', acc);
        window.toast?.(`${acc.email} ajoutée`);
      }
      closeModal();
      await loadAll();
      // Restart so polling picks up the new credentials / account changes.
      try { await api('POST', '/api/setup/finalize'); await loadAll(); } catch { /* tolerated */ }
    } catch (e) {
      els.mTestRes.innerHTML = `<span class="set-err">✗ ${escapeHtml(e.message)}</span>`;
    } finally { setBusy(els.mAdd, false); }
  }

  async function testExisting(email) {
    const acc = (state.config.accounts || []).find(a => a.email.toLowerCase() === email.toLowerCase());
    if (!acc) return;
    window.toast?.(`Test ${email}…`);
    try {
      const r = await api('POST', '/api/setup/accounts/test', { ...acc });
      window.toast?.(r.ok ? `✓ ${email} fonctionne` : `✗ ${email} — ${r.error}`, 3500);
    } catch (e) {
      window.toast?.('Erreur : ' + e.message, 3500);
    }
  }

  async function removeAccount(email) {
    if (!confirm(`Retirer la boîte ${email} ?\n(Les emails de cette boîte n'apparaîtront plus dans l'application.)`)) return;
    try {
      await api('DELETE', `/api/setup/accounts/${encodeURIComponent(email)}`);
      window.toast?.(`${email} retirée`);
      await loadAll();
    } catch (e) { window.toast?.('Erreur : ' + e.message, 3500); }
  }

  // ── Wire events ──
  els.btnAdd.addEventListener('click', openModal);
  els.btnSaveOA.addEventListener('click', saveOpenAI);
  els.btnSaveNt.addEventListener('click', saveNtfy);
  els.btnSaveGn.addEventListener('click', saveGeneral);
  host.querySelector('#btn-open-data')?.addEventListener('click', async () => {
    try {
      await api('POST', '/api/setup/open-data-dir');
    } catch (e) { window.toast?.('Erreur : ' + e.message, 3500); }
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
    setBusy(wipeBtn, true, 'Suppression…');
    setWipeStatus('');
    try {
      const r = await api('POST', '/api/setup/wipe', { confirm: 'SUPPRIMER' });
      if (r.failed && r.failed.length) {
        setWipeStatus(`<span style="color:var(--warning)">⚠ Certains fichiers n'ont pas pu être supprimés : ${r.failed.map(escapeHtml).join(', ')}.</span>`);
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

  await loadAll().catch(e => window.toast?.('Chargement échoué : ' + e.message, 3500));

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
    .set-checks {
      display: flex; gap: 16px; flex-wrap: wrap;
      margin-top: 10px; font-size: 12px; color: var(--muted);
    }
    .set-checks label {
      display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    }
    .set-test-result { font-size: 12px; min-height: 18px; }
    .set-test-result .set-ok { color: var(--success); font-weight: 600; }
    .set-test-result .set-err { color: var(--danger); font-weight: 600; }

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
