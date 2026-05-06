import {
  api,
  avatarColor, initials, senderName, senderEmail,
  avatarImgHtml,
  shortDate, longDate, escapeHtml, linkify, isHomographUrl, safeLinkUrl,
  CATEGORY_LABEL, CATEGORY_COLOR, scoreClass,
} from '/static/api.js';
import { rewriteRemoteImages, senderDomain } from '/static/image-blocker.js';

// Build the HTML <body> block for an email — sandboxed iframe with the
// remote-image blocker applied unless the sender is trusted. Includes a
// banner above the iframe when images were stripped.
//
// `em` must carry `body_html`, `sender`, `sender_domain` and
// `sender_images_trusted` (the last three are emitted by /api/emails/{id}).
// `forceShowImages` skips the blocker just for this render — used by the
// "Charger pour ce mail" button without touching the DB.
function buildHtmlBodyBlock(em, forceShowImages = false) {
  // The image-blocker styles render any <img data-blocked-src=…> as a
  // soft grey rectangle with a tiny "image" icon in the centre. The
  // image keeps whatever dimensions the email designer set (so a
  // 600×400 banner still occupies its slot — no layout collapse), but
  // the empty space is now obviously a placeholder, not a render bug.
  // Same treatment for [data-blocked-style] so background-image slots
  // get a faint grey wash instead of an invisible nothing.
  //
  // Inline SVG as a data URI keeps the iframe self-contained (no
  // extra HTTP requests, defeats the purpose of blocking otherwise).
  // IMPORTANT: keep the SVG source with literal '#' for colour values —
  // encodeURIComponent turns '#' into '%23' which is what CSS data URIs
  // expect. Pre-encoding (%23666) would be doubly encoded by encode-
  // URIComponent (%2523666) and the browser would render an invalid
  // colour, leaving the placeholder transparent.
  const PLACEHOLDER_ICON = "data:image/svg+xml;utf8,"
    + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" '
      + 'viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="1.5" '
      + 'stroke-linecap="round" stroke-linejoin="round">'
      + '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>'
      + '<circle cx="9" cy="9" r="2"/>'
      + '<path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>'
      + '</svg>'
    );
  const INJECT = `<style>
    html,body{margin:0;padding:8px;overflow-x:hidden!important;box-sizing:border-box;word-break:break-word;}
    img,video{max-width:100%!important;height:auto!important;}
    table{max-width:100%!important;table-layout:fixed!important;}
    td,th{word-break:break-word;}
    /* Image-blocker placeholder. The JS has already classified each
       image into one of three buckets (tracker / hero / normal) and
       set the right dimensions; the CSS just paints the visual.
       Tracking pixels are hidden outright. The chosen #cbd5e1 /
       #6b7280 pair reads as a dim grey on white email bodies AND as
       a brighter grey on the rare dark bodies, so it stays visible
       either way (we deliberately do not honour the system
       prefers-color-scheme — most emails are white regardless). */
    img[data-blocked-tracker]{ display: none !important; }
    img[data-blocked-src]:not([data-blocked-tracker]){
      background-color: #cbd5e1 !important;
      background-image: url("${PLACEHOLDER_ICON}") !important;
      background-repeat: no-repeat !important;
      background-position: center !important;
      background-size: 24px 24px !important;
      border: 1px dashed #6b7280 !important;
      border-radius: 4px !important;
      /* Some emails set object-fit/object-position on imgs which
         hides the background — neutralise. */
      object-fit: fill !important;
    }
    [data-blocked-style]{
      background-color: #cbd5e1 !important;
      background-image: none !important;
      border: 1px dashed #6b7280 !important;
      border-radius: 4px !important;
    }
  </style>`;

  // 1. Anti-phishing link rewriting (Lot A).
  let safeHtml = markSuspiciousLinksInHtml(em.body_html);

  // 2. Remote-image blocker (Lot D). Skipped when the user previously
  //    trusted the sender or just clicked "Charger pour ce mail".
  let blockedCount = 0;
  const trusted = !!em.sender_images_trusted;
  if (!trusted && !forceShowImages) {
    const out = rewriteRemoteImages(safeHtml);
    safeHtml = out.html;
    blockedCount = out.blockedCount;
  }

  // 3. Inject our reset CSS and serialise.
  const finalHtml = safeHtml.replace(/<head([^>]*)>/i, `<head$1>${INJECT}`)
                            || (INJECT + safeHtml);

  // SECURITY: no `allow-scripts`. Email JavaScript never runs.
  // `allow-popups` keeps `<a target="_blank">` opening in a new tab;
  // `allow-popups-to-escape-sandbox` lets that tab inherit a normal
  // (non-sandboxed) context so the OS browser handler can pick the
  // link up cleanly.
  const iframe = `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${escapeHtml(finalHtml)}" class="mb-body-iframe"></iframe>`;

  // Banner only when we actually blocked something. The two buttons
  // are wired up by attachImageBlockerHandlers() right after the
  // iframe is injected into the DOM.
  if (!blockedCount) return iframe;

  const domain = em.sender_domain || senderDomain(em.sender) || '';
  const label = blockedCount === 1
    ? '1 image distante bloquée'
    : `${blockedCount} images distantes bloquées`;
  const banner = `
    <div class="mb-img-banner" data-int-id="${escapeHtml(String(em.int_id))}" data-sender-domain="${escapeHtml(domain)}">
      <i data-lucide="image-off" class="w-4 h-4"></i>
      <span class="mb-img-banner-label">${label}</span>
      <span class="mb-img-banner-spacer"></span>
      <button class="mb-img-banner-btn" data-act="show-once" type="button">
        Charger pour ce mail
      </button>
      <button class="mb-img-banner-btn mb-img-banner-btn-trust" data-act="trust-sender" type="button" ${domain ? '' : 'disabled'}>
        Toujours pour ${domain ? escapeHtml(domain) : 'cet expéditeur'}
      </button>
    </div>`;
  return banner + iframe;
}


// Wire up the banner buttons after the iframe has been mounted. Called
// from the same place that mounts the read pane. The closure keeps a
// reference to `em` so we can re-render on demand.
function attachImageBlockerHandlers(em) {
  const banner = document.querySelector('#read-pane .mb-img-banner');
  if (!banner) return;

  const reRender = (forceShow) => {
    // The body block currently consists of the banner + the iframe
    // immediately after it. Insert the freshly-built block before the
    // banner, then drop both old elements. Same DOM position, no
    // visible reflow.
    const oldIframe = banner.nextElementSibling;
    banner.insertAdjacentHTML('beforebegin', buildHtmlBodyBlock(em, forceShow));
    if (oldIframe) oldIframe.remove();
    banner.remove();
    const pane = document.querySelector('#read-pane');
    if (pane) window.lucide?.createIcons({ el: pane });
    // Re-attach handlers on the new banner (if any). When forceShow
    // is true the new build has no banner, so this no-ops.
    attachImageBlockerHandlers(em);
  };

  banner.querySelector('[data-act="show-once"]')?.addEventListener('click', () => {
    reRender(true);
  });

  banner.querySelector('[data-act="trust-sender"]')?.addEventListener('click', async () => {
    const domain = banner.dataset.senderDomain || '';
    if (!domain) return;
    try {
      // The shared `api` import is an object of pre-built methods, not
      // a generic POST helper — call /api/senders/.../images-trusted
      // directly via fetch. Mirrors the pattern used elsewhere when no
      // dedicated method exists yet.
      const r = await fetch(
        `/api/senders/${encodeURIComponent(domain)}/images-trusted`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trusted: true }),
        },
      );
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      em.sender_images_trusted = true;
      reRender(false);  // forceShow=false but trusted=true → blocker skipped
      window.toast?.(`Images activées pour ${domain}`, 2500);
    } catch (e) {
      window.toast?.('Erreur : ' + e.message, 3500);
    }
  });
}


// Render the SPF/DKIM/DMARC verdict badge next to the sender name.
// `auth_results` is the JSON string captured at ingest by
// src/auth_results.py. Roll-up colour:
//   green   → all three pass
//   amber   → mixed (some pass, some none/neutral)
//   red     → at least one fail / softfail / policy
//   grey    → no Authentication-Results header
function authBadgeHtml(authJson) {
  let data = null;
  try { data = authJson ? JSON.parse(authJson) : null; } catch (_) {}
  const verdicts = data ? Object.entries(data).filter(([_, v]) => v) : [];
  let kind, icon, label, tooltip;
  if (!verdicts.length) {
    kind = 'unknown';
    icon = 'help-circle';
    label = 'non vérifié';
    tooltip = 'Aucun en-tête Authentication-Results trouvé sur ce mail.';
  } else {
    const allPass = verdicts.every(([_, v]) => v === 'pass');
    const anyBad = verdicts.some(([_, v]) => v === 'fail' || v === 'softfail' || v === 'policy');
    if (anyBad) {
      kind = 'fail';
      icon = 'shield-x';
      label = 'authentification échouée';
    } else if (allPass) {
      kind = 'pass';
      icon = 'shield-check';
      label = 'authentifié';
    } else {
      kind = 'warn';
      icon = 'shield-alert';
      label = 'authentification partielle';
    }
    tooltip = verdicts
      .map(([m, v]) => `${m.toUpperCase()}: ${v}`)
      .join(' · ');
  }
  return `<span class="mb-auth-badge mb-auth-${kind}" title="${escapeHtml(tooltip)}">
    <i data-lucide="${icon}" class="w-3 h-3"></i>
    <span>${escapeHtml(label)}</span>
  </span>`;
}


// Walk every <a> in the email HTML and tag it visually when its href looks
// like a homograph spoof (Cyrillic/Greek in the host) or already arrived in
// punycode form (xn--…). The iframe is sandboxed without `allow-scripts`,
// so external CSS would never apply — we set inline style + a title for the
// hover tooltip. Same heuristic as on plain-text bodies via linkify.
function markSuspiciousLinksInHtml(html) {
  if (!html) return html;
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch (_) {
    return html;
  }
  const anchors = doc.querySelectorAll('a[href]');
  let flagged = 0;
  anchors.forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) return;
    if (!isHomographUrl(href)) return;
    flagged += 1;

    // Click target is the server-rendered interstitial. The browser will
    // open it in the same way the original link wanted (target=_blank
    // since allow-popups is on). The interstitial then explains the risk
    // and lets the user choose to continue. Server side: src/safe_link.py.
    a.setAttribute('href', safeLinkUrl(href));
    // Force new-tab so the warning page replaces the iframe-targeted nav
    // (otherwise a `target="_self"` link would try to navigate the
    // sandboxed iframe itself, which is hostile UX).
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');

    // Inline style because the iframe srcdoc has no access to our stylesheet.
    const prev = a.getAttribute('style') || '';
    a.setAttribute('style',
      `${prev}${prev && !prev.endsWith(';') ? ';' : ''}` +
      'color:#b91c1c !important;background:rgba(220,38,38,0.08);' +
      'border-bottom:2px dotted #b91c1c;padding:0 2px;border-radius:2px;' +
      'text-decoration:none !important;'
    );
    const prevTitle = a.getAttribute('title');
    if (!prevTitle) {
      a.setAttribute('title',
        'Domaine suspect — un avertissement s\'affichera avant l\'ouverture'
      );
    }
  });
  return flagged > 0 ? doc.documentElement.outerHTML : html;
}

const FOLDERS = [
  { id: 'inbox',     label: 'Inbox',     icon: 'inbox' },
  { id: 'sent',      label: 'Envoyés',   icon: 'send' },
  { id: 'favourite', label: 'Favoris',   icon: 'star' },
  { id: 'draft',     label: 'Brouillons',icon: 'pencil' },
  { id: 'deleted',   label: 'Supprimés', icon: 'trash-2' },
];

const LABELS = [
  { id: 'important',     label: 'Important',     color: '#FCA5A5' },
  { id: 'transactional', label: 'Transactionnel',color: '#86EFAC' },
  { id: 'newsletter',    label: 'Newsletter',    color: '#93C5FD' },
  { id: 'other',         label: 'Autre',         color: '#C4B5FD' },
  { id: 'pending',       label: 'En attente',    color: '#FCD34D' },
  { id: 'spam',          label: 'Spam',          color: '#CBD5E1' },
];

// Sous-catégories par fournisseur — ordre d'affichage + couleur identifiante.
const ACCOUNT_TYPE_META = {
  proton: { label: 'Proton Mail', color: '#6D4AFF' },
  gmail:  { label: 'Gmail',       color: '#EA4335' },
  orange: { label: 'Orange',      color: '#FF7900' },
  ovh:    { label: 'OVH',         color: '#123F6D' },
  other:  { label: 'Autres',      color: '#94A3B8' },
};
const ACCOUNT_TYPE_ORDER = ['proton', 'gmail', 'orange', 'ovh', 'other'];

export async function mountMailbox(host, _opts) {
  host.innerHTML = `
    <section class="mailbox no-selection" aria-label="Boîte de réception">
      <aside class="mb-side" aria-label="Navigation latérale">
        <div class="mb-side-head">
          <h1>Boîte mail</h1>
          <button class="icon-btn" id="btn-sync" aria-label="Synchroniser" title="Synchroniser">
            <i data-lucide="refresh-cw" class="w-4 h-4"></i>
          </button>
        </div>
        <button class="mb-cta" id="cta-compose">
          <i data-lucide="mail-plus" class="w-4 h-4"></i>
          <span>Nouveau message</span>
        </button>

        <div class="mb-side-scroll">

        <div class="mb-section-title" id="title-folders">
          <span>Dossiers</span>
          <svg class="mb-collapse-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
        <div class="mb-collapsible" id="wrap-folders">
          <div class="mb-collapsible-inner">
            <div class="mb-section" id="mb-folders"></div>
          </div>
        </div>

        <div class="mb-section-title" id="title-labels">
          <span>Étiquettes</span>
          <div style="display:flex;align-items:center;gap:4px">
            <button class="icon-btn" style="width:24px;height:24px" data-toast="Étiquettes personnelles : bientôt" aria-label="Ajouter une étiquette" onclick="event.stopPropagation()">
              <i data-lucide="plus" class="w-4 h-4"></i>
            </button>
            <svg class="mb-collapse-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
        </div>
        <div class="mb-collapsible" id="wrap-labels">
          <div class="mb-collapsible-inner">
            <div class="mb-section" id="mb-labels"></div>
          </div>
        </div>

        <div id="mb-accounts-wrap"></div>

        </div><!-- /.mb-side-scroll -->
      </aside>

      <div class="mb-list-wrap">
        <div class="mb-search">
          <div class="mb-search-input">
            <i data-lucide="search" class="icn w-4 h-4"></i>
            <input type="text" id="search" data-role="search" placeholder="Rechercher dans les mails…" aria-label="Recherche" />
          </div>
          <div class="mb-chips" id="filter-chips"></div>
          <div class="sort-select" id="sort-select-wrap"></div>
        </div>
        <div class="mb-sel-bar" id="sel-bar" hidden>
          <div class="sel-left">
            <button class="sel-btn" data-act="clear" title="Annuler la sélection" aria-label="Annuler la sélection">
              <i data-lucide="x" class="w-4 h-4"></i>
            </button>
            <span class="sel-count"><strong id="sel-count-num">0</strong> sélectionné(s)</span>
            <button class="sel-btn sel-btn-all" id="sel-all-btn" data-act="select-all" title="Tout sélectionner" aria-label="Tout sélectionner">
              <i data-lucide="check-square" class="w-4 h-4"></i>
              <span id="sel-all-label">Tout</span>
            </button>
          </div>
          <div class="sel-actions">
            <button class="sel-btn" id="sel-btn-read" data-act="read" title="Marquer comme lu" aria-label="Marquer comme lu">
              <i data-lucide="mail-open" class="w-4 h-4"></i>
            </button>
            <button class="sel-btn" data-act="tag" title="Étiqueter" aria-label="Étiqueter">
              <i data-lucide="tag" class="w-4 h-4"></i>
            </button>
            <button class="sel-btn" data-act="move" title="Déplacer" aria-label="Déplacer">
              <i data-lucide="folder-input" class="w-4 h-4"></i>
            </button>
            <button class="sel-btn" data-act="ai" title="Analyser avec l'IA" aria-label="Analyser avec l'IA">
              <i data-lucide="sparkles" class="w-4 h-4"></i>
            </button>
            <div class="sel-sep"></div>
            <button class="sel-btn danger" data-act="delete" title="Supprimer" aria-label="Supprimer">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        </div>
        <div class="mb-list" id="email-list" role="list"></div>
      </div>

      <div class="mb-read" id="read-pane"></div>
    </section>
  `;

  const SORT_OPTIONS = [
    { value: 'date-desc', label: 'Plus récent',   short: 'Récent ↓' },
    { value: 'date-asc',  label: 'Plus ancien',   short: 'Ancien ↑' },
    { value: 'score',     label: 'Par importance', short: 'Importance' },
    { value: 'sender',    label: 'Expéditeur A–Z', short: 'Expéditeur' },
  ];

  const state = {
    folder: 'inbox',
    category: '',     // '' = all
    query: '',
    onlyUnread: false,
    onlyReply: false,
    accountFilters: new Set(),  // empty = all accounts
    sortMode: 'date-desc',
    accounts: [],
    accountStats: {},           // email → { unread, needs_reply, total }
    emails: [],
    selectedId: null,
    selectedIds: new Set(),  // ids currently checked (avatar-click)
    filteredIds: [],  // current visible ids in order
  };

  const $ = (sel) => host.querySelector(sel);

  // ── Collapsible sidebar sections ──────────────────────────
  function initCollapsible(titleEl, wrapEl, storageKey) {
    if (!titleEl || !wrapEl) return;
    const collapsed = localStorage.getItem(storageKey) === '1';
    if (collapsed) {
      wrapEl.classList.add('is-collapsed');
      titleEl.classList.add('is-collapsed');
    }
    titleEl.addEventListener('click', (e) => {
      if (e.target.closest('button')) return; // don't collapse on icon-btn clicks
      const now = wrapEl.classList.toggle('is-collapsed');
      titleEl.classList.toggle('is-collapsed', now);
      localStorage.setItem(storageKey, now ? '1' : '0');
    });
  }

  // ── Render: folders + labels ──────────────────────────────
  function renderFolders() {
    const cont = $('#mb-folders');
    cont.innerHTML = FOLDERS.map((f) => `
      <button class="mb-folder ${state.folder === f.id ? 'active' : ''}" data-folder="${f.id}">
        <i data-lucide="${f.icon}" class="w-4 h-4"></i>
        <span class="lab">${f.label}</span>
        ${f.id === 'inbox' ? `<span class="badge" id="badge-inbox">…</span>` : ''}
      </button>
    `).join('');
    cont.querySelectorAll('.mb-folder').forEach((b) => {
      b.addEventListener('click', () => {
        const folder = b.dataset.folder;
        // Sent/Draft require an outgoing-mail flow that doesn't exist yet.
        if (folder === 'sent' || folder === 'draft') {
          window.toast('Dossier : bientôt');
          return;
        }
        if (folder === state.folder) return;
        state.folder = folder;
        renderEmpty();
        clearSelection();
        renderFolders();
        loadEmails();
      });
    });
  }

  function renderLabels() {
    const cont = $('#mb-labels');
    cont.innerHTML = `
      <button class="mb-label ${state.category === '' ? 'active' : ''}" data-cat="">
        <span class="dot" style="background:var(--muted-2)"></span>
        <span class="lab">Toutes</span>
      </button>
    ` + LABELS.map((l) => `
      <button class="mb-label ${state.category === l.id ? 'active' : ''}" data-cat="${l.id}">
        <span class="dot" style="background:${l.color}"></span>
        <span class="lab">${l.label}</span>
      </button>
    `).join('');
    cont.querySelectorAll('.mb-label').forEach((b) => {
      b.addEventListener('click', () => {
        state.category = b.dataset.cat;
        renderLabels();
        loadEmails();
      });
    });
  }

  let _sortDropCleanup = null;

  /**
   * Lightweight in-place sync of account button active states.
   * Called on every click so we never rebuild the DOM — just toggle classes.
   */
  function _syncAccountActive(section) {
    if (!section) section = $('#mb-accounts-list');
    if (!section) return;
    const allSelected = state.accountFilters.size === 0;
    section.querySelectorAll('[data-acc]').forEach((b) => {
      const acc = b.dataset.acc;
      const isActive = acc === '' ? allSelected : state.accountFilters.has(acc);
      b.classList.toggle('active', isActive);
      // Keep badge accent in sync when the account is selected/deselected
      const badge = b.querySelector('.mb-acc-badge');
      if (badge && !badge.classList.contains('error')) {
        badge.classList.toggle('on-active', isActive);
      }
    });
    // Sync subsection titles' has-active / all-active hints
    section.querySelectorAll('[data-sub-type]').forEach((titleEl) => {
      const type = titleEl.dataset.subType;
      const groupBtns = section.querySelectorAll(`[data-sub-wrap] [data-acc]`);
      const emails = [...section.querySelectorAll(
        `.mb-acc-group[data-type="${type}"] [data-acc]:not([data-acc=""])`
      )].map((b) => b.dataset.acc);
      if (!emails.length) return;
      const anyOn = emails.some((e) => state.accountFilters.has(e));
      const allOn = emails.every((e) => state.accountFilters.has(e));
      titleEl.classList.toggle('has-active', anyOn && state.accountFilters.size > 0);
      titleEl.classList.toggle('all-active', allOn && state.accountFilters.size > 0);
    });
  }

  function renderAccounts() {
    const outerWrap = $('#mb-accounts-wrap');
    if (!outerWrap) return;
    if (!state.accounts.length) { outerWrap.innerHTML = ''; return; }

    const chevSvg = `<svg class="mb-collapse-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

    // Build the stable shell once — keeps the collapsible wrapper intact across re-renders.
    // On first creation we hide the elements (opacity:0) so they can't flash before the
    // staggered intro animation runs from the requestAnimationFrame block at mount time.
    let shellCreatedNow = false;
    if (!$('#wrap-accounts')) {
      shellCreatedNow = true;
      outerWrap.innerHTML = `
        <div class="mb-section-title" id="title-accounts" style="opacity:0">
          <span>Comptes</span>${chevSvg}
        </div>
        <div class="mb-collapsible" id="wrap-accounts">
          <div class="mb-collapsible-inner">
            <div class="mb-section" id="mb-accounts-list"></div>
          </div>
        </div>
      `;
      initCollapsible($('#title-accounts'), $('#wrap-accounts'), 'sb-accounts');
    }

    // Only update the items list — no DOM destruction of the wrapper
    const allSelected = state.accountFilters.size === 0;
    const section = $('#mb-accounts-list');
    const hideStyle = shellCreatedNow ? ' style="opacity:0"' : '';

    // Group accounts by provider type (proton / gmail / orange / ovh / other)
    const byType = {};
    for (const a of state.accounts) {
      const t = ACCOUNT_TYPE_META[a.type] ? a.type : 'other';
      (byType[t] = byType[t] || []).push(a);
    }
    const typesPresent = ACCOUNT_TYPE_ORDER.filter((t) => byType[t]?.length);
    for (const t of Object.keys(byType)) {
      if (!typesPresent.includes(t)) typesPresent.push(t);
    }

    const subChevSvg = `<svg class="mb-collapse-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

    const groupsHtml = typesPresent.map((type) => {
      const meta = ACCOUNT_TYPE_META[type] || ACCOUNT_TYPE_META.other;
      const accs = byType[type];
      const groupEmails = accs.map((a) => a.email);
      const anySelected = state.accountFilters.size > 0
        && groupEmails.some((e) => state.accountFilters.has(e));
      const allInGroup = state.accountFilters.size > 0
        && groupEmails.every((e) => state.accountFilters.has(e));
      const subKey = `sb-accounts-${type}`;
      const collapsed = localStorage.getItem(subKey) === '1';
      const groupUnread = accs.reduce((sum, a) => sum + (state.accountStats[a.email]?.unread ?? 0), 0);

      const items = accs.map((a) => {
        const col = avatarColor(a.email);
        const ini = initials(a.name || a.email);
        const isOn = state.accountFilters.has(a.email);
        const stats = state.accountStats[a.email];
        const unread = stats?.unread ?? 0;
        const hasError = Boolean(stats?.sync_error);
        const badgeHtml = hasError
          ? `<span class="mb-acc-badge error" title="${escapeHtml(stats.sync_error || 'Erreur de synchronisation')}">!</span>`
          : `<span class="mb-acc-badge ${isOn ? 'on-active' : ''}">${unread}</span>`;
        return `
          <button class="mb-folder mb-acc-item ${isOn ? 'active' : ''}"${hideStyle} data-acc="${escapeHtml(a.email)}">
            <span class="mb-acc-av" style="background:${col}">${escapeHtml(ini)}</span>
            <span class="lab">${escapeHtml(a.name || a.email)}</span>
            ${badgeHtml}
          </button>`;
      }).join('');

      return `
        <div class="mb-acc-group" data-type="${escapeHtml(type)}">
          <div class="mb-subsection-title ${collapsed ? 'is-collapsed' : ''} ${anySelected ? 'has-active' : ''} ${allInGroup ? 'all-active' : ''}"${hideStyle} data-sub-toggle="${escapeHtml(subKey)}" data-sub-type="${escapeHtml(type)}" title="Replier / déplier · Maj+clic pour ne garder que ce groupe">
            <span class="mb-acc-type-dot" style="background:${meta.color}"></span>
            <span class="mb-acc-type-lab">${escapeHtml(meta.label)}</span>
            ${groupUnread > 0 ? `<span class="mb-acc-type-count">${groupUnread}</span>` : ''}
            ${subChevSvg}
          </div>
          <div class="mb-collapsible mb-subcollapsible ${collapsed ? 'is-collapsed' : ''}" data-sub-wrap="${escapeHtml(subKey)}">
            <div class="mb-collapsible-inner">
              <div class="mb-acc-group-items">
                ${items}
              </div>
            </div>
          </div>
        </div>`;
    }).join('');

    section.innerHTML = `
      <button class="mb-folder ${allSelected ? 'active' : ''}"${hideStyle} data-acc="">
        <i data-lucide="users" class="w-4 h-4"></i>
        <span class="lab">Tous les comptes</span>
      </button>
      ${groupsHtml}
    `;

    section.querySelectorAll('[data-acc]').forEach((b) => {
      b.addEventListener('click', () => {
        const acc = b.dataset.acc;
        if (acc === '') {
          state.accountFilters.clear();
        } else if (state.accountFilters.has(acc)) {
          state.accountFilters.delete(acc);
        } else {
          state.accountFilters.add(acc);
        }
        // Sync active states in-place — no DOM rebuild, no flicker.
        _syncAccountActive(section);
        loadEmails();
      });
    });

    // Sub-section title: click = collapse/expand · Shift+click = solo this group
    section.querySelectorAll('[data-sub-toggle]').forEach((titleEl) => {
      titleEl.addEventListener('click', (e) => {
        if (e.shiftKey) {
          e.preventDefault();
          const type = titleEl.dataset.subType;
          const groupEmails = (byType[type] || []).map((a) => a.email);
          state.accountFilters.clear();
          groupEmails.forEach((em) => state.accountFilters.add(em));
          _syncAccountActive(section);
          loadEmails();
          return;
        }
        const key = titleEl.dataset.subToggle;
        const wrapEl = section.querySelector(`[data-sub-wrap="${key}"]`);
        if (!wrapEl) return;
        const nowCollapsed = wrapEl.classList.toggle('is-collapsed');
        titleEl.classList.toggle('is-collapsed', nowCollapsed);
        localStorage.setItem(key, nowCollapsed ? '1' : '0');
      });
    });
    window.lucide?.createIcons();
  }

  // ── Sort button (next to search bar) ─────────────────────
  function renderSortBtn() {
    if (_sortDropCleanup) { _sortDropCleanup(); _sortDropCleanup = null; }

    const chevron  = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
    const sortIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/></svg>`;
    const curSort  = SORT_OPTIONS.find((o) => o.value === state.sortMode) || SORT_OPTIONS[0];

    const wrap = $('#sort-select-wrap');
    wrap.innerHTML = `
      <button class="sort-select-btn" id="sort-select-btn" type="button" aria-haspopup="listbox" aria-expanded="false" title="Trier les mails">
        ${sortIcon}<span>${escapeHtml(curSort.short)}</span>${chevron}
      </button>
      <div class="sort-select-drop" id="sort-select-drop" role="listbox" aria-label="Trier par">
        ${SORT_OPTIONS.map((opt) => `
          <div class="acc-select-opt ${state.sortMode === opt.value ? 'active' : ''}"
               data-sort="${escapeHtml(opt.value)}" role="option"
               aria-selected="${state.sortMode === opt.value}">
            ${escapeHtml(opt.label)}
          </div>
        `).join('')}
      </div>
    `;

    const sortBtn  = $('#sort-select-btn');
    const sortDrop = $('#sort-select-drop');

    sortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = wrap.classList.toggle('open');
      sortBtn.setAttribute('aria-expanded', open);
    });

    sortDrop.querySelectorAll('.acc-select-opt').forEach((opt) => {
      opt.addEventListener('click', () => {
        state.sortMode = opt.dataset.sort;
        wrap.classList.remove('open');
        renderSortBtn();
        applyFilter();
      });
    });

    const onSortOutside = (e) => { if (!wrap.contains(e.target)) wrap.classList.remove('open'); };
    document.addEventListener('click', onSortOutside);
    _sortDropCleanup = () => document.removeEventListener('click', onSortOutside);
  }

  function renderChips() {
    const el = $('#filter-chips');
    const existing = el.querySelectorAll('[data-quick]');

    // Already rendered — only sync active classes, no DOM rebuild.
    if (existing.length === 3) {
      const noQuick = !state.onlyUnread && !state.onlyReply;
      existing.forEach((b) => {
        const k = b.dataset.quick;
        b.classList.toggle('active',
          k === 'all'    ? noQuick :
          k === 'unread' ? state.onlyUnread :
          k === 'reply'  ? state.onlyReply  : false
        );
      });
      return;
    }

    // First render — create buttons and attach listeners.
    const noQuick = !state.onlyUnread && !state.onlyReply;
    el.innerHTML = `
      <button class="mb-chip ${noQuick ? 'active' : ''}" data-quick="all">Tous</button>
      <button class="mb-chip ${state.onlyUnread ? 'active' : ''}" data-quick="unread">Non lus</button>
      <button class="mb-chip ${state.onlyReply ? 'active' : ''}" data-quick="reply">À répondre</button>
    `;
    el.querySelectorAll('[data-quick]').forEach((b) => {
      b.addEventListener('click', () => {
        const k = b.dataset.quick;
        if (k === 'all')    { state.onlyUnread = false; state.onlyReply = false; }
        if (k === 'unread') { state.onlyUnread = !state.onlyUnread; state.onlyReply = false; }
        if (k === 'reply')  { state.onlyReply  = !state.onlyReply;  state.onlyUnread = false; }
        renderChips();
        loadEmails();
      });
    });
  }

  // ── Render: list ──────────────────────────────────────────
  function sortEmails(arr) {
    const copy = [...arr];
    switch (state.sortMode) {
      case 'date-asc':
        return copy.sort((a, b) => new Date(a.date_received) - new Date(b.date_received));
      case 'score':
        return copy.sort((a, b) => (b.importance_score || 0) - (a.importance_score || 0));
      case 'sender':
        return copy.sort((a, b) =>
          (senderName(a.sender) || '').localeCompare(senderName(b.sender) || '', 'fr', { sensitivity: 'base' })
        );
      default: // date-desc
        return copy.sort((a, b) => new Date(b.date_received) - new Date(a.date_received));
    }
  }

  function applyFilter() {
    const q = state.query.trim().toLowerCase();
    const activeEmails = new Set(state.accounts.map((a) => a.email));
    const filtered = state.emails.filter((em) => {
      // Exclude emails from accounts that have been removed from config
      if (activeEmails.size > 0 && !activeEmails.has(em.account_email)) return false;
      // multi-account client-side filter (single-account is handled at API level)
      if (state.accountFilters.size > 1 && !state.accountFilters.has(em.account_email)) return false;
      if (!q) return true;
      const hay = `${em.sender || ''} ${em.subject || ''} ${em.summary || ''}`.toLowerCase();
      return hay.includes(q);
    });
    const items = sortEmails(filtered);
    state.filteredIds = items.map((e) => e.int_id);
    renderList(items);
    updateBadge();
  }

  function updateBadge() {
    const b = $('#badge-inbox');
    if (!b) return;
    // Sum unread from accountStats (database counts, inbox-filtered) across all accounts.
    // Falls back to counting loaded emails if stats aren't available yet.
    const total = Object.values(state.accountStats).reduce((acc, s) => acc + (s.unread || 0), 0);
    b.textContent = total || state.emails.reduce((acc, em) => acc + (em.is_read ? 0 : 1), 0);
  }

  // True only on the very first render after mounting (i.e. page navigation).
  // Set to false after first renderList so subsequent reloads don't re-animate.
  let _firstRender = true;

  // ── Infinite scroll (virtual list) ───────────────────────
  const PAGE_SIZE = 40;
  let _listAllItems  = [];   // full filtered+sorted dataset
  let _listRendered  = 0;    // # cards currently in the DOM
  let _listObserver  = null; // IntersectionObserver on the sentinel

  function _teardownListObserver() {
    if (_listObserver) { _listObserver.disconnect(); _listObserver = null; }
  }

  function _attachCardHandlers(list, fromIdx, toIdx) {
    const cards = list.querySelectorAll('.mb-card');
    for (let i = fromIdx; i < toIdx && i < cards.length; i++) {
      const el = cards[i];
      const id = parseInt(el.dataset.id, 10);
      el.addEventListener('click', () => openEmail(id));
      const avatar = el.querySelector('.mb-avatar');
      if (avatar) {
        const onAvatar = (e) => { e.stopPropagation(); e.preventDefault(); toggleSelection(id); };
        avatar.addEventListener('click', onAvatar);
        avatar.addEventListener('keydown', (e) => {
          if (e.key === ' ' || e.key === 'Enter') onAvatar(e);
        });
      }
    }
  }

  function _appendBatch(list, animate) {
    _teardownListObserver();
    const from = _listRendered;
    const to   = Math.min(from + PAGE_SIZE, _listAllItems.length);
    if (from >= _listAllItems.length) return;

    // Remove stale sentinel before inserting new cards.
    list.querySelector('#list-sentinel')?.remove();

    const html = _listAllItems.slice(from, to).map((em, relIdx) =>
      cardHtml(em, animate && from === 0 ? from + relIdx : -1)
    ).join('');
    list.insertAdjacentHTML('beforeend', html);
    _attachCardHandlers(list, from, to);
    window.lucide?.createIcons();
    _listRendered = to;

    if (_listRendered < _listAllItems.length) {
      const sentinel = document.createElement('div');
      sentinel.id = 'list-sentinel';
      sentinel.style.cssText = 'height:1px;pointer-events:none';
      list.appendChild(sentinel);
      _listObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) _appendBatch(list, false);
      }, { rootMargin: '300px' });
      _listObserver.observe(sentinel);
    }
  }

  function renderList(items) {
    _teardownListObserver();
    const animate  = _firstRender;
    _firstRender   = false;
    _listAllItems  = items;
    _listRendered  = 0;

    const list = $('#email-list');
    if (!items.length) {
      list.innerHTML = `
        <div style="padding:48px 24px;text-align:center;color:var(--muted)">
          <div class="ill" style="margin:0 auto 14px;width:56px;height:56px;border-radius:16px;background:var(--surface);display:grid;place-items:center;color:var(--muted-2)">
            <i data-lucide="inbox" class="w-6 h-6"></i>
          </div>
          <div style="font-weight:600;color:var(--text);margin-bottom:4px">Aucun mail</div>
          <div style="font-size:13px">Aucun mail ne correspond à ces filtres.</div>
        </div>`;
      window.lucide?.createIcons();
      return;
    }

    list.innerHTML = '';
    _appendBatch(list, animate);
  }

  function cardHtml(em, animIdx = -1) {
    const sName = senderName(em.sender);
    const sEmail = senderEmail(em.sender);
    const ini = initials(sName || sEmail);
    const col = avatarColor(sEmail || sName);
    const logoImg = avatarImgHtml(sEmail);
    const isUnread = !em.is_read;
    const score = em.importance_score || 0;
    const showSummary = em.summary && em.summary.length > 0;
    const isSelected = state.selectedId === em.int_id;
    const isChecked = state.selectedIds.has(em.int_id);

    // Recipient account mini-avatar
    const accEmail = em.account_email || '';
    const accObj = state.accounts.find((a) => a.email === accEmail);
    const accIni = initials(accObj?.name || accEmail);
    const accCol = avatarColor(accEmail);
    const accAvatar = accEmail
      ? `<span class="mb-acc-av mb-card-acc-av" style="background:${accCol}" title="${escapeHtml(accEmail)}">${escapeHtml(accIni)}</span>`
      : '';

    // Staggered entrance on first render: start at 320ms, +30ms per card, cap 600ms.
    const animClass = animIdx >= 0 ? ' mb-card-enter' : '';
    const animStyle = animIdx >= 0
      ? ` style="animation-delay:${320 + Math.min(animIdx * 30, 480)}ms"`
      : '';

    return `
      <article class="mb-card${animClass} ${isUnread ? 'unread' : ''} ${isSelected ? 'selected' : ''} ${isChecked ? 'checked' : ''}" data-id="${em.int_id}" role="listitem" tabindex="0"${animStyle}>
        <div class="mb-avatar" style="background:${col}" role="checkbox" aria-checked="${isChecked}" aria-label="Sélectionner ce message" tabindex="0">
          <span class="av-text">${escapeHtml(ini)}</span>
          ${logoImg}
          <span class="av-check"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
        </div>
        <div class="mb-card-body">
          <div class="mb-card-row">
            <div class="mb-row-left">
              <span class="mb-sender">${escapeHtml(sName || sEmail || 'Inconnu')}</span>
              ${(() => {
                // Inline indicators ordered:
                //   sender → paperclip → reply (needs reply) → draft (draft ready)
                // The paperclip has three threat-tier variants so the user
                // spots dangerous PJ at a glance.
                const a = em.attachments || { total: 0, dangerous: 0, suspicious: 0 };
                if (!a.total) return '';
                if (a.dangerous)  return `<i data-lucide="shield-alert" class="w-3.5 h-3.5 mb-att-warn" title="Pièce jointe dangereuse"></i>`;
                if (a.suspicious) return `<i data-lucide="paperclip" class="w-3.5 h-3.5 mb-att-warn" title="Pièce jointe à vérifier"></i>`;
                return `<i data-lucide="paperclip" class="w-3.5 h-3.5 mb-att-icon" title="${a.total} pièce${a.total>1?'s':''} jointe${a.total>1?'s':''}"></i>`;
              })()}
              ${em.needs_reply ? `<i data-lucide="reply" class="w-3.5 h-3.5 mb-reply-inline" title="Réponse attendue"></i>` : ''}
              ${em.draft_response ? `<i data-lucide="pencil-line" class="w-3.5 h-3.5 mb-draft-inline" title="Brouillon IA prêt"></i>` : ''}
            </div>
            ${em.category && em.category !== 'pending' ? `<span class="mb-cat-dot" title="${escapeHtml(CATEGORY_LABEL[em.category] || em.category)}" style="background:${CATEGORY_COLOR[em.category] || 'var(--muted-2)'}"></span>` : ''}
            <span class="mb-date">${escapeHtml(shortDate(em.date_received))}</span>
          </div>
          <div class="mb-subj">
            <span>${escapeHtml(em.subject || '(sans objet)')}</span>
          </div>
          ${showSummary ? `<div class="mb-summary">${escapeHtml(em.summary)}</div>` : ''}
        </div>
        <div class="mb-card-meta">
          ${score > 0 ? `<span class="score-pill ${scoreClass(score)}" title="Score ${score}/10">${score}</span>` : '<span></span>'}
          ${em.is_favourite ? `<span class="mb-fav-star" title="Favori"><i data-lucide="star" class="w-3.5 h-3.5"></i></span>` : ''}
          ${accAvatar}
        </div>
      </article>
    `;
  }

  // ── Multi-selection (avatar-click) ────────────────────────
  function selectAll() {
    const allIds = state.filteredIds;
    const allSelected = allIds.length > 0 && allIds.every((id) => state.selectedIds.has(id));
    if (allSelected) {
      clearSelection();
      return;
    }
    allIds.forEach((id) => state.selectedIds.add(id));
    // Sync already-rendered cards; unrendered ones will pick up the class on paint.
    host.querySelectorAll('.mb-card').forEach((c) => {
      const id = parseInt(c.dataset.id, 10);
      if (state.selectedIds.has(id)) {
        c.classList.add('checked');
        const av = c.querySelector('.mb-avatar');
        if (av) av.setAttribute('aria-checked', 'true');
      }
    });
    renderSelectionBar();
  }

  function toggleSelection(id) {
    if (state.selectedIds.has(id)) state.selectedIds.delete(id);
    else state.selectedIds.add(id);
    const card = host.querySelector(`.mb-card[data-id="${id}"]`);
    if (card) {
      const on = state.selectedIds.has(id);
      card.classList.toggle('checked', on);
      const av = card.querySelector('.mb-avatar');
      if (av) av.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    renderSelectionBar();
  }

  function clearSelection() {
    closePopover();
    if (!state.selectedIds.size) return;
    state.selectedIds.clear();
    host.querySelectorAll('.mb-card.checked').forEach((c) => {
      c.classList.remove('checked');
      const av = c.querySelector('.mb-avatar');
      if (av) av.setAttribute('aria-checked', 'false');
    });
    renderSelectionBar();
  }

  function renderSelectionBar() {
    const bar = $('#sel-bar');
    if (!bar) return;
    const n = state.selectedIds.size;
    if (n === 0) {
      bar.hidden = true;
      closePopover();
      return;
    }
    bar.hidden = false;
    const num = $('#sel-count-num');
    if (num) num.textContent = String(n);
    // Update the select-all button label: "Tout" / "Aucun"
    const allLabel = $('#sel-all-label');
    const allBtn   = $('#sel-all-btn');
    if (allLabel && allBtn) {
      const total = state.filteredIds.length;
      const allSelected = total > 0 && state.selectedIds.size >= total
        && state.filteredIds.every((id) => state.selectedIds.has(id));
      allLabel.textContent = allSelected ? 'Aucun' : 'Tout';
      allBtn.title = allSelected ? 'Tout désélectionner' : 'Tout sélectionner';
      allBtn.setAttribute('aria-label', allBtn.title);
      allBtn.classList.toggle('active', allSelected);
    }
    refreshReadButton();
  }

  // Smart read button: switches between "mark as read" and "mark as unread"
  // depending on whether every selected email is already read.
  function refreshReadButton() {
    const btn = $('#sel-btn-read');
    if (!btn) return;
    const ids = [...state.selectedIds];
    const allRead = ids.length > 0 && ids.every((id) => {
      const em = state.emails.find((e) => e.int_id === id);
      return em && em.is_read;
    });
    const next = allRead ? 'unread' : 'read';
    if (btn.dataset.act === next) return;
    btn.dataset.act = next;
    const label = allRead ? 'Marquer comme non lu' : 'Marquer comme lu';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = `<i data-lucide="${allRead ? 'mail' : 'mail-open'}" class="w-4 h-4"></i>`;
    window.lucide?.createIcons();
  }

  async function bulkSetRead(target) {
    const ids = [...state.selectedIds];
    if (!ids.length) return;
    let updated = 0;
    for (const id of ids) {
      const idx = state.emails.findIndex((e) => e.int_id === id);
      const em = idx >= 0 ? state.emails[idx] : null;
      if (!em) continue;
      const isRead = !!em.is_read;
      if (target === isRead) continue;
      em.is_read = target ? 1 : 0;
      host.querySelectorAll(`.mb-card[data-id="${id}"]`).forEach((c) => {
        c.classList.toggle('unread', !target);
      });
      updated++;
      api.patchEmail(id, { is_read: target }).catch(() => {});
    }
    updateBadge();
    clearSelection();
    if (updated) {
      window.toast(`${updated} message(s) marqué(s) comme ${target ? 'lu' : 'non lu'}`);
    } else {
      window.toast(target ? 'Déjà lus' : 'Déjà non lus');
    }
  }

  async function bulkSetCategory(category) {
    const ids = [...state.selectedIds];
    if (!ids.length) return;
    await Promise.all(ids.map((id) => api.patchEmail(id, { category }).catch(() => {})));
    window.toast(`${ids.length} message(s) étiqueté(s)`);
    clearSelection();
    await loadEmails();
  }

  // Translate a logical popover target (inbox / favourite / deleted) into the
  // actual PATCH payload, using the active folder as context. A favourite is
  // a flag, not a folder, so starring a mail keeps it in inbox/trash.
  function _patchForTarget(target, currentFolder) {
    if (target === 'favourite') {
      const p = { is_favourite: true };
      // Restoring from trash and starring at the same time is the natural intent.
      if (currentFolder === 'deleted') p.folder = 'inbox';
      return { patch: p, verb: 'mis en favori', leavesView: currentFolder !== 'inbox' };
    }
    if (target === 'deleted') {
      return { patch: { folder: 'deleted' }, verb: 'supprimé(s)', leavesView: currentFolder !== 'deleted' };
    }
    if (target === 'inbox') {
      // From the Favourites view, "back to inbox" means unstar — the mail is
      // already in inbox so the only state change is dropping the flag.
      if (currentFolder === 'favourite') {
        return { patch: { is_favourite: false }, verb: 'retiré(s) des favoris', leavesView: true };
      }
      // From Trash, restore the folder; keep the favourite flag if any.
      if (currentFolder === 'deleted') {
        return { patch: { folder: 'inbox' }, verb: 'restauré(s) dans la boîte', leavesView: true };
      }
      // Already in inbox — no-op (the popover hides this option in that case).
      return null;
    }
    return null;
  }

  async function bulkSetTarget(target) {
    const ids = [...state.selectedIds];
    if (!ids.length) return;
    const cur = state.folder || 'inbox';
    const plan = _patchForTarget(target, cur);
    if (!plan) return;
    await Promise.all(ids.map((id) => api.patchEmail(id, plan.patch).catch(() => {})));
    window.toast(`${ids.length} message(s) ${plan.verb}`);
    // If the open email left the current view, close the read pane.
    if (state.selectedId != null && ids.includes(state.selectedId) && plan.leavesView) {
      renderEmpty();
    }
    clearSelection();
    await loadEmails();
  }

  async function bulkReanalyze() {
    const ids = [...state.selectedIds];
    if (!ids.length) return;
    const openId = state.selectedId;
    let done = 0, failed = 0;
    const total = ids.length;
    window.toast(`Analyse IA 0/${total}…`, 60_000);
    for (const id of ids) {
      try {
        const updated = await api.reanalyzeEmail(id);
        const idx = state.emails.findIndex((e) => e.int_id === id);
        if (idx >= 0 && updated) state.emails[idx] = { ...state.emails[idx], ...updated };
        done++;
      } catch (_) {
        failed++;
      }
      window.toast(`Analyse IA ${done + failed}/${total}…`, 60_000);
    }
    clearSelection();
    await loadEmails();
    // If the email currently opened in the read pane was part of the batch,
    // refresh it so the user sees the new summary/score/draft right away.
    if (openId != null && ids.includes(openId)) {
      try {
        const fresh = await api.getEmail(openId);
        renderEmail(fresh);
      } catch (_) {}
    }
    window.toast(failed
      ? `Analyse IA terminée : ${done} ok, ${failed} échec(s)`
      : `Analyse IA terminée (${done}/${total})`);
  }

  // ── Popover (Move + Tag dropdowns) ────────────────────────
  let _popCleanup = null;
  function closePopover() {
    if (_popCleanup) { _popCleanup(); _popCleanup = null; }
  }

  function openPopover(anchor, items, onPick) {
    closePopover();
    const pop = document.createElement('div');
    pop.className = 'sel-popover';
    pop.setAttribute('role', 'menu');
    pop.innerHTML = items.map((it) => `
      <button class="sel-popover-opt" role="menuitem" data-value="${escapeHtml(it.value)}">
        ${it.color ? `<span class="dot" style="background:${it.color}"></span>` : ''}
        ${it.icon ? `<i data-lucide="${it.icon}" class="w-4 h-4"></i>` : ''}
        <span>${escapeHtml(it.label)}</span>
      </button>
    `).join('');
    document.body.appendChild(pop);
    window.lucide?.createIcons();

    // Position fixed, anchored to the trigger button. Default below; flip
    // above if it would overflow the viewport.
    const r = anchor.getBoundingClientRect();
    pop.style.visibility = 'hidden';
    pop.style.top = '0px';
    pop.style.left = '0px';
    const ph = pop.offsetHeight, pw = pop.offsetWidth;
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    let left = Math.min(Math.max(8, r.right - pw), window.innerWidth - pw - 8);
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
    pop.style.visibility = '';

    const onClick = (e) => {
      const opt = e.target.closest('.sel-popover-opt');
      if (!opt) return;
      e.stopPropagation();
      onPick(opt.dataset.value);
      closePopover();
    };
    const onOutside = (e) => {
      if (pop.contains(e.target) || anchor.contains(e.target)) return;
      closePopover();
    };
    pop.addEventListener('click', onClick);
    // Defer outside listener by one tick so the click that opened the
    // popover does not immediately close it.
    setTimeout(() => document.addEventListener('mousedown', onOutside), 0);

    _popCleanup = () => {
      document.removeEventListener('mousedown', onOutside);
      pop.removeEventListener('click', onClick);
      pop.remove();
    };
  }

  function openTagPopover(anchor) {
    const items = LABELS.map((l) => ({ value: l.id, label: l.label, color: l.color }));
    openPopover(anchor, items, (cat) => bulkSetCategory(cat));
  }

  function openMovePopover(anchor) {
    const cur = state.folder || 'inbox';
    // Tailor the labels so they match what the action will actually do from
    // the current view (e.g. "back to inbox" from Favourites means unstar).
    const labelInbox = cur === 'favourite' ? 'Retirer des favoris'
      : cur === 'deleted' ? 'Restaurer dans la boîte'
      : 'Boîte de réception';
    const items = [
      { value: 'inbox',     label: labelInbox, icon: 'inbox' },
      { value: 'favourite', label: 'Favoris',  icon: 'star' },
      { value: 'deleted',   label: 'Supprimés', icon: 'trash-2' },
    ].filter((it) => {
      if (it.value === 'inbox' && cur === 'inbox') return false;       // already there
      if (it.value === 'favourite' && cur === 'favourite') return false; // already starred-view
      if (it.value === 'deleted' && cur === 'deleted') return false;     // already trashed
      return true;
    });
    openPopover(anchor, items, (target) => bulkSetTarget(target));
  }

  function onSelBarClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'clear')       return clearSelection();
    if (act === 'select-all')  return selectAll();
    if (act === 'read')        return bulkSetRead(true);
    if (act === 'unread')      return bulkSetRead(false);
    if (act === 'delete')      return bulkSetTarget('deleted');
    if (act === 'tag')         return openTagPopover(btn);
    if (act === 'move')        return openMovePopover(btn);
    if (act === 'ai')          return bulkReanalyze();
  }

  // ── Reading pane ──────────────────────────────────────────
  // Width-transition duration on .mb-read in CSS (keep in sync).
  const PANE_ANIM_MS = 380;
  let _selModeTimer = null;

  /**
   * Toggle the closed/open state of the reading pane.
   * Close: lock the inner wrapper width to the current pane width so the
   * body content does not reflow as the parent collapses to 0; the parent
   * shrinks via a single CSS width transition while the inner fades+slides.
   */
  function setSelectionMode(hasSelection) {
    const mailbox = host.querySelector('.mailbox');
    const chips   = host.querySelector('#filter-chips');
    const pane    = host.querySelector('#read-pane');
    const inner   = pane?.querySelector('.mb-read-inner');

    if (_selModeTimer) { clearTimeout(_selModeTimer); _selModeTimer = null; }

    // Only hide chips when the grid layout is actually switching
    // (panel opening ↔ closing). If no state change occurs the chips
    // must stay visible — no hiding, no re-animation.
    const alreadyNoSelection = mailbox.classList.contains('no-selection');
    const layoutChanging = hasSelection ? alreadyNoSelection : !alreadyNoSelection;

    if (layoutChanging && chips) chips.dataset.hiding = '1';

    if (hasSelection) {
      // Opening: clear any leftover width lock first.
      if (inner) inner.style.width = '';
      mailbox.classList.remove('no-selection');
      // Reveal chips in their new position once layout has settled.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (chips) delete chips.dataset.hiding;
      }));
      return;
    }

    // Closing — only meaningful if the pane is currently visible.
    if (inner) {
      const w = pane.getBoundingClientRect().width;
      if (w > 0) inner.style.width = w + 'px';
    }
    // Force a layout read so the locked width is committed before the class
    // toggle starts the width transition (otherwise the browser may batch
    // the two style changes and the lock has no effect).
    void pane?.offsetWidth;

    mailbox.classList.add('no-selection');

    if (layoutChanging) {
      _selModeTimer = setTimeout(() => {
        if (chips) delete chips.dataset.hiding;
        _selModeTimer = null;
      }, PANE_ANIM_MS + 20);
    }
  }

  function renderEmpty() {
    const pane = host.querySelector('#read-pane');
    setSelectionMode(false);
    // Wait for the close animation to finish before wiping the markup —
    // otherwise the content vanishes a frame before the pane has shrunk.
    // Guard: if an email was opened before the timeout fires, leave the pane.
    setTimeout(() => { if (pane && !state.selectedId) pane.innerHTML = ''; }, PANE_ANIM_MS + 40);
    state.selectedId = null;
  }

  // ── Attachments (security-aware) ──────────────────────────
  // Backend has classified each attachment (safe / suspicious / dangerous
  // / blocked). We never pre-fetch the binary; users click, confirm if
  // needed, and a normal browser download happens.

  function fmtBytes(n) {
    if (!n || n <= 0) return '0 o';
    const u = ['o', 'Ko', 'Mo', 'Go'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
  }

  function attIconFor(name) {
    const ext = (name || '').toLowerCase().split('.').pop() || '';
    if (['png','jpg','jpeg','gif','webp','bmp','tif','tiff','heic','svg'].includes(ext)) return 'image';
    if (['pdf','doc','docx','odt','rtf'].includes(ext)) return 'file-text';
    if (['xls','xlsx','csv','tsv','ods'].includes(ext)) return 'file-spreadsheet';
    if (['ppt','pptx','odp'].includes(ext)) return 'file-presentation';
    if (['mp3','wav','flac','m4a','ogg','opus','aac'].includes(ext)) return 'file-audio';
    if (['mp4','mov','webm','mkv','avi','wmv'].includes(ext)) return 'file-video';
    if (['zip','rar','7z','tar','gz','bz2','xz','tgz'].includes(ext)) return 'file-archive';
    if (['exe','msi','bat','cmd','vbs','js','ps1','sh','jar','app','dmg'].includes(ext)) return 'file-warning';
    return 'paperclip';
  }

  function attBadge(level) {
    if (level === 'dangerous') return `<span class="att-badge att-danger" title="Fichier potentiellement dangereux"><i data-lucide="shield-alert" class="w-3 h-3"></i>Dangereux</span>`;
    if (level === 'blocked')   return `<span class="att-badge att-blocked" title="Fichier bloqué par la politique de sécurité"><i data-lucide="ban" class="w-3 h-3"></i>Bloqué</span>`;
    if (level === 'suspicious')return `<span class="att-badge att-warn" title="Fichier nécessitant prudence (macros, archive, script…)"><i data-lucide="alert-triangle" class="w-3 h-3"></i>À vérifier</span>`;
    return '';
  }

  function renderAttachmentsBlock(em) {
    const list = em.attachments || [];
    // Lazy-scan hint for legacy mails. The backend kicks off a single-
    // message IMAP fetch the moment GET /api/emails/{id} sees the
    // unscanned flag — we just nudge the user to refresh.
    if (list.length === 0 && em.attachments_pending_scan) {
      return `
        <div class="mb-attachments mb-att-pending">
          <div class="att-pending-row">
            <i data-lucide="loader" class="w-4 h-4"></i>
            <span>Recherche de pièces jointes en cours…</span>
            <button class="att-rescan" id="btn-rescan-one" data-id="${em.int_id}">Réessayer</button>
          </div>
        </div>
      `;
    }
    if (list.length === 0) return '';
    const items = list.map((a) => {
      const icon = attIconFor(a.filename);
      const badge = attBadge(a.threat_level);
      const isUnavailable = !a.available;
      const isDangerous = a.threat_level === 'dangerous';
      const reasons = (a.threat_reasons || []).map(escapeHtml).join(' · ');
      const titleAttr = reasons ? `title="${escapeHtml(reasons)}"` : '';
      const action = isUnavailable
        ? `<span class="att-unavail">Stockage refusé</span>`
        : `<button class="att-download" data-id="${a.id}" data-level="${escapeHtml(a.threat_level)}" data-name="${escapeHtml(a.filename)}" data-reasons="${escapeHtml(reasons)}" aria-label="Télécharger ${escapeHtml(a.filename)}">
             <i data-lucide="${isDangerous ? 'shield-alert' : 'download'}" class="w-4 h-4"></i>
             <span>Télécharger</span>
           </button>`;
      return `
        <div class="att-row att-${escapeHtml(a.threat_level)}" ${titleAttr}>
          <div class="att-icon"><i data-lucide="${icon}" class="w-5 h-5"></i></div>
          <div class="att-meta">
            <div class="att-name">${escapeHtml(a.filename)}${a.is_inline ? '<span class="att-inline-tag" title="Image affichée dans le corps du mail">incorporée</span>' : ''}</div>
            <div class="att-sub">
              <span>${fmtBytes(a.size)}</span>
              ${a.content_type ? `<span>· ${escapeHtml(a.content_type)}</span>` : ''}
              ${badge}
            </div>
          </div>
          <div class="att-action">${action}</div>
        </div>
      `;
    }).join('');
    const totals = list.length;
    const dangerCount = list.filter((a) => a.threat_level === 'dangerous' || a.threat_level === 'blocked').length;
    const headLabel = `${totals} pièce${totals > 1 ? 's' : ''} jointe${totals > 1 ? 's' : ''}`
      + (dangerCount ? ` <span class="att-head-warn">· ${dangerCount} à risque</span>` : '');
    return `
      <details class="mb-attachments">
        <summary>
          <i data-lucide="paperclip" class="w-4 h-4"></i>
          <span>${headLabel}</span>
        </summary>
        <div class="att-list">${items}</div>
      </details>
    `;
  }

  function bindAttachmentHandlers(em) {
    host.querySelectorAll('#read-pane .att-download').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        const level = btn.dataset.level;
        const name = btn.dataset.name;
        const reasons = btn.dataset.reasons;
        if (level === 'dangerous') {
          // Two-step confirmation: user must explicitly accept downloading
          // a flagged file. Server also enforces ?confirm=1 so a manual
          // URL hit isn't enough.
          const ok = window.confirm(
            `⚠ Pièce jointe potentiellement dangereuse :\n\n` +
            `« ${name} »\n\n` +
            (reasons ? `Motifs : ${reasons}\n\n` : '') +
            `Le fichier sera téléchargé en .bin (pas d'exécution automatique). ` +
            `Ne l'ouvrez QUE si vous attendez ce fichier de cet expéditeur précis. ` +
            `Continuer ?`
          );
          if (!ok) return;
          window.location.href = api.attachmentDownloadUrl(id, { confirm: true });
        } else {
          window.location.href = api.attachmentDownloadUrl(id);
        }
      });
    });
    // Manual rescan button (pending state). Re-opens the email after a
    // short delay so the read pane refreshes with whatever the lazy scan
    // produced on the server.
    const rescan = host.querySelector('#read-pane #btn-rescan-one');
    if (rescan && em) {
      rescan.addEventListener('click', async () => {
        rescan.disabled = true;
        rescan.textContent = 'Scan en cours…';
        // Re-fetch the email after a short wait — this triggers a fresh
        // lazy-scan task on the backend if needed.
        setTimeout(async () => {
          try { await openEmail(em.int_id); } catch (_) {}
        }, 1500);
      });
    }
  }

  function renderEmail(em) {
    const cat = em.category || 'pending';
    const sName = senderName(em.sender);
    const sEmail = senderEmail(em.sender);
    const ini = initials(sName || sEmail);
    const col = avatarColor(sEmail || sName);
    const logoImg = avatarImgHtml(sEmail, 36);

    const aiBox = em.summary ? `
      <div class="mb-ai-box">
        <div class="ai-icon"><i data-lucide="sparkles" class="w-4 h-4"></i></div>
        <div class="ai-body">
          <div class="ai-title">
            <span>Analyse IA</span>
            <span class="score-pill ${scoreClass(em.importance_score || 0)}">${em.importance_score || 0}</span>
          </div>
          <div class="ai-summary">${escapeHtml(em.summary)}</div>
          ${em.importance_reason ? `<div class="ai-reason">${escapeHtml(em.importance_reason)}</div>` : ''}
        </div>
      </div>
    ` : '';

    // Auto-open the draft panel when a brouillon already exists (the user
    // generated it earlier or AI did during ingestion). Otherwise stays
    // hidden and the toolbar button toggles it on demand.
    const hasDraft = !!em.draft_response;
    const draftBox = `
      <div class="mb-draft" id="mb-draft" style="display:${hasDraft ? '' : 'none'}" data-loaded="${hasDraft ? '1' : '0'}">
        <div class="dh">
          <i data-lucide="sparkles" class="w-4 h-4"></i>
          <span>Réponse suggérée par l'IA</span>
        </div>
        <div class="dt" id="mb-draft-text">${hasDraft ? escapeHtml(em.draft_response) : ''}</div>
        <div class="da">
          <button class="primary" data-toast="Envoi : bientôt"><i data-lucide="send" class="w-4 h-4" style="margin-right:6px;vertical-align:-2px"></i>Envoyer</button>
          <button data-toast="Édition : bientôt">Modifier</button>
        </div>
      </div>
    `;

    // Build the body block. Three branches:
    //   • plain-text body (already linkified for homograph URLs)
    //   • HTML body in a sandboxed iframe — with optional image-blocker
    //     banner above when remote images were stripped
    //   • empty placeholder
    //
    // The image-blocker honours `em.sender_images_trusted` (provided by
    // the API). When the sender is trusted, the iframe renders the
    // original HTML untouched. Otherwise we run rewriteRemoteImages,
    // count what got stripped, and surface a banner with two buttons:
    //   – "Charger pour ce mail" : re-render this email's iframe
    //     without the blocker (no DB write, one-shot).
    //   – "Toujours pour cet expéditeur" : POST the trust flag and
    //     re-render. Future emails from the same domain skip the
    //     blocker automatically.
    const body = em.body_text && em.body_text.trim().length
      ? `<div class="mb-body-text">${linkify(em.body_text)}</div>`
      : (em.body_html
         ? buildHtmlBodyBlock(em)
         : `<div style="color:var(--muted);font-style:italic">(corps du mail vide)</div>`);

    $('#read-pane').innerHTML = `
      <div class="mb-read-inner">
      <div class="mb-read-head">
        <span class="cat-chip" data-cat="${escapeHtml(cat)}">
          <i data-lucide="tag" class="w-3 h-3"></i>${escapeHtml(CATEGORY_LABEL[cat] || cat)}
        </span>
        <div class="mb-read-actions">
          <button class="icon-btn ${em.is_favourite ? 'is-fav' : ''}" id="btn-fav-toggle" title="${em.is_favourite ? 'Retirer des favoris' : 'Marquer favori'}" aria-pressed="${em.is_favourite ? 'true' : 'false'}">
            <i data-lucide="star" class="w-4 h-4"></i>
          </button>
          <button class="icon-btn" id="btn-print" title="Imprimer"><i data-lucide="printer" class="w-4 h-4"></i></button>
          <button class="icon-btn" id="btn-read-toggle" title="${em.is_read ? 'Marquer comme non lu' : 'Marquer comme lu'}">
            <i data-lucide="${em.is_read ? 'mail' : 'mail-open'}" class="w-4 h-4"></i>
          </button>
          <button class="icon-btn danger" id="btn-trash" title="Supprimer"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
          <button class="icon-btn" id="btn-more" title="Plus d'actions"><i data-lucide="more-vertical" class="w-4 h-4"></i></button>
          <div class="mb-read-sep"></div>
          <button class="icon-btn" id="btn-close-read" title="Fermer"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
      </div>
      <div class="mb-read-body">
        <div class="mb-read-meta">
          <div class="mb-read-date">${escapeHtml(longDate(em.date_received))}</div>
          <h1 class="mb-read-subject">${escapeHtml(em.subject || '(sans objet)')}</h1>

          <div class="mb-thread-item">
            <div class="mb-avatar" style="width:36px;height:36px;font-size:12px;background:${col}">
              <span class="av-text" style="font-size:12px">${escapeHtml(ini)}</span>
              ${logoImg}
            </div>
            <div>
              <div class="name">${escapeHtml(sName || 'Inconnu')}${authBadgeHtml(em.auth_results)}</div>
              <div class="meta meta-route">
                <i data-lucide="send" class="w-3 h-3 meta-icon"></i><span class="meta-addr">${escapeHtml(sEmail)}</span>
                <i data-lucide="arrow-right" class="w-3 h-3 meta-arrow"></i>
                <i data-lucide="inbox" class="w-3 h-3 meta-icon"></i><span class="meta-addr meta-to">${escapeHtml(em.account_email || '')}</span>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;margin-left:auto">
              <div class="meta">${escapeHtml(shortDate(em.date_received))}</div>
              <button class="read-action-btn read-action-btn-ai ${em.draft_response ? 'has-draft active' : ''}" id="btn-draft-toggle" title="Réponse suggérée par l'IA">
                <i data-lucide="sparkles" class="w-4 h-4"></i>
              </button>
              <button class="read-action-btn" id="btn-reply-toggle" title="Répondre">
                <i data-lucide="reply" class="w-4 h-4"></i>
              </button>
            </div>
          </div>

          ${aiBox}
        </div>

        <div class="mb-read-content">
          ${body}

          ${renderAttachmentsBlock(em)}

          ${draftBox}

          <div class="mb-composer" id="mb-composer" style="display:none">
            <textarea placeholder="Écrire un message…" aria-label="Composer"></textarea>
            <div class="mb-composer-bar">
              <div style="display:flex;gap:4px;color:var(--muted)">
                <button class="icon-btn" data-toast="Pièce jointe : bientôt"><i data-lucide="paperclip" class="w-4 h-4"></i></button>
                <button class="icon-btn" data-toast="Image : bientôt"><i data-lucide="image" class="w-4 h-4"></i></button>
              </div>
              <button class="send" data-toast="Envoi : bientôt">
                <i data-lucide="send" class="w-4 h-4"></i>
                Envoyer
              </button>
            </div>
          </div>
        </div>
      </div>
      </div>
    `;

    $('#read-pane').querySelectorAll('[data-toast]').forEach((el) => {
      el.addEventListener('click', (e) => { e.preventDefault(); window.toast(el.dataset.toast); });
    });

    bindAttachmentHandlers(em);

    $('#btn-close-read').addEventListener('click', () => {
      host.querySelectorAll('.mb-card').forEach((c) => c.classList.remove('selected'));
      renderEmpty();
    });

    // Wire up the "Charger pour ce mail" / "Toujours pour cet expéditeur"
    // banner buttons after the iframe has been mounted. No-op when the
    // sender is already trusted (no banner present).
    attachImageBlockerHandlers(em);

    $('#btn-print').addEventListener('click', () => {
      // CSS `@media print` hides the rest of the chrome; we only need to
      // resize the email-body iframe (if any) to its full content height
      // so the entire HTML body lands on paper, not just the scroll viewport.
      const iframe = host.querySelector('#read-pane .mb-body-iframe');
      let savedH = null;
      if (iframe) {
        try {
          savedH = iframe.style.height;
          const doc = iframe.contentDocument;
          const innerH = doc?.documentElement?.scrollHeight || doc?.body?.scrollHeight || 0;
          if (innerH > 0) iframe.style.height = innerH + 'px';
        } catch (_) { /* sandbox may block introspection */ }
      }
      document.body.classList.add('printing');
      // Let layout settle before invoking the print dialog.
      setTimeout(() => {
        try { window.print(); } finally {
          if (iframe && savedH != null) iframe.style.height = savedH;
          document.body.classList.remove('printing');
        }
      }, 80);
    });

    $('#btn-fav-toggle').addEventListener('click', async () => {
      const target = !em.is_favourite;
      em.is_favourite = target;
      const idx = state.emails.findIndex((e) => e.int_id === em.int_id);
      if (idx >= 0) state.emails[idx].is_favourite = target ? 1 : 0;
      const btn = $('#btn-fav-toggle');
      btn.classList.toggle('is-fav', target);
      btn.title = target ? 'Retirer des favoris' : 'Marquer favori';
      btn.setAttribute('aria-pressed', target ? 'true' : 'false');
      try { await api.patchEmail(em.int_id, { is_favourite: target }); } catch (_) {}
      await loadEmails();
      window.toast(target ? 'Ajouté aux favoris' : 'Retiré des favoris');
    });

    $('#btn-read-toggle').addEventListener('click', async () => {
      const target = !em.is_read;
      em.is_read = target ? 1 : 0;
      const idx = state.emails.findIndex((e) => e.int_id === em.int_id);
      if (idx >= 0) state.emails[idx].is_read = em.is_read;
      host.querySelectorAll(`.mb-card[data-id="${em.int_id}"]`).forEach((c) => {
        c.classList.toggle('unread', !target);
      });
      updateBadge();
      const btn = $('#btn-read-toggle');
      btn.title = target ? 'Marquer comme non lu' : 'Marquer comme lu';
      btn.innerHTML = `<i data-lucide="${target ? 'mail' : 'mail-open'}" class="w-4 h-4"></i>`;
      window.lucide?.createIcons();
      try { await api.patchEmail(em.int_id, { is_read: target }); } catch (_) {}
      window.toast(target ? 'Marqué comme lu' : 'Marqué comme non lu');
    });

    $('#btn-trash').addEventListener('click', async () => {
      try { await api.patchEmail(em.int_id, { folder: 'deleted' }); } catch (_) {}
      window.toast('Message supprimé');
      renderEmpty();
      await loadEmails();
    });

    $('#btn-more').addEventListener('click', () => {
      const anchor = $('#btn-more');
      const cur = state.folder || 'inbox';
      const moveLabel = cur === 'deleted' ? 'Restaurer dans la boîte' : 'Déplacer dans la corbeille';
      const items = [
        { value: 'tag',    label: 'Étiqueter…',         icon: 'tag' },
        { value: 'ai',     label: 'Ré-analyser avec l’IA', icon: 'sparkles' },
        { value: 'move',   label: moveLabel,            icon: cur === 'deleted' ? 'inbox' : 'folder-input' },
      ];
      openPopover(anchor, items, async (action) => {
        if (action === 'tag') {
          // Re-anchor a tag picker on the More button.
          const tagItems = LABELS.map((l) => ({ value: l.id, label: l.label, color: l.color }));
          openPopover(anchor, tagItems, async (cat) => {
            try { await api.patchEmail(em.int_id, { category: cat }); } catch (_) {}
            window.toast('Étiquette appliquée');
            await loadEmails();
            try { renderEmail(await api.getEmail(em.int_id)); } catch (_) {}
          });
        } else if (action === 'ai') {
          window.toast('Analyse IA en cours…', 30_000);
          try {
            const fresh = await api.reanalyzeEmail(em.int_id);
            renderEmail(fresh);
            await loadEmails();
            window.toast('Analyse IA terminée');
          } catch (_) {
            window.toast('Échec de l’analyse IA');
          }
        } else if (action === 'move') {
          const target = cur === 'deleted' ? 'inbox' : 'deleted';
          try { await api.patchEmail(em.int_id, { folder: target }); } catch (_) {}
          window.toast(target === 'deleted' ? 'Déplacé dans la corbeille' : 'Restauré dans la boîte');
          renderEmpty();
          await loadEmails();
        }
      });
    });

    $('#btn-reply-toggle').addEventListener('click', () => {
      const composer = $('#mb-composer');
      const open = composer.style.display === 'none';
      composer.style.display = open ? '' : 'none';
      $('#btn-reply-toggle').classList.toggle('active', open);
      if (open) composer.querySelector('textarea')?.focus();
    });

    $('#btn-draft-toggle')?.addEventListener('click', async () => {
      const draft = $('#mb-draft');
      const btn = $('#btn-draft-toggle');
      if (!draft || !btn) return;
      const alreadyOpen = draft.style.display !== 'none';
      if (alreadyOpen) {
        draft.style.display = 'none';
        btn.classList.remove('active');
        return;
      }
      // If draft already loaded, just show it.
      if (draft.dataset.loaded === '1') {
        draft.style.display = '';
        btn.classList.add('active');
        return;
      }
      // Generate on demand.
      btn.disabled = true;
      btn.classList.add('loading');
      try {
        const res = await api.generateDraft(em.int_id);
        const text = res.draft_response || '';
        const dtEl = draft.querySelector('#mb-draft-text');
        if (dtEl) dtEl.textContent = text;
        draft.dataset.loaded = '1';
        btn.classList.add('has-draft');
        if (text) {
          draft.style.display = '';
          btn.classList.add('active');
          // Persist locally + reflect in the list card. Backend has
          // already flipped needs_reply=1 on the row; we mirror that
          // into state so the next loadEmails() round and the local
          // cache stay coherent. _patchCardReplyIcon mutates only the
          // currently visible card to avoid a full list re-render.
          em.draft_response = text;
          em.needs_reply = 1;
          const idx = state.emails.findIndex((e) => e.int_id === em.int_id);
          if (idx >= 0) {
            state.emails[idx].draft_response = text;
            state.emails[idx].needs_reply = 1;
          }
          _patchCardReplyIcon(em.int_id, true);
          _patchCardDraftIcon(em.int_id, true);
        } else {
          window.toast('Impossible de générer une réponse.');
        }
      } catch (e) {
        window.toast('Erreur lors de la génération du brouillon.');
      } finally {
        btn.disabled = false;
        btn.classList.remove('loading');
      }
    });

    window.lucide?.createIcons();
  }

  async function openEmail(intId) {
    state.selectedId = intId;
    setSelectionMode(true);
    // Reflect selection in list
    host.querySelectorAll('.mb-card').forEach((c) => {
      c.classList.toggle('selected', parseInt(c.dataset.id, 10) === intId);
    });
    try {
      const em = await api.getEmail(intId);
      renderEmail(em);
      const idx = state.emails.findIndex((e) => e.int_id === intId);
      // Mark read locally + remotely
      if (!em.is_read) {
        if (idx >= 0) {
          state.emails[idx].is_read = 1;
          host.querySelectorAll(`.mb-card[data-id="${intId}"]`).forEach((c) => c.classList.remove('unread'));
          updateBadge();
        }
        api.patchEmail(intId, { is_read: true }).catch(() => {});
      }
      // Sync attachment summary into the list card.
      // The detail endpoint triggers a lazy IMAP scan; the list may have been
      // loaded before that scan ran (summary = {total:0}). Once we have the
      // real attachment array, backfill the card so the paperclip appears.
      //
      // CRITICAL: keep this counter aligned with the SQL filter used by
      // attachment_counts_for_messages — both must exclude inline images
      // (CID logos embedded in the body). Otherwise the icon appears on
      // open (when we count everything) and disappears on reload (when
      // SQL excludes inline). Same for the threat fields: the API ships
      // `threat_level`, not `dangerous`/`suspicious` flags.
      if (idx >= 0 && Array.isArray(em.attachments) && em.attachments.length > 0) {
        const listEntry = state.emails[idx];
        const real = em.attachments.filter((a) => !a.is_inline);
        const knownTotal = listEntry.attachments?.total ?? 0;
        if (!knownTotal && real.length > 0) {
          const total      = real.length;
          const dangerous  = real.filter((a) => a.threat_level === 'dangerous' || a.threat_level === 'blocked').length;
          const suspicious = real.filter((a) => a.threat_level === 'suspicious').length;
          listEntry.attachments = { total, dangerous, suspicious };
          _patchCardAttachmentIcon(intId, { total, dangerous, suspicious });
        }
      }
    } catch (err) {
      $('#read-pane').innerHTML = `<div class="mb-read-empty">Erreur de chargement: ${escapeHtml(err.message)}</div>`;
    }
  }

  /**
   * Inject (or update) the attachment indicator on a list card without
   * triggering a full re-render. Called when the detail API reveals
   * attachments that were unknown to the list summary.
   */
  function _patchCardAttachmentIcon(intId, { total, dangerous, suspicious }) {
    const card = host.querySelector(`.mb-card[data-id="${intId}"]`);
    if (!card) return;

    // Remove any stale icon first.
    card.querySelectorAll('.mb-att-icon, .mb-att-warn').forEach((i) => i.remove());

    const rowLeft = card.querySelector('.mb-row-left');
    if (!rowLeft) return;

    // Build the icon mirroring the variants in the template render. All
    // three variants live in .mb-row-left, BEFORE the reply icon —
    // matching the order documented in the template: sender, paperclip,
    // reply. Insertion is via insertBefore(replyIcon) so any existing
    // reply icon stays at the rightmost position.
    let icon;
    if (dangerous) {
      icon = document.createElement('i');
      icon.setAttribute('data-lucide', 'shield-alert');
      icon.className = 'w-3.5 h-3.5 mb-att-warn';
      icon.title = 'Pièce jointe dangereuse';
    } else if (suspicious) {
      icon = document.createElement('i');
      icon.setAttribute('data-lucide', 'paperclip');
      icon.className = 'w-3.5 h-3.5 mb-att-warn';
      icon.title = 'Pièce jointe à vérifier';
    } else if (total > 0) {
      icon = document.createElement('i');
      icon.setAttribute('data-lucide', 'paperclip');
      icon.className = 'w-3.5 h-3.5 mb-att-icon';
      icon.title = `${total} pièce${total > 1 ? 's' : ''} jointe${total > 1 ? 's' : ''}`;
    }
    if (icon) {
      const reply = rowLeft.querySelector('.mb-reply-inline');
      if (reply) rowLeft.insertBefore(icon, reply);
      else rowLeft.appendChild(icon);
    }
    window.lucide?.createIcons();
  }

  /**
   * Inject (or remove) the AI reply marker on a list card after a draft
   * is generated on demand. Always appended at the end of .mb-row-left
   * to preserve the documented visual order: sender, paperclip, reply.
   *
   * The icon is built as a real inline `<svg>` (not `<i data-lucide>`) so
   * we never depend on Lucide's `createIcons()` running at the right
   * moment — the marker shows up immediately even if Lucide is busy /
   * already finished its sweep.
   */
  function _patchCardReplyIcon(intId, on) {
    const card = host.querySelector(`.mb-card[data-id="${intId}"]`);
    if (!card) return;
    const rowLeft = card.querySelector('.mb-row-left');
    if (!rowLeft) return;
    const existing = rowLeft.querySelector('.mb-reply-inline');
    if (!on) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;  // already there, nothing to do
    rowLeft.appendChild(_buildLucideSvg(
      'reply',
      'mb-reply-inline',
      'Réponse attendue',
      '<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',
    ));
  }

  /**
   * Inject (or remove) the "draft ready" marker on a list card. Distinct
   * from the reply icon: this one signals that an AI draft has been
   * persisted and is waiting for the user to review/send. Always rendered
   * AFTER the reply icon to keep the documented order:
   *   sender → paperclip → reply → draft.
   */
  function _patchCardDraftIcon(intId, on) {
    const card = host.querySelector(`.mb-card[data-id="${intId}"]`);
    if (!card) return;
    const rowLeft = card.querySelector('.mb-row-left');
    if (!rowLeft) return;
    const existing = rowLeft.querySelector('.mb-draft-inline');
    if (!on) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    rowLeft.appendChild(_buildLucideSvg(
      'pencil-line',
      'mb-draft-inline',
      'Brouillon IA prêt',
      '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>',
    ));
  }

  /**
   * Build a real inline `<svg>` (not `<i data-lucide>`) so the icon
   * paints immediately, with zero dependency on Lucide's createIcons()
   * sweep timing. Returns the SVG element ready to insert.
   */
  function _buildLucideSvg(name, extraClass, label, innerSvg) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('class', `w-3.5 h-3.5 ${extraClass}`);
    svg.setAttribute('data-lucide', name);
    svg.setAttribute('aria-label', label);
    svg.innerHTML = innerSvg;
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    t.textContent = label;
    svg.appendChild(t);
    return svg;
  }

  function moveSelection(delta) {
    if (!state.filteredIds.length) return;
    const cur = state.filteredIds.indexOf(state.selectedId);
    let next = cur + delta;
    if (next < 0) next = 0;
    if (next >= state.filteredIds.length) next = state.filteredIds.length - 1;
    const id = state.filteredIds[next];
    if (id != null && id !== state.selectedId) {
      // Ensure the target card has been rendered (may require loading more batches).
      const list = $('#email-list');
      while (_listRendered <= next && _listRendered < _listAllItems.length) {
        _appendBatch(list, false);
      }
      const card = host.querySelector(`.mb-card[data-id="${id}"]`);
      if (card) card.scrollIntoView({ block: 'nearest' });
      openEmail(id);
    }
  }

  // ── Data loading ──────────────────────────────────────────
  async function loadAccounts() {
    try {
      const [accs, dash] = await Promise.all([
        api.getAccounts(),
        api.getDashboard().catch(() => null),
      ]);
      state.accounts = accs;
      // Merge unread counts (dashboard) with sync_error (accounts list)
      const errMap = {};
      for (const a of accs) errMap[a.email] = a.sync_error || null;

      if (dash?.accounts) {
        state.accountStats = {};
        for (const a of dash.accounts) {
          state.accountStats[a.email] = {
            unread: a.unread || 0,
            needs_reply: a.needs_reply || 0,
            total: a.total || 0,
            sync_error: errMap[a.email] || a.sync_error || null,
          };
        }
      }
      // Accounts that appear in config but have no email yet (total=0) still
      // need a stats entry so the error badge is shown for them too.
      for (const a of accs) {
        if (!state.accountStats[a.email]) {
          state.accountStats[a.email] = {
            unread: 0, needs_reply: 0, total: 0,
            sync_error: a.sync_error || null,
          };
        } else {
          state.accountStats[a.email].sync_error = errMap[a.email] || null;
        }
      }
    } catch (_) { state.accounts = []; }
    // Purge accountFilters entries that no longer exist in config
    const activeEmails = new Set(state.accounts.map((a) => a.email));
    for (const em of [...state.accountFilters]) {
      if (!activeEmails.has(em)) state.accountFilters.delete(em);
    }
    renderChips();
    renderAccounts();
    applyFilter();
    updateBadge();
  }

  async function loadEmails() {
    try {
      // For a single selected account send the API filter; for 0 or 2+ filter client-side.
      const singleAcc = state.accountFilters.size === 1 ? [...state.accountFilters][0] : undefined;
      const params = {
        limit: 2000,
        account: singleAcc,
        category: state.category || undefined,
        is_read: state.onlyUnread ? false : undefined,
        needs_reply: state.onlyReply ? true : undefined,
        folder: state.folder || 'inbox',
      };
      state.emails = await api.getEmails(params);
      // Drop selections that are no longer present in the loaded set.
      if (state.selectedIds.size) {
        const present = new Set(state.emails.map((e) => e.int_id));
        for (const id of [...state.selectedIds]) {
          if (!present.has(id)) state.selectedIds.delete(id);
        }
        renderSelectionBar();
      }
      applyFilter();

      // Auto-focus from URL ?focus=. Always open — even if the email is
      // outside the visible list (older than the 300 row cap, in another
      // folder, hidden by current filters…). openEmail() fetches the row
      // through the API so the read pane works regardless of list state.
      const m = location.hash.match(/[?&]focus=(\d+)/);
      if (m) {
        const id = parseInt(m[1], 10);
        if (Number.isFinite(id)) openEmail(id);
      } else if (!state.selectedId) {
        renderEmpty();
      }
    } catch (err) {
      $('#email-list').innerHTML = `<div style="padding:24px;color:var(--danger)">Erreur: ${escapeHtml(err.message)}</div>`;
    }
  }

  // ── Sync ──────────────────────────────────────────────────
  function setSyncSpinner(on) {
    $('#btn-sync')?.classList.toggle('syncing', on);
  }

  async function triggerSync() {
    try {
      const r = await api.triggerSync();
      window.toast(r.message || (r.ok ? 'Synchronisation lancée' : 'Sync déjà en cours'));
      setSyncSpinner(true);
      pollSync();
    } catch (err) {
      window.toast('Erreur sync: ' + err.message);
    }
  }

  let syncTimer = null;
  async function pollSync() {
    if (syncTimer) return;
    let wasRunning = false;
    const tick = async () => {
      try {
        const s = await api.getSyncStatus();
        if (s.running) {
          wasRunning = true;
          setSyncSpinner(true);
        } else {
          setSyncSpinner(false);
          if (wasRunning) {
            wasRunning = false;
            loadEmails();
            loadAccounts();
          }
        }
      } catch (_) {
        setSyncSpinner(false);
      }
    };
    syncTimer = setInterval(tick, 3000);
    tick();
  }

  // ── Search ────────────────────────────────────────────────
  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    applyFilter();
  });

  // Honour `#/inbox?q=...` so other pages (notably the cleanup workspace)
  // can deep-link to a sender-filtered view of the inbox.
  (function applyHashQuery() {
    const m = location.hash.match(/[?&]q=([^&]+)/);
    if (!m) return;
    let q;
    try { q = decodeURIComponent(m[1]); } catch (_) { q = m[1]; }
    if (!q) return;
    state.query = q;
    const inp = $('#search');
    if (inp) inp.value = q;
  })();

  // Honour `#/inbox?sort=score&unread=1` for deep-links from other views.
  (function applyHashFilters() {
    const hash = location.hash;
    const sortM = hash.match(/[?&]sort=([^&]+)/);
    if (sortM) {
      const val = sortM[1];
      if (SORT_OPTIONS.some((o) => o.value === val)) {
        state.sortMode = val;
        renderSortBtn();
      }
    }
    const unreadM = hash.match(/[?&]unread=1/);
    if (unreadM) {
      state.onlyUnread = true;
      renderChips();
    }
  })();

  // `#/inbox?smart=<id>` deep-link is handled after smart folders load (see below).

  $('#cta-compose').addEventListener('click', () => window.toast('Composer : bientôt'));

  // ── Keyboard ──────────────────────────────────────────────
  function onKey(e) {
    const k = e.detail.key;
    if (k === 'j') moveSelection(1);
    else if (k === 'k') moveSelection(-1);
    else if (k === 'Enter') {
      if (state.selectedId == null && state.filteredIds.length) openEmail(state.filteredIds[0]);
    } else if (k === 'e') {
      if (state.selectedId != null) {
        api.patchEmail(state.selectedId, { is_read: true }).catch(() => {});
        const c = host.querySelector(`.mb-card[data-id="${state.selectedId}"]`);
        if (c) c.classList.remove('unread');
      }
    }
  }
  window.addEventListener('app:key', onKey);

  // Esc clears the multi-selection (only when not typing in an input).
  function onEscape(e) {
    if (e.key !== 'Escape') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (_popCleanup) {
      e.preventDefault();
      closePopover();
      return;
    }
    if (state.selectedIds.size) {
      e.preventDefault();
      clearSelection();
    }
  }
  document.addEventListener('keydown', onEscape);

  // Auto-refresh every 60s
  const refreshTimer = setInterval(() => {
    loadEmails().catch(() => {});
    loadAccounts().catch(() => {});
  }, 60_000);

  // ── Initial render ────────────────────────────────────────
  const _mountedAt = Date.now(); // used to synchronise accounts stagger with static stagger
  renderFolders();
  renderLabels();
  renderChips();
  renderSortBtn();
  renderAccounts();
  renderEmpty();

  // Collapsible sidebar sections
  // Folders collapsed by default (unless user has explicitly opened it before)
  if (localStorage.getItem('sb-folders') === null) localStorage.setItem('sb-folders', '1');
  initCollapsible($('#title-folders'), $('#wrap-folders'), 'sb-folders');
  initCollapsible($('#title-labels'),  $('#wrap-labels'),  'sb-labels');

  // Hide sidebar items immediately so they don't flash before the stagger fires.
  host.querySelectorAll('.mb-side-head, .mb-cta, .mb-section-title, .mb-subsection-title, .mb-folder, .mb-label')
    .forEach((el) => { el.style.opacity = '0'; });

  $('#btn-sync').addEventListener('click', triggerSync);
  $('#sel-bar').addEventListener('click', onSelBarClick);

  await Promise.all([loadAccounts(), loadEmails()]);

  // Single unified stagger over all sidebar elements in DOM order once everything is loaded.
  // Order: mb-side-head → mb-cta → [folders title + folder items] → [labels title + label items]
  //        → [accounts title + account items]
  requestAnimationFrame(() => {
    const STEP = 28;
    let i = 0;
    host.querySelectorAll(
      '.mb-side-head, .mb-cta, .mb-section-title, .mb-subsection-title, .mb-folder, .mb-label'
    ).forEach((el) => {
      el.style.opacity   = '0';
      el.style.animation = 'none';
      const delay = 120 + i * STEP;
      setTimeout(() => {
        el.style.animation = `fade-up 260ms cubic-bezier(.25,.46,.45,.94) both`;
        el.style.opacity   = '';
      }, delay);
      i++;
    });
  });

  pollSync();
  window.lucide?.createIcons();

  // Cleanup on unmount
  return () => {
    if (_sortDropCleanup) _sortDropCleanup();
    closePopover();
    _teardownListObserver();
    if (syncTimer) clearInterval(syncTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    window.removeEventListener('app:key', onKey);
    document.removeEventListener('keydown', onEscape);
  };
}
