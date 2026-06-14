// SPDX-License-Identifier: GPL-3.0-or-later
import {
  api,
  avatarColor, initials, senderName, senderEmail,
  avatarImgHtml,
  shortDate, longDate, escapeHtml, linkify, isHomographUrl, safeLinkUrl,
  CATEGORY_LABEL, CATEGORY_COLOR, CATEGORY_ICON, scoreClass,
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
  const _t = window.t || ((k) => k);
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
  // <base target="_blank"> forces every <a> to request a popup. Combined
  // with the iframe's `allow-popups allow-popups-to-escape-sandbox` and
  // pywebview's default `OPEN_EXTERNAL_LINKS_IN_BROWSER=True`, this routes
  // every link click straight to the OS default browser instead of trying
  // to navigate the sandboxed iframe (which would either get blocked by
  // X-Frame-Options/CSP on most sites or trap the user inside the iframe).
  const INJECT = `<base target="_blank"><style>
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

  // 1. Anti-phishing link rewriting.
  let safeHtml = markSuspiciousLinksInHtml(em.body_html);

  // 2. Remote-image blocker. Skipped when the user previously trusted
  //    the sender or just clicked "Charger pour ce mail".
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
  const label = _t('mb.img.blocked_count', { n: blockedCount });
  const banner = `
    <div class="mb-img-banner" data-int-id="${escapeHtml(String(em.int_id))}" data-sender-domain="${escapeHtml(domain)}">
      <i data-lucide="image-off" class="w-4 h-4"></i>
      <span class="mb-img-banner-label">${label}</span>
      <span class="mb-img-banner-spacer"></span>
      <button class="mb-img-banner-btn" data-act="show-once" type="button">
        ${_t('mb.img.load_once')}
      </button>
      <button class="mb-img-banner-btn mb-img-banner-btn-trust" data-act="trust-sender" type="button" ${domain ? '' : 'disabled'}>
        ${domain ? _t('mb.img.always_for', { domain: escapeHtml(domain) }) : _t('mb.img.always_for_sender')}
      </button>
    </div>`;
  return banner + iframe;
}


// Wire up the banner buttons after the iframe has been mounted. Called
// from the same place that mounts the read pane. The closure keeps a
// reference to `em` so we can re-render on demand.
function attachImageBlockerHandlers(em) {
  const _t = window.t || ((k) => k);
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
      window.toast?.(_t('mb.img.trusted', { domain }), 2500);
    } catch (e) {
      window.toast?.(_t('mb.toast.error', { msg: e.message }), 3500);
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
  const _t = window.t || ((k) => k);
  let data = null;
  try { data = authJson ? JSON.parse(authJson) : null; } catch (_) {}
  const verdicts = data ? Object.entries(data).filter(([_, v]) => v) : [];
  let kind, icon, label, tooltip;
  if (!verdicts.length) {
    kind = 'unknown';
    icon = 'help-circle';
    label = _t('mb.auth.unknown');
    tooltip = _t('mb.auth.unknown_tip');
  } else {
    const allPass = verdicts.every(([_, v]) => v === 'pass');
    const anyBad = verdicts.some(([_, v]) => v === 'fail' || v === 'softfail' || v === 'policy');
    if (anyBad) {
      kind = 'fail';
      icon = 'shield-x';
      label = _t('mb.auth.fail');
      tooltip = _t('mb.auth.fail_tip');
    } else if (allPass) {
      kind = 'pass';
      icon = 'shield-check';
      label = _t('mb.auth.pass');
      // No tooltip — the label already says it. Adding "DKIM: pass" etc.
      // is jargon that doesn't help a non-technical reader.
      tooltip = '';
    } else {
      kind = 'warn';
      icon = 'shield-alert';
      label = _t('mb.auth.partial');
      tooltip = _t('mb.auth.partial_tip');
    }
  }
  const titleAttr = tooltip ? ` title="${escapeHtml(tooltip)}"` : '';
  return `<span class="mb-auth-badge mb-auth-${kind}"${titleAttr}>
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
  const _t = window.t || ((k) => k);
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
      a.setAttribute('title', _t('mb.link.suspicious_title'));
    }
  });
  return flagged > 0 ? doc.documentElement.outerHTML : html;
}

const FOLDERS = [
  { id: 'inbox',     labelKey: 'mb.folder.inbox',     icon: 'inbox' },
  { id: 'sent',      labelKey: 'mb.folder.sent',      icon: 'send' },
  { id: 'favourite', labelKey: 'mb.folder.favourite', icon: 'star' },
  { id: 'draft',     labelKey: 'mb.folder.draft',     icon: 'pencil' },
  { id: 'deleted',   labelKey: 'mb.folder.deleted',   icon: 'trash-2' },
];

// Returns a setter that flips the send button between three visual
// states. The label swaps to "Envoi en cours…" / "Envoyé" so users get
// real feedback during the synchronous SMTP roundtrip — without it,
// clicking Envoyer looks like nothing happened until the pane closes.
//   idle    : original label restored, button enabled
//   loading : spinner via .loading + "Envoi en cours…", disabled
//   sent    : green pulse via .is-sent + "Envoyé", disabled
function sendButtonStateFactory(btn, idleLabel = null) {
  const _t = window.t || ((k) => k);
  if (idleLabel == null) idleLabel = _t('mb.send');
  if (!btn) return () => {};
  // Cache the original label markup once so we can restore it cleanly
  // (the inner <i>+text gets replaced when we change state).
  const originalHtml = btn.innerHTML;
  return (state) => {
    btn.classList.remove('loading', 'is-sent');
    btn.disabled = state !== 'idle';
    if (state === 'loading') {
      btn.classList.add('loading');
      btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4"></i>${_t('mb.send.sending')}`;
    } else if (state === 'sent') {
      btn.classList.add('is-sent');
      btn.innerHTML = `<i data-lucide="check" class="w-4 h-4"></i>${_t('mb.send.sent')}`;
    } else {
      btn.innerHTML = originalHtml;
    }
    window.lucide?.createIcons();
  };
}

// Composer meta strip — From / To / Subject. Always rendered above the
// textarea regardless of mode; opts.mode controls only what's pre-filled.
//   - 'reply'   : pre-fills To (sender of the original) + "Re: <subject>"
//   - 'compose' : empty fields, focus lands on To
//
// The "De" picker is a custom dropdown (not a native <select>) so the
// menu shares the look of the inbox's sort-select. A hidden input
// `#mbc-from` exposes the selected email to existing form-reading code.
function buildComposerMetaHtml({ mode, accounts, defaultAccount, to = '', subject = '' }) {
  const _t = window.t || ((k) => k);
  const chevron = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  const accs = Array.isArray(accounts) ? accounts.filter((a) => a && a.email) : [];
  const fallback = (defaultAccount || (accs[0] && accs[0].email) || '').toLowerCase();

  // One row of the picker — both the closed-state button content and
  // each open-state option share the same shape: a colored avatar
  // bubble + the friendly name + the email muted next to it. No "<>"
  // wrapping, no HTML escaping for nested template parts (we escape
  // each interpolated value individually).
  const renderRow = (a) => {
    const col = avatarColor(a.email || '');
    const ini = initials(a.name || a.email || '?');
    const name = a.name && a.name.trim() ? a.name : '';
    return `
      <span class="acc-select-av" style="background:${col}">${escapeHtml(ini)}</span>
      <span class="acc-select-text">
        ${name ? `<span class="acc-select-name">${escapeHtml(name)}</span>` : ''}
        <span class="acc-select-email">${escapeHtml(a.email || '')}</span>
      </span>
    `;
  };

  const selectedAcc = accs.find((a) => (a.email || '').toLowerCase() === fallback) || accs[0];
  const selectedValue = selectedAcc ? selectedAcc.email : (defaultAccount || '');
  const selectedRow = selectedAcc
    ? renderRow(selectedAcc)
    : `<span class="acc-select-text"><span class="acc-select-email">${escapeHtml(defaultAccount || _t('mb.composer.no_account'))}</span></span>`;

  const opts = accs.length
    ? accs.map((a) => {
        const isActive = (a.email || '').toLowerCase() === fallback;
        return `<div class="acc-select-opt ${isActive ? 'active' : ''}" data-val="${escapeHtml(a.email)}" data-name="${escapeHtml(a.name || '')}" role="option" aria-selected="${isActive}">${renderRow(a)}</div>`;
      }).join('')
    : `<div class="acc-select-opt active" data-val="${escapeHtml(defaultAccount || '')}">${selectedRow}</div>`;

  return `
    <div class="mb-composer-meta" data-mode="${escapeHtml(mode || 'reply')}">
      <div class="mbc-row mbc-row-from">
        <span class="mbc-key">${_t('mb.composer.from')}</span>
        <div class="mbc-select">
          <button class="mbc-select-btn" type="button" aria-haspopup="listbox" aria-expanded="false">
            <span class="mbc-select-label">${selectedRow}</span>
            ${chevron}
          </button>
          <div class="mbc-select-drop" role="listbox" aria-label="${_t('mb.composer.from_aria')}">
            ${opts}
          </div>
          <input type="hidden" id="mbc-from" value="${escapeHtml(selectedValue)}">
        </div>
      </div>
      <label class="mbc-row">
        <span class="mbc-key">${_t('mb.composer.to')}</span>
        <input id="mbc-to" class="mbc-input" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(to)}" placeholder="${_t('mb.composer.to_ph')}">
      </label>
      <label class="mbc-row">
        <span class="mbc-key">${_t('mb.composer.subject')}</span>
        <input id="mbc-subject" class="mbc-input" type="text" value="${escapeHtml(subject)}" placeholder="${_t('mb.no_subject')}">
      </label>
    </div>
  `;
}

// Wire up clicks on the custom From-account dropdown (toggle, select,
// outside-click close). The outside-click listener self-cleans when the
// wrap is detached from the DOM, which happens when renderEmpty() wipes
// the read pane after a send.
function bindComposerFromDropdown(scope) {
  const wrap = scope.querySelector('.mbc-select');
  if (!wrap) return;
  const btn         = wrap.querySelector('.mbc-select-btn');
  const drop        = wrap.querySelector('.mbc-select-drop');
  const hiddenInput = wrap.querySelector('input[type="hidden"]');
  const labelEl     = wrap.querySelector('.mbc-select-label');

  btn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !wrap.classList.contains('open');
    wrap.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
  });

  drop?.querySelectorAll('.acc-select-opt').forEach((opt) => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      hiddenInput.value = opt.dataset.val || '';
      // Mirror the option's avatar+name+email block into the closed-
      // state button so the visual is identical to what the user just
      // picked. Using innerHTML (not textContent) preserves the avatar
      // bubble + the muted-email row.
      if (labelEl) labelEl.innerHTML = opt.innerHTML;
      drop.querySelectorAll('.acc-select-opt').forEach((o) => {
        o.classList.toggle('active', o === opt);
        o.setAttribute('aria-selected', String(o === opt));
      });
      wrap.classList.remove('open');
      btn?.setAttribute('aria-expanded', 'false');
    });
  });

  const onOutside = (e) => {
    if (!document.body.contains(wrap)) {
      document.removeEventListener('click', onOutside);
      return;
    }
    if (!wrap.contains(e.target)) {
      wrap.classList.remove('open');
      btn?.setAttribute('aria-expanded', 'false');
    }
  };
  document.addEventListener('click', onOutside);
}

const LABELS = [
  { id: 'important',     label: 'Important',      color: '#FCA5A5', icon: 'star' },
  { id: 'transactional', label: 'Transactionnel', color: '#86EFAC', icon: 'receipt' },
  { id: 'newsletter',    label: 'Newsletter',     color: '#93C5FD', icon: 'newspaper' },
  { id: 'other',         label: 'Autre',          color: '#C4B5FD', icon: 'tag' },
  { id: 'pending',       label: 'En attente',     color: '#FCD34D', icon: 'clock' },
  { id: 'spam',          label: 'Spam',           color: '#CBD5E1', icon: 'shield-x' },
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
  const t = window.t || ((k) => k);
  const FOLDERS_L = FOLDERS.map((f) => ({ ...f, label: t(f.labelKey) }));
  host.innerHTML = `
    <section class="mailbox no-selection" aria-label="${t('mb.aria.mailbox')}">
      <aside class="mb-side mb-stagger" aria-label="${t('mb.aria.sidebar')}">
        <div class="mb-side-head">
          <h1>${t('mb.title')}</h1>
          <button class="icon-btn" id="btn-sync" aria-label="${t('mb.sync')}" title="${t('mb.sync')}">
            <i data-lucide="refresh-cw" class="w-4 h-4"></i>
          </button>
        </div>
        <button class="mb-cta" id="cta-compose">
          <i data-lucide="mail-plus" class="w-4 h-4"></i>
          <span>${t('mb.compose')}</span>
        </button>

        <div class="mb-side-scroll">

        <!--
          Each .mb-side-section wrapper is baked into the markup. The
          drag-to-reorder code (setupSidebarReorder) used to wrap them
          via appendChild at mount time, but that re-parenting restarts
          CSS animations on the children — only on the "middle" sections,
          since #title-folders was first in DOM order and #title-accounts
          didn't exist yet at wrap time. Pre-wrapping eliminates that
          asymmetry; the drag code now just attaches event listeners.
        -->
        <div class="mb-side-section" data-section="folders">
          <div class="mb-section-title" id="title-folders">
            <span>${t('mb.sidebar.folders')}</span>
            <div style="display:flex;align-items:center;gap:4px">
              <button class="icon-btn" id="btn-add-folder" aria-label="${t('mb.folder.create')}" onclick="event.stopPropagation()">
                <i data-lucide="plus" class="w-4 h-4"></i>
              </button>
              <svg class="mb-collapse-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </div>
          <div class="mb-collapsible" id="wrap-folders">
            <div class="mb-collapsible-inner">
              <div class="mb-section" id="mb-folders"></div>
            </div>
          </div>
        </div>

        <div class="mb-side-section" data-section="labels">
          <div class="mb-section-title" id="title-labels">
            <span>${t('mb.sidebar.categories')}</span>
            <svg class="mb-collapse-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div class="mb-collapsible" id="wrap-labels">
            <div class="mb-collapsible-inner">
              <div class="mb-section" id="mb-labels"></div>
            </div>
          </div>
        </div>

        <div class="mb-side-section" data-section="userlabels">
          <div class="mb-section-title" id="title-userlabels">
            <span>${t('mb.sidebar.labels')}</span>
            <div style="display:flex;align-items:center;gap:4px">
              <button class="icon-btn" id="btn-add-label" aria-label="${t('mb.label.add')}" onclick="event.stopPropagation()">
                <i data-lucide="plus" class="w-4 h-4"></i>
              </button>
              <svg class="mb-collapse-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </div>
          <div class="mb-collapsible" id="wrap-userlabels">
            <div class="mb-collapsible-inner">
              <div class="mb-section" id="mb-userlabels"></div>
            </div>
          </div>
        </div>

        <div class="mb-side-section" data-section="accounts">
          <div id="mb-accounts-wrap"></div>
        </div>

        </div><!-- /.mb-side-scroll -->
      </aside>

      <div class="mb-list-wrap">
        <div class="mb-search">
          <div class="mb-search-input">
            <i data-lucide="search" class="icn w-4 h-4"></i>
            <input type="text" id="search" data-role="search" placeholder="${t('mb.search.placeholder')}" aria-label="${t('mb.search.label')}" />
          </div>
          <div class="mb-chips" id="filter-chips"></div>
          <div class="mb-search-actions">
            <button class="mb-select-all-btn" id="sel-all-global" title="${t('mb.sel.all')}" aria-label="${t('mb.sel.all')}">
              <i data-lucide="check-square" class="w-4 h-4"></i>
              <span>${t('mb.sel.all_short')}</span>
            </button>
            <button class="sort-select-btn" id="thread-toggle" type="button"
                    title="${t('mb.thread.toggle')}" aria-pressed="false">
              <i data-lucide="messages-square" class="w-4 h-4"></i>
            </button>
            <div class="sort-select" id="sort-select-wrap"></div>
          </div>
        </div>
        <div class="mb-sel-bar" id="sel-bar" hidden>
          <div class="sel-left">
            <button class="sel-btn" data-act="clear" title="${t('mb.sel.clear')}" aria-label="${t('mb.sel.clear')}">
              <i data-lucide="x" class="w-4 h-4"></i>
            </button>
            <span class="sel-count"><strong id="sel-count-num">0</strong> ${t('mb.sel.count_label')}</span>
          </div>
          <div class="sel-actions">
            <button class="sel-btn" id="sel-btn-read" data-act="read" title="${t('mb.action.mark_read')}" aria-label="${t('mb.action.mark_read')}">
              <i data-lucide="mail-open" class="w-4 h-4"></i>
            </button>
            <button class="sel-btn" data-act="tag" title="${t('mb.action.tag')}" aria-label="${t('mb.action.tag')}">
              <i data-lucide="tag" class="w-4 h-4"></i>
            </button>
            <button class="sel-btn" data-act="move" title="${t('mb.action.move')}" aria-label="${t('mb.action.move')}">
              <i data-lucide="folder-input" class="w-4 h-4"></i>
            </button>
            <button class="sel-btn" data-act="ai" title="${t('mb.action.ai_analyze')}" aria-label="${t('mb.action.ai_analyze')}">
              <i data-lucide="sparkles" class="w-4 h-4"></i>
            </button>
            <div class="sel-sep"></div>
            <button class="sel-btn danger" data-act="delete" title="${t('mb.action.delete')}" aria-label="${t('mb.action.delete')}">
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
    { value: 'date-desc', label: t('mb.sort.date_desc'),  short: t('mb.sort.date_desc_short') },
    { value: 'date-asc',  label: t('mb.sort.date_asc'),   short: t('mb.sort.date_asc_short') },
    { value: 'score',     label: t('mb.sort.score'),      short: t('mb.sort.score_short') },
    { value: 'sender',    label: t('mb.sort.sender'),     short: t('mb.sort.sender_short') },
  ];

  const state = {
    folder: 'inbox',
    category: '',     // '' = all
    query: '',
    searchResults: null,  // server-side search hits while a query is active
    threadView: (() => { try { return localStorage.getItem('mb-thread-view') === '1'; } catch (_) { return false; } })(),
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
    userLabels: [],   // Phase 3 — personal labels list
    labelFilter: null, // Phase 3 — null = no filter, otherwise label id
    customFolders: [], // Phase 4 — user-defined sidebar folders
  };

  const $ = (sel) => host.querySelector(sel);

  // ── Collapsible sidebar sections ──────────────────────────
  function initCollapsible(titleEl, wrapEl, storageKey, { defaultCollapsed = false } = {}) {
    if (!titleEl || !wrapEl) return;
    // null = key has never been written → fall back to the
    // section-specific default (open for FOLDERS/CATEGORIES/COMPTES,
    // closed for ÉTIQUETTES). Once the user has toggled it the stored
    // '0' / '1' takes over regardless of the default.
    const stored = localStorage.getItem(storageKey);
    const collapsed = stored === null ? defaultCollapsed : stored === '1';
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

  // ── Sidebar drag-and-drop reordering ──────────────────────
  // Wrap the four logical sections (Dossiers / Catégories / Étiquettes
  // / Comptes) in `.mb-side-section` containers, then wire HTML5 drag
  // events on each title so users can rearrange them. Order persists
  // in localStorage. Dragging the title itself (not the content) is
  // the affordance — the cursor changes to grab on hover.
  const _SIDEBAR_SECTIONS = [
    { id: 'folders',    members: ['#title-folders',    '#wrap-folders']    },
    { id: 'labels',     members: ['#title-labels',     '#wrap-labels']     },
    { id: 'userlabels', members: ['#title-userlabels', '#wrap-userlabels'] },
    { id: 'accounts',   members: ['#mb-accounts-wrap']                     },
  ];
  const _SIDEBAR_ORDER_KEY = 'sb-section-order-v1';

  function setupSidebarReorder() {
    const scroll = host.querySelector('.mb-side-scroll');
    if (!scroll || scroll.dataset.reorderReady === '1') return;

    // Wrappers are baked into the static markup now. We just attach the
    // drag handlers; no DOM moves, no animation restarts on the children.
    host.querySelectorAll('.mb-side-section').forEach((wrap) => {
      wireSectionDrag(wrap);
    });

    // Restore saved order — append in order, last entries first wins
    // because appendChild moves to the end. NOTE: this DOES re-parent
    // the sections (and so may restart child animations the first frame
    // after mount). It only runs when the user has previously reordered
    // sections; default order matches the markup and triggers no moves.
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(_SIDEBAR_ORDER_KEY) || '[]'); } catch (_) {}
    if (Array.isArray(saved) && saved.length) {
      const declared = _SIDEBAR_SECTIONS.map((s) => s.id);
      // No-op when the saved order is identical to the declared order —
      // avoids a useless reparent (and its animation-restart side effect).
      const same = saved.length === declared.length
        && saved.every((id, i) => id === declared[i]);
      if (!same) for (const id of saved) {
        const w = host.querySelector(`.mb-side-section[data-section="${id}"]`);
        if (w) scroll.appendChild(w);
      }
      // Any unsaved (newer) section stays at its declared position
      // relative to the others — already correct.
    }

    scroll.dataset.reorderReady = '1';
  }

  function wireSectionDrag(section) {
    const title = section.querySelector('.mb-section-title');
    if (!title) return;
    // Only the title is the drag handle. Content stays interactive.
    title.draggable = true;
    title.classList.add('mb-side-drag-handle');

    title.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/section-id', section.dataset.section);
      e.dataTransfer.effectAllowed = 'move';
      // Slight delay so the browser captures the drag image before
      // the source class kicks in (some browsers snapshot late).
      setTimeout(() => section.classList.add('is-dragging'), 0);
    });
    title.addEventListener('dragend', () => {
      section.classList.remove('is-dragging');
      host.querySelectorAll('.mb-side-section').forEach((s) => {
        s.classList.remove('drop-above', 'drop-below');
      });
    });

    section.addEventListener('dragover', (e) => {
      // Filter out non-section drags — copy/paste, file drops, etc.
      if (!Array.from(e.dataTransfer.types).includes('text/section-id')) return;
      // Don't decorate the source section itself — dropping on self
      // is a no-op and the line would just look stuck.
      if (section.classList.contains('is-dragging')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = section.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      section.classList.toggle('drop-above', above);
      section.classList.toggle('drop-below', !above);
    });
    section.addEventListener('dragleave', (e) => {
      // Only clear when the cursor leaves the section box; nested
      // children fire dragleave too which would flicker the indicator.
      if (e.currentTarget.contains(e.relatedTarget)) return;
      section.classList.remove('drop-above', 'drop-below');
    });
    section.addEventListener('drop', (e) => {
      const draggedId = e.dataTransfer.getData('text/section-id');
      section.classList.remove('drop-above', 'drop-below');
      if (!draggedId || draggedId === section.dataset.section) return;
      const dragged = host.querySelector(`.mb-side-section[data-section="${draggedId}"]`);
      if (!dragged) return;
      e.preventDefault();
      const rect = section.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      if (above) section.parentNode.insertBefore(dragged, section);
      else section.parentNode.insertBefore(dragged, section.nextSibling);
      saveSidebarOrder();
    });
  }

  function saveSidebarOrder() {
    const order = [...host.querySelectorAll('.mb-side-section')]
      .map((s) => s.dataset.section)
      .filter(Boolean);
    try { localStorage.setItem(_SIDEBAR_ORDER_KEY, JSON.stringify(order)); } catch (_) {}
  }

  // ── Render: folders + labels ──────────────────────────────
  function renderFolders() {
    const cont = $('#mb-folders');
    const builtins = FOLDERS_L.map((f) => {
      const badgeId = f.id === 'inbox' ? 'badge-inbox'
                    : f.id === 'favourite' ? 'badge-favourite'
                    : f.id === 'draft' ? 'badge-draft'
                    : null;
      const badgeHtml = badgeId
        ? `<span class="badge" id="${badgeId}" hidden>0</span>`
        : '';
      return `
      <button class="mb-folder ${state.folder === f.id ? 'active' : ''}" data-folder="${f.id}">
        <i data-lucide="${f.icon}" class="w-4 h-4"></i>
        <span class="lab">${f.label}</span>
        ${badgeHtml}
      </button>`;
    }).join('');
    // Phase 4 — append the user's custom folders. Each row carries
    // an "edit" pencil (visible on hover) for rename/delete.
    const customs = (state.customFolders || []).map((f) => `
      <button class="mb-folder ${state.folder === f.name ? 'active' : ''}" data-folder="${escapeHtml(f.name)}" data-folder-id="${f.id}">
        <i data-lucide="folder" class="w-4 h-4"></i>
        <span class="lab">${escapeHtml(f.name)}</span>
        <button class="mb-folder-edit" data-edit-folder="${f.id}" title="${t('mb.folder.edit_title')}" aria-label="${t('mb.edit')}">
          <i data-lucide="more-horizontal" class="w-3 h-3"></i>
        </button>
      </button>
    `).join('');
    cont.innerHTML = builtins + customs;
    // Materialise the <i data-lucide> placeholders into real <svg> at
    // the same instant the buttons land in the DOM. Otherwise the
    // sidebar cascade animation begins on placeholders, the global
    // `createIcons()` at the end of mount swaps them in late, and the
    // user sees icons "appear after" their text label.
    window.lucide?.createIcons({ el: cont });
    cont.querySelectorAll('.mb-folder').forEach((b) => {
      b.addEventListener('click', (e) => {
        // Ignore clicks on the inline edit chevron — handled below.
        if (e.target.closest('.mb-folder-edit')) return;
        const folder = b.dataset.folder;
        if (folder === state.folder) return;
        state.folder = folder;
        renderEmpty();
        clearSelection();
        renderFolders();
        loadEmails();
      });
    });
    cont.querySelectorAll('[data-edit-folder]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const id = parseInt(b.dataset.editFolder, 10);
        const folder = (state.customFolders || []).find((f) => f.id === id);
        if (folder) openFolderModal(folder);
      });
    });
  }

  async function loadCustomFolders() {
    try {
      state.customFolders = await api.getFolders();
    } catch (_) {
      state.customFolders = [];
    }
    renderFolders();
  }

  let _labelsFingerprint = '';

  function renderLabels() {
    const cont = $('#mb-labels');
    // Compute category unread counts from loaded emails
    const catCounts = {};
    for (const em of state.emails || []) {
      const c = em.category || 'other';
      if (!em.is_read) catCounts[c] = (catCounts[c] || 0) + 1;
    }
    const totalUnread = state.emails?.filter((e) => !e.is_read).length || 0;
    const fp = state.category + '|' + totalUnread + '|' + LABELS.map((l) => l.id + ':' + (catCounts[l.id] || 0)).join(',');
    if (fp === _labelsFingerprint && cont.firstElementChild) {
      // Only active class sync when counts unchanged
      cont.querySelectorAll('.mb-label').forEach((b) => {
        b.classList.toggle('active', b.dataset.cat === state.category);
      });
      return;
    }
    _labelsFingerprint = fp;
    cont.innerHTML = `
      <button class="mb-label ${state.category === '' ? 'active' : ''}" data-cat="">
        <i data-lucide="inbox" class="cat-icon" style="color:var(--muted-2)"></i>
        <span class="lab">Toutes</span>
        ${totalUnread > 0 ? `<span class="mb-label-count">${totalUnread}</span>` : ''}
      </button>
    ` + LABELS.map((l) => {
      const cnt = catCounts[l.id] || 0;
      return `
      <button class="mb-label ${state.category === l.id ? 'active' : ''}" data-cat="${l.id}">
        <i data-lucide="${l.icon}" class="cat-icon" style="color:${l.color}"></i>
        <span class="lab">${l.label}</span>
        ${cnt > 0 ? `<span class="mb-label-count">${cnt}</span>` : ''}
      </button>
    `}).join('');
    window.lucide?.createIcons({ el: cont });
    cont.querySelectorAll('.mb-label').forEach((b) => {
      b.addEventListener('click', () => {
        state.category = b.dataset.cat;
        _filterDidChange = true;
        renderLabels();
        applyFilter(true); // skip chips re-render, applyFilter will call it
      });
    });
  }

  // Phase 3 — render the personal-labels block. Click a label to scope
  // the inbox to it; click "Toutes" / a second click on the active row
  // clears the filter. Right-click opens a quick rename/recolour/delete
  // popover (handled separately).
  function renderUserLabels() {
    const cont = $('#mb-userlabels');
    if (!cont) return;
    if (!state.userLabels.length) {
      cont.innerHTML = `<div class="mb-userlabel-empty">${t('mb.label.empty')}</div>`;
      return;
    }
    const allRow = `
      <button class="mb-label ${state.labelFilter == null ? 'active' : ''}" data-label-id="">
        <i data-lucide="tags" class="cat-icon" style="color:var(--muted-2)"></i>
        <span class="lab">${t('mb.label.all')}</span>
      </button>
    `;
    cont.innerHTML = allRow + state.userLabels.map((l) => `
      <button class="mb-label ${state.labelFilter === l.id ? 'active' : ''}" data-label-id="${l.id}" title="${escapeHtml(l.name)}">
        <span class="mb-userlabel-dot" style="background:${escapeHtml(l.color)}"></span>
        <span class="lab">${escapeHtml(l.name)}</span>
        <button class="mb-userlabel-edit" data-edit-label="${l.id}" title="${t('mb.edit')}" aria-label="${t('mb.edit')}">
          <i data-lucide="more-horizontal" class="w-3 h-3"></i>
        </button>
      </button>
    `).join('');
    window.lucide?.createIcons({ el: cont });
    cont.querySelectorAll('.mb-label').forEach((b) => {
      b.addEventListener('click', (e) => {
        // Edit chevron handled separately so a click there doesn't
        // also flip the filter.
        if (e.target.closest('.mb-userlabel-edit')) return;
        const raw = b.dataset.labelId;
        const id = raw === '' || raw == null ? null : parseInt(raw, 10);
        // Toggle: clicking the active row clears the filter.
        state.labelFilter = state.labelFilter === id ? null : id;
        renderUserLabels();
        loadEmails();
      });
    });
    cont.querySelectorAll('[data-edit-label]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const id = parseInt(b.dataset.editLabel, 10);
        const label = state.userLabels.find((l) => l.id === id);
        if (label) openLabelModal(label);
      });
    });
  }

  async function loadUserLabels() {
    try {
      state.userLabels = await api.getLabels();
    } catch (_) {
      state.userLabels = [];
    }
    renderUserLabels();
  }

  // Curated palette so users don't have to invent colours; click a
  // swatch to assign. The order keeps the hottest hues first so the
  // most common picks (Important / Travail / Famille) feel obvious.
  const LABEL_PALETTE = [
    '#FCA5A5', '#FBBF24', '#FACC15', '#86EFAC', '#67E8F9',
    '#93C5FD', '#A5B4FC', '#C4B5FD', '#F0ABFC', '#F472B6',
    '#94A3B8', '#475569',
  ];

  // Modal for creating, renaming and recolouring (+ deleting) a
  // personal label. `existing` is null for create, a label row for
  // edit. The DOM is built per-call and torn down on close — there
  // are at most two label modals' worth of state in the page so
  // this stays cheap.
  function openLabelModal(existing) {
    // Tear down any previous instance (defensive — protects against
    // double clicks on the "+" button while one is animating in).
    document.querySelectorAll('.mb-label-modal-backdrop').forEach((el) => el.remove());

    const isEdit = !!existing;
    const startName  = existing?.name  || '';
    const startColor = existing?.color || LABEL_PALETTE[0];

    const backdrop = document.createElement('div');
    backdrop.className = 'mb-label-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.innerHTML = `
      <div class="mb-label-modal-card">
        <div class="mb-label-modal-head">
          <h3>${isEdit ? t('mb.label.modal.edit_title') : t('mb.label.modal.new_title')}</h3>
          <button class="icon-btn mb-label-modal-close" aria-label="${t('mb.close')}"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
        <div class="mb-label-modal-body">
          <label class="mb-label-modal-field">
            <span>${t('mb.label.modal.name')}</span>
            <input type="text" id="mb-label-name" maxlength="60" value="${escapeHtml(startName)}" placeholder="${t('mb.label.modal.name_ph')}" autocomplete="off">
          </label>
          <div class="mb-label-modal-field">
            <span>${t('mb.label.modal.color')}</span>
            <div class="mb-label-palette">
              ${LABEL_PALETTE.map((c) => `<button type="button" class="mb-label-swatch ${c.toLowerCase() === startColor.toLowerCase() ? 'is-active' : ''}" style="background:${c}" data-color="${c}" aria-label="${c}"></button>`).join('')}
            </div>
          </div>
          <div class="mb-label-modal-preview">
            <span>${t('mb.label.modal.preview')}</span>
            <span class="mb-label-chip" id="mb-label-preview-chip" style="background:${startColor}33;color:${startColor}">
              <span class="mb-label-chip-dot" style="background:${startColor}"></span>
              <span id="mb-label-preview-text">${escapeHtml(startName || t('mb.label.modal.preview_fallback'))}</span>
            </span>
          </div>
        </div>
        <div class="mb-label-modal-footer">
          ${isEdit ? `<button class="mb-label-modal-delete" id="mb-label-modal-delete" type="button">${t('mb.delete')}</button>` : ''}
          <span style="flex:1"></span>
          <button class="mb-label-modal-cancel" type="button">${t('mb.cancel')}</button>
          <button class="mb-label-modal-save" type="button" id="mb-label-modal-save">${isEdit ? t('mb.save') : t('mb.create')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    window.lucide?.createIcons({ el: backdrop });

    const nameEl    = backdrop.querySelector('#mb-label-name');
    const swatches  = backdrop.querySelectorAll('.mb-label-swatch');
    const chipEl    = backdrop.querySelector('#mb-label-preview-chip');
    const chipDot   = chipEl.querySelector('.mb-label-chip-dot');
    const chipText  = backdrop.querySelector('#mb-label-preview-text');
    let currentColor = startColor;

    const close = () => backdrop.remove();
    backdrop.querySelector('.mb-label-modal-close').addEventListener('click', close);
    backdrop.querySelector('.mb-label-modal-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    const repaintPreview = () => {
      chipEl.style.background = `${currentColor}33`;
      chipEl.style.color = currentColor;
      chipDot.style.background = currentColor;
      chipText.textContent = nameEl.value.trim() || t('mb.label.modal.preview_fallback');
    };

    nameEl.addEventListener('input', repaintPreview);
    swatches.forEach((s) => {
      s.addEventListener('click', () => {
        currentColor = s.dataset.color;
        swatches.forEach((o) => o.classList.toggle('is-active', o === s));
        repaintPreview();
      });
    });
    setTimeout(() => { nameEl.focus(); nameEl.select(); }, 0);

    backdrop.querySelector('#mb-label-modal-save').addEventListener('click', async () => {
      const name = nameEl.value.trim();
      if (!name) { window.toast(t('mb.label.toast.name_required')); nameEl.focus(); return; }
      try {
        if (isEdit) {
          await api.updateLabel(existing.id, { name, color: currentColor });
          // Patch every cached `em.labels` entry that referenced this
          // label so cards repaint with the new name/colour without
          // waiting for a backend reload. Same for the read pane row.
          for (const em of state.emails) {
            if (!Array.isArray(em.labels)) continue;
            for (const l of em.labels) {
              if (l.id === existing.id) { l.name = name; l.color = currentColor; }
            }
          }
          applyFilter();
          // If the open email is showing chips for this label, refresh
          // the read pane too so its header matches.
          if (state.selectedId != null) {
            const em = state.emails.find((e) => e.int_id === state.selectedId);
            if (em && em.labels?.some((l) => l.id === existing.id)) {
              try { renderEmail(em); } catch (_) {}
            }
          }
          window.toast(t('mb.label.toast.updated'));
        } else {
          await api.createLabel({ name, color: currentColor });
          window.toast(t('mb.label.toast.created'));
        }
        close();
        await loadUserLabels();
      } catch (err) {
        window.toast(err?.message || t('mb.toast.fail'));
      }
    });

    if (isEdit) {
      backdrop.querySelector('#mb-label-modal-delete').addEventListener('click', async () => {
        if (!confirm(t('mb.label.confirm.delete', { name: existing.name }))) return;
        try {
          await api.deleteLabel(existing.id);
          window.toast(t('mb.label.toast.deleted'));
          close();
          // If the user was filtered on this label, drop the filter.
          if (state.labelFilter === existing.id) state.labelFilter = null;
          // Strip the deleted label from every cached row so chips
          // disappear immediately without a network round-trip.
          for (const em of state.emails) {
            if (!Array.isArray(em.labels)) continue;
            em.labels = em.labels.filter((l) => l.id !== existing.id);
          }
          applyFilter();
          if (state.selectedId != null) {
            const em = state.emails.find((e) => e.int_id === state.selectedId);
            if (em) {
              try { renderEmail(em); } catch (_) {}
            }
          }
          await loadUserLabels();
        } catch (err) {
          window.toast(err?.message || t('mb.toast.fail_delete'));
        }
      });
    }

    // Esc to close. Bound to the backdrop so it doesn't leak past
    // teardown.
    backdrop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
  }

  // Phase 4 — create / rename / delete a custom sidebar folder.
  // Reuses the .mb-label-modal-* pattern for visual consistency.
  function openFolderModal(existing) {
    document.querySelectorAll('.mb-label-modal-backdrop').forEach((el) => el.remove());

    const isEdit = !!existing;
    const startName = existing?.name || '';

    const backdrop = document.createElement('div');
    backdrop.className = 'mb-label-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.innerHTML = `
      <div class="mb-label-modal-card">
        <div class="mb-label-modal-head">
          <h3>${isEdit ? t('mb.folder.modal.edit_title') : t('mb.folder.modal.new_title')}</h3>
          <button class="icon-btn mb-label-modal-close" aria-label="${t('mb.close')}"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
        <div class="mb-label-modal-body">
          <label class="mb-label-modal-field">
            <span>${t('mb.folder.modal.name')}</span>
            <input type="text" id="mb-folder-name" maxlength="40" value="${escapeHtml(startName)}" placeholder="${t('mb.folder.modal.name_ph')}" autocomplete="off">
          </label>
          <div class="mb-folder-modal-hint" style="font-size:11.5px;color:var(--muted);line-height:1.4">
            ${t('mb.folder.modal.hint')}
          </div>
        </div>
        <div class="mb-label-modal-footer">
          ${isEdit ? `<button class="mb-label-modal-delete" id="mb-folder-modal-delete" type="button">${t('mb.delete')}</button>` : ''}
          <span style="flex:1"></span>
          <button class="mb-label-modal-cancel" type="button">${t('mb.cancel')}</button>
          <button class="mb-label-modal-save" type="button" id="mb-folder-modal-save">${isEdit ? t('mb.save') : t('mb.create')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    window.lucide?.createIcons({ el: backdrop });

    const nameEl = backdrop.querySelector('#mb-folder-name');
    const close = () => backdrop.remove();
    backdrop.querySelector('.mb-label-modal-close').addEventListener('click', close);
    backdrop.querySelector('.mb-label-modal-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    setTimeout(() => { nameEl.focus(); nameEl.select(); }, 0);

    backdrop.querySelector('#mb-folder-modal-save').addEventListener('click', async () => {
      const name = nameEl.value.trim();
      if (!name) { window.toast(t('mb.folder.toast.name_required')); nameEl.focus(); return; }
      try {
        if (isEdit) {
          await api.updateFolder(existing.id, { name });
          // If the user was viewing this folder, follow the rename.
          if (state.folder === existing.name) state.folder = name;
          window.toast(t('mb.folder.toast.renamed'));
        } else {
          await api.createFolder(name);
          window.toast(t('mb.folder.toast.created'));
        }
        close();
        await loadCustomFolders();
        loadEmails();
      } catch (err) {
        window.toast(err?.message || t('mb.toast.fail'));
      }
    });

    if (isEdit) {
      backdrop.querySelector('#mb-folder-modal-delete').addEventListener('click', async () => {
        if (!confirm(t('mb.folder.confirm.delete', { name: existing.name }))) return;
        try {
          await api.deleteFolder(existing.id);
          window.toast(t('mb.folder.toast.deleted'));
          close();
          // Drop the filter if the user was on the deleted folder.
          if (state.folder === existing.name) state.folder = 'inbox';
          await loadCustomFolders();
          loadEmails();
        } catch (err) {
          window.toast(err?.message || t('mb.toast.fail_delete'));
        }
      });
    }

    backdrop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
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

  // Structural fingerprint: which accounts exist and in what type+name
  // shape. Periodic refreshes that don't change the set should NOT
  // rebuild the sidebar DOM — that wipes focus/hover/tooltip state and
  // makes the sidebar visibly flicker every 60s. We patch badge counts
  // and the active-state classes in place instead.
  let _accountsFingerprint = '';

  function _patchAccountBadges(section) {
    for (const a of state.accounts) {
      const btn = section.querySelector(`[data-acc="${CSS.escape(a.email)}"]`);
      if (!btn) continue;
      const badge = btn.querySelector('.mb-acc-badge');
      if (!badge) continue;
      const stats = state.accountStats[a.email];
      const unread = stats?.unread ?? 0;
      const err = stats?.sync_error || null;
      if (err) {
        badge.classList.add('error');
        badge.classList.remove('on-active');
        badge.textContent = '!';
        badge.setAttribute('title', err);
      } else {
        badge.classList.remove('error');
        badge.removeAttribute('title');
        badge.textContent = String(unread);
      }
    }
    section.querySelectorAll('[data-sub-type]').forEach((titleEl) => {
      const type = titleEl.dataset.subType;
      const accs = state.accounts.filter((a) =>
        (ACCOUNT_TYPE_META[a.type] ? a.type : 'other') === type
      );
      const total = accs.reduce(
        (sum, a) => sum + (state.accountStats[a.email]?.unread ?? 0), 0
      );
      let countEl = titleEl.querySelector('.mb-acc-type-count');
      if (total > 0) {
        if (!countEl) {
          countEl = document.createElement('span');
          countEl.className = 'mb-acc-type-count';
          const chev = titleEl.querySelector('.mb-collapse-icon');
          titleEl.insertBefore(countEl, chev);
        }
        countEl.textContent = String(total);
      } else if (countEl) {
        countEl.remove();
      }
    });
  }

  function renderAccounts() {
    const outerWrap = $('#mb-accounts-wrap');
    if (!outerWrap) return;
    if (!state.accounts.length) {
      outerWrap.innerHTML = '';
      _accountsFingerprint = '';
      return;
    }

    const chevSvg = `<svg class="mb-collapse-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

    // Build the stable shell once — keeps the collapsible wrapper intact
    // across re-renders. The .mb-stagger class on .mb-side handles the
    // entrance animation declaratively, so we no longer need to stamp
    // style="opacity:0" inline on these nodes.
    if (!$('#wrap-accounts')) {
      outerWrap.innerHTML = `
        <div class="mb-section-title" id="title-accounts">
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

    // Skip the full innerHTML rebuild when the structural set of
    // accounts (email + type + name) is identical to the last paint.
    // Background refresh just wants to refresh badge counts; rebuilding
    // the whole sidebar every 60s flickers the UI, drops focus, and
    // closes any popover/tooltip the user was looking at.
    const fingerprint = state.accounts
      .map((a) => `${a.email}|${a.type || 'other'}|${a.name || ''}`)
      .join(';');
    if (fingerprint === _accountsFingerprint && section.firstElementChild) {
      _patchAccountBadges(section);
      _syncAccountActive(section);
      return;
    }
    _accountsFingerprint = fingerprint;

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
      // Per-provider subgroups (PROTON MAIL / GMAIL / …) default to
      // collapsed when the user has never touched the toggle: the
      // sidebar gets long fast on multi-account setups and a folded
      // view is the cleaner starting point. Once toggled, the explicit
      // '0' / '1' wins.
      const storedSub = localStorage.getItem(subKey);
      const collapsed = storedSub === null
        ? state.accounts.length > 5
        : storedSub === '1';
      const groupUnread = accs.reduce((sum, a) => sum + (state.accountStats[a.email]?.unread ?? 0), 0);

      const items = accs.map((a) => {
        const col = avatarColor(a.email);
        const ini = initials(a.name || a.email);
        const isOn = state.accountFilters.has(a.email);
        const stats = state.accountStats[a.email];
        const unread = stats?.unread ?? 0;
        const hasError = Boolean(stats?.sync_error);
        const badgeHtml = hasError
          ? `<span class="mb-acc-badge error" title="${escapeHtml(stats.sync_error || t('mb.sync.error', { msg: '' }))}">!</span>`
          : `<span class="mb-acc-badge ${isOn ? 'on-active' : ''}">${unread}</span>`;
        return `
          <button class="mb-folder mb-acc-item ${isOn ? 'active' : ''}" data-acc="${escapeHtml(a.email)}" title="${t('mb.sidebar.acc_toggle_title')}">
            <span class="mb-acc-av" style="background:${col}">${escapeHtml(ini)}</span>
            <span class="lab">${escapeHtml(a.name || a.email)}</span>
            ${badgeHtml}
          </button>`;
      }).join('');

      return `
        <div class="mb-acc-group" data-type="${escapeHtml(type)}">
          <div class="mb-subsection-title ${collapsed ? 'is-collapsed' : ''} ${anySelected ? 'has-active' : ''} ${allInGroup ? 'all-active' : ''}" data-sub-toggle="${escapeHtml(subKey)}" data-sub-type="${escapeHtml(type)}" title="${t('mb.sidebar.subsection_title')}">
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
      <button class="mb-folder ${allSelected ? 'active' : ''}" data-acc="">
        <i data-lucide="users" class="w-4 h-4"></i>
        <span class="lab">${t('mb.sidebar.all_accounts')}</span>
      </button>
      ${groupsHtml}
    `;

    section.querySelectorAll('[data-acc]').forEach((b) => {
      b.addEventListener('click', (e) => {
        const acc = b.dataset.acc;
        const additive = e.shiftKey || e.metaKey || e.ctrlKey;
        if (acc === '') {
          // "Tous les comptes" — always clears, never additive.
          state.accountFilters.clear();
        } else if (additive) {
          // Cmd/Ctrl/Shift+clic = toggle for multi-selection (legacy).
          if (state.accountFilters.has(acc)) {
            state.accountFilters.delete(acc);
          } else {
            state.accountFilters.add(acc);
          }
        } else {
          // Plain clic = solo this account. Re-clic on the solo account
          // clears (same affordance as "Tous les comptes" — toggle off).
          const isOnlyThis = state.accountFilters.size === 1
                          && state.accountFilters.has(acc);
          state.accountFilters.clear();
          if (!isOnlyThis) state.accountFilters.add(acc);
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
    // In no-AI mode every email gets the neutral score=5, so "Par
    // importance" is meaningless — drop it from the menu and reset the
    // current sort if it was selected.
    const visibleOptions = window.aiEnabled
      ? SORT_OPTIONS
      : SORT_OPTIONS.filter((o) => o.value !== 'score');
    if (!window.aiEnabled && state.sortMode === 'score') state.sortMode = 'date-desc';
    const curSort  = visibleOptions.find((o) => o.value === state.sortMode) || visibleOptions[0];

    const wrap = $('#sort-select-wrap');
    wrap.innerHTML = `
      <button class="sort-select-btn" id="sort-select-btn" type="button" aria-haspopup="listbox" aria-expanded="false" title="${t('mb.sort.title')}">
        ${sortIcon}<span>${escapeHtml(curSort.short)}</span>${chevron}
      </button>
      <div class="sort-select-drop" id="sort-select-drop" role="listbox" aria-label="${t('mb.sort.by_aria')}">
        ${visibleOptions.map((opt) => `
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
        _filterDidChange = true;
        applyFilter();
      });
    });

    const onSortOutside = (e) => { if (!wrap.contains(e.target)) wrap.classList.remove('open'); };
    document.addEventListener('click', onSortOutside);
    _sortDropCleanup = () => document.removeEventListener('click', onSortOutside);
  }

  function _anyFilterActive() {
    return state.onlyUnread || state.onlyReply || state.category !== '' || state.query.trim() !== '' || state.accountFilters.size > 0 || state.labelFilter != null;
  }

  function _clearAllFilters() {
    state.onlyUnread = false;
    state.onlyReply = false;
    state.category = '';
    state.query = '';
    state.accountFilters.clear();
    state.labelFilter = null;
    const inp = $('#search');
    if (inp) inp.value = '';
    _filterDidChange = true;
    renderChips();
    renderLabels();
    applyFilter();
  }

  function renderChips() {
    const el = $('#filter-chips');
    const existing = el.querySelectorAll('[data-quick]');
    const anyActive = _anyFilterActive();

    // Refresh the reset button visibility
    const resetBtn = el.querySelector('[data-reset]');
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
      if (resetBtn) resetBtn.classList.toggle('visible', anyActive);
      return;
    }

    // First render — create buttons and attach listeners.
    const noQuick = !state.onlyUnread && !state.onlyReply;
    el.innerHTML = `
      <button class="mb-chip ${noQuick ? 'active' : ''}" data-quick="all">${t('mb.chip.all')}</button>
      <button class="mb-chip ${state.onlyUnread ? 'active' : ''}" data-quick="unread">${t('mb.chip.unread')}</button>
      <button class="mb-chip ${state.onlyReply ? 'active' : ''}" data-quick="reply">${t('mb.chip.reply')}</button>
      <button class="mb-chip mb-chip-reset ${anyActive ? 'visible' : ''}" data-reset title="${t('mb.chip.reset_tip')}">
        <i data-lucide="x" class="w-3 h-3"></i> ${t('mb.chip.reset')}
      </button>
    `;
    el.querySelectorAll('[data-quick]').forEach((b) => {
      b.addEventListener('click', () => {
        const k = b.dataset.quick;
        if (k === 'all')    { state.onlyUnread = false; state.onlyReply = false; }
        if (k === 'unread') { state.onlyUnread = !state.onlyUnread; state.onlyReply = false; }
        if (k === 'reply')  { state.onlyReply  = !state.onlyReply;  state.onlyUnread = false; }
        _filterDidChange = true;
        renderChips();
        applyFilter();
      });
    });
    el.querySelector('[data-reset]')?.addEventListener('click', _clearAllFilters);
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

  function applyFilter(_skipChips) {
    if (!_skipChips) renderChips();
    const q = state.query.trim().toLowerCase();
    // Server-side search results take over while a query is active. Sorting
    // and re-render still flow through here so the sort buttons keep working.
    // Still honour the account scope client-side: the server only scopes when
    // exactly one account is selected, so a 2+ multi-selection is narrowed
    // here (and emails from removed accounts are excluded either way).
    if (q && state.searchResults) {
      const activeAccts = new Set(state.accounts.map((a) => a.email));
      const scoped = state.searchResults.filter((em) => {
        if (activeAccts.size > 0 && !activeAccts.has(em.account_email)) return false;
        if (state.accountFilters.size > 1 && !state.accountFilters.has(em.account_email)) return false;
        return true;
      });
      const items = sortEmails(scoped);
      state.filteredIds = items.map((e) => e.int_id);
      renderList(items);
      refreshGlobalSelectAll();
      updateBadge();
      return;
    }
    const activeEmails = new Set(state.accounts.map((a) => a.email));
    const cat = state.category || '';
    const filtered = state.emails.filter((em) => {
      // Exclude emails from accounts that have been removed from config
      if (activeEmails.size > 0 && !activeEmails.has(em.account_email)) return false;
      // multi-account client-side filter (single-account is handled at API level)
      if (state.accountFilters.size > 1 && !state.accountFilters.has(em.account_email)) return false;
      // Quick filters live client-side now (was: API round-trip per
      // chip click, ~500 ms). state.emails is the broad load for the
      // current folder+account+label; narrowing here keeps chip toggles
      // instant.
      if (state.onlyUnread && em.is_read) return false;
      if (state.onlyReply && !em.needs_reply) return false;
      if (cat && em.category !== cat) return false;
      if (!q) return true;
      const hay = `${em.sender || ''} ${em.subject || ''} ${em.summary || ''}`.toLowerCase();
      return hay.includes(q);
    });
    const items = sortEmails(filtered);
    state.filteredIds = items.map((e) => e.int_id);
    renderList(items);
    refreshGlobalSelectAll();
    updateBadge();
  }

  function updateBadge() {
    const stats = Object.values(state.accountStats);
    const setBadge = (el, count) => {
      if (!el) return;
      if (count > 0) {
        el.textContent = String(count);
        el.hidden = false;
      } else {
        el.hidden = true;
      }
    };

    const inboxEl = $('#badge-inbox');
    if (inboxEl) {
      // Sum unread from accountStats (database counts, inbox-filtered) across all accounts.
      // Falls back to counting loaded emails if stats aren't available yet.
      const unread = stats.reduce((acc, s) => acc + (s.unread || 0), 0)
        || state.emails.reduce((acc, em) => acc + (em.is_read ? 0 : 1), 0);
      setBadge(inboxEl, unread);
    }

    setBadge($('#badge-favourite'), stats.reduce((acc, s) => acc + (s.favourite || 0), 0));
    setBadge($('#badge-draft'),     stats.reduce((acc, s) => acc + (s.draft || 0), 0));
  }

  // True only on the very first render after mounting (i.e. page navigation).
  // Set to false after first renderList so subsequent reloads don't re-animate.
  let _firstRender = true;
  // Set to true when user changes a filter chip or sort mode (not background refresh).
  let _filterDidChange = false;
  // False until the first loadEmails completes — lets a foreground navigation
  // exit search mode without wiping a deep-linked ?q= on the very first load.
  let _navLoadSeen = false;
  // Last card explicitly checked (avatar-click, Ctrl+click, Shift+click anchor) for range-select.
  let _lastCheckedId = null;
  // Monotonic token for in-flight loadEmails() calls. Each call captures
  // the current value; if a newer call has bumped it before the await
  // resolves, the older response is dropped on the floor. Prevents the
  // "filter snaps back" race when a slow response overwrites fresh state.
  let _loadEmailsToken = 0;
  // Stamped at the head of loadEmails / loadAccounts. Read by the
  // visibilitychange handler to debounce: a quick tab-switch must
  // not trigger a second reload on top of the periodic refresh.
  let _lastLoadAt = 0;

  // ── Infinite scroll (virtual list) ───────────────────────
  const PAGE_SIZE = 80;
  let _listAllItems  = [];   // full filtered+sorted dataset
  let _listRendered  = 0;    // # cards currently in the DOM
  let _listObserver  = null; // IntersectionObserver on the sentinel

  function _teardownListObserver() {
    if (_listObserver) { _listObserver.disconnect(); _listObserver = null; }
  }

  function _attachCardAvatarKeydown(list, fromIdx, toIdx) {
    const cards = list.querySelectorAll('.mb-card');
    for (let i = fromIdx; i < toIdx && i < cards.length; i++) {
      const avatar = cards[i].querySelector('.mb-avatar');
      if (!avatar) continue;
      const id = parseInt(cards[i].dataset.id, 10);
      avatar.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.stopPropagation();
          e.preventDefault();
          if (e.shiftKey && _lastCheckedId != null) rangeSelect(id);
          else toggleSelection(id);
        }
      });
    }
  }

  function _appendBatch(list, animate, newIds) {
    _teardownListObserver();
    const from = _listRendered;
    const to   = Math.min(from + PAGE_SIZE, _listAllItems.length);
    if (from >= _listAllItems.length) return;

    // Remove stale sentinel before inserting new cards.
    list.querySelector('#list-sentinel')?.remove();

    const isPage2Plus = from > 0;
    const html = _listAllItems.slice(from, to).map((em, relIdx) =>
      cardHtml(em, animate && from === 0 ? from + relIdx : -1, newIds?.has(em.int_id), isPage2Plus)
    ).join('');
    list.insertAdjacentHTML('beforeend', html);
    _attachCardAvatarKeydown(list, from, to);
    // Scope to the list container to avoid full-DOM traversal.
    window.lucide?.createIcons({ el: list });
    _listRendered = to;

    if (_listRendered < _listAllItems.length) {
      const sentinel = document.createElement('div');
      sentinel.id = 'list-sentinel';
      sentinel.style.cssText = 'height:1px;pointer-events:none';
      list.appendChild(sentinel);
      _listObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) _appendBatch(list, false, null);
      }, { rootMargin: '300px' });
      _listObserver.observe(sentinel);
    }
  }

  // Fast-path guard: tells whether the new list matches the previous one
  // exactly enough to skip the wipe + rebuild. We compare ids in order +
  // every flag that drives card visuals (unread state, category badge,
  // folder marker, score chip, label count, attachment paperclip).
  // If anything else changes server-side, callers will see stale visuals
  // until the next mutation forces a full re-render — those fields are
  // not painted on list cards anyway (summary/draft live in the read pane).
  function _canPatchInPlace(prev, next) {
    if (prev.length !== next.length) return false;
    for (let i = 0; i < prev.length; i++) {
      const p = prev[i], n = next[i];
      if (p.int_id !== n.int_id) return false;
      if (!!p.is_read !== !!n.is_read) return false;
      if (p.category !== n.category) return false;
      if (p.folder !== n.folder) return false;
      if ((p.importance_score || 0) !== (n.importance_score || 0)) return false;
      if ((p.labels?.length || 0) !== (n.labels?.length || 0)) return false;
      if ((p.attachments?.total || 0) !== (n.attachments?.total || 0)) return false;
    }
    return true;
  }

  // Touch only the classes that the periodic refresh can mutate
  // (read/selected/checked). Subject/sender/avatar are immutable post-
  // ingest, so we don't re-render them — the _canPatchInPlace guard
  // above guarantees the structural fields we DO show haven't changed.
  function _patchListInPlace(items) {
    const list = $('#email-list');
    if (!list) return;
    for (const em of items) {
      const card = list.querySelector(`[data-id="${em.int_id}"]`);
      if (!card) continue; // not yet rendered (below the virtual scroll fold)
      card.classList.toggle('unread', !em.is_read);
      card.classList.toggle('selected', state.selectedId === em.int_id);
      card.classList.toggle('checked', state.selectedIds.has(em.int_id));
    }
    _listAllItems = items;
  }

  // Capture the int_id of the card currently sitting at the top of the
  // viewport plus its pixel offset from the list's scroll origin. Used by
  // renderList() to keep the user anchored on the same email across a
  // background rebuild — otherwise periodic refreshes snap to the top
  // and the user loses their place. Returns null when the list is empty
  // or the user is already at the top (nothing to preserve).
  function _capturePositionAnchor() {
    const list = $('#email-list');
    if (!list || list.scrollTop <= 0) return null;
    const listTop = list.getBoundingClientRect().top;
    const cards = list.querySelectorAll('.mb-card');
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (r.bottom > listTop + 4) {
        return { id: parseInt(c.dataset.id, 10), offset: r.top - listTop };
      }
    }
    return null;
  }

  // After a rebuild, render enough batches to bring the anchor card back
  // into the DOM and scroll so it sits at the same viewport position it
  // had before. No-op when the anchored email is gone from the new list
  // (deleted / moved out of the active filter) — scrolling stays at top.
  function _restorePositionAnchor(anchor) {
    if (!anchor) return;
    const list = $('#email-list');
    if (!list) return;
    const idx = _listAllItems.findIndex((e) => e.int_id === anchor.id);
    if (idx === -1) return;
    let safety = 50;
    while (idx >= _listRendered && safety-- > 0) {
      _appendBatch(list, false, null);
    }
    const card = list.querySelector(`.mb-card[data-id="${anchor.id}"]`);
    if (!card) return;
    const listTop = list.getBoundingClientRect().top;
    const cardTop = card.getBoundingClientRect().top - listTop;
    list.scrollTop += cardTop - anchor.offset;
  }

  // Auto-refresh fast path: when the new items contain the previous list
  // as a contiguous suffix, the only change is N fresh emails prepended
  // at the top. Splice those cards in, leave every existing card (and
  // its handlers) untouched, and shift scrollTop by the prepended height
  // so the user's viewport stays anchored on whatever they were reading.
  function _tryPrependNewCards(items) {
    const oldLen = _listAllItems.length;
    if (!oldLen || items.length <= oldLen) return false;
    const diff = items.length - oldLen;
    for (let i = 0; i < oldLen; i++) {
      if (items[i + diff].int_id !== _listAllItems[i].int_id) return false;
    }
    const list = $('#email-list');
    if (!list) return false;

    const newSlice = items.slice(0, diff);
    const html = newSlice.map((em) => cardHtml(em, -1, true, false)).join('');
    const wasScrolled = list.scrollTop > 4;

    list.insertAdjacentHTML('afterbegin', html);
    _attachCardHandlers(list, 0, diff);
    window.lucide?.createIcons();

    _listAllItems = items;
    _listRendered += diff;

    if (wasScrolled) {
      let addedHeight = 0;
      const cards = list.querySelectorAll('.mb-card');
      for (let i = 0; i < diff && i < cards.length; i++) {
        addedHeight += cards[i].offsetHeight;
      }
      list.scrollTop += addedHeight;
    }
    return true;
  }

  function renderList(items) {
    // Fast-path 1: same ids in the same order, no flag change → in-place
    // patch. Skips the innerHTML wipe + 1111-card rebuild that drives
    // the jank on large inboxes. _firstRender (mount animation) and
    // _filterDidChange (crossfade swap) intentionally bypass the
    // fast-path to preserve those UX moments.
    if (!_firstRender && !_filterDidChange &&
        _canPatchInPlace(_listAllItems, items)) {
      _patchListInPlace(items);
      return;
    }
    // Fast-path 2: new emails prepended at the top (the common auto-
    // refresh case). Insert just the new cards, keep scroll anchored —
    // the user does not lose their place mid-list when fresh mail lands.
    if (!_firstRender && !_filterDidChange &&
        _tryPrependNewCards(items)) {
      return;
    }
    _teardownListObserver();
    const animate  = _firstRender;
    _firstRender   = false;

    const filterSwap = _filterDidChange;
    _filterDidChange = false;

    // Detect IDs that weren't in the previous render (new arrivals)
    const prevIds = new Set(_listAllItems.map((e) => e.int_id));
    const newIds  = animate ? null : new Set(
      items.filter((e) => !prevIds.has(e.int_id)).map((e) => e.int_id)
    );

    // For non-mount, non-filter rebuilds (deletions, reorders, sort
    // change from outside the user's hand…) capture the scroll anchor
    // before the wipe so we can restore it after _appendBatch paints
    // the first page. Filter swaps intentionally reset to the top —
    // a new chip selection is a new view.
    const anchor = (!animate && !filterSwap) ? _capturePositionAnchor() : null;

    _listAllItems  = items;
    _listRendered  = 0;

    const list = $('#email-list');
    if (filterSwap && !animate) {
      list.classList.add('mb-list--swap');
      setTimeout(() => list.classList.remove('mb-list--swap'), 180);
    }
    if (!items.length) {
      list.innerHTML = `
        <div style="padding:48px 24px;text-align:center;color:var(--muted)">
          <div class="ill" style="margin:0 auto 14px;width:56px;height:56px;border-radius:16px;background:var(--surface);display:grid;place-items:center;color:var(--muted-2)">
            <i data-lucide="inbox" class="w-6 h-6"></i>
          </div>
          <div style="font-weight:600;color:var(--text);margin-bottom:4px">${t('mb.list.empty_title')}</div>
          <div style="font-size:13px">${t('mb.list.empty_filter')}</div>
        </div>`;
      window.lucide?.createIcons();
      return;
    }

    list.innerHTML = '';
    _appendBatch(list, animate, newIds);
    if (anchor) _restorePositionAnchor(anchor);
  }

  function cardHtml(em, animIdx = -1, isNew = false, isPage2Plus = false) {
    const sName = senderName(em.sender);
    const sEmail = senderEmail(em.sender);
    const ini = initials(sName || sEmail);
    const col = avatarColor(sEmail || sName);
    const logoImg = avatarImgHtml(sEmail);
    const isUnread = !em.is_read;
    // In no-AI mode every email gets a neutral score=5 fallback; we
    // suppress score/summary/draft hints entirely so the UI doesn't
    // pretend to be intelligent when it isn't.
    const aiOn = !!window.aiEnabled;
    const score = aiOn ? (em.importance_score || 0) : 0;
    const showSummary = aiOn && em.summary && em.summary.length > 0;
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

    // Staggered entrance on first render: start at 80ms, +20ms per card, cap 280ms.
    const animClass = isNew ? ' mb-card-new' : animIdx >= 0 ? ' mb-card-enter' : isPage2Plus ? ' mb-card-page' : '';
    const animStyle = animIdx >= 0 && !isNew
      ? ` style="animation-delay:${80 + Math.min(animIdx * 20, 280)}ms"`
      : '';

    return `
      <article class="mb-card${animClass} ${isUnread ? 'unread' : ''} ${isSelected ? 'selected' : ''} ${isChecked ? 'checked' : ''}" data-id="${em.int_id}" role="listitem" tabindex="0"${animStyle}>
        <div class="mb-avatar" style="background:${col}" role="checkbox" aria-checked="${isChecked}" aria-label="${t('mb.list.select_aria')}" title="${t('mb.list.select_title')}" tabindex="0">
          <span class="av-text">${escapeHtml(ini)}</span>
          ${logoImg}
          <span class="av-check"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>
        </div>
        <div class="mb-card-body">
          <div class="mb-card-row">
            <div class="mb-row-left">
              <span class="mb-sender">${escapeHtml(sName || sEmail || t('mb.unknown_sender'))}</span>
              ${Array.isArray(em.labels) && em.labels.length ? `
                <span class="mb-card-labels">
                  ${em.labels.slice(0, 3).map((l) => `<span class="mb-label-chip mb-label-chip-sm" style="background:${escapeHtml(l.color)}33;color:${escapeHtml(l.color)}" title="${escapeHtml(l.name)}"><span class="mb-label-chip-dot" style="background:${escapeHtml(l.color)}"></span>${escapeHtml(l.name)}</span>`).join('')}
                  ${em.labels.length > 3 ? `<span class="mb-label-chip mb-label-chip-sm mb-label-chip-more" title="${t('mb.label.more', { n: em.labels.length - 3 })}">+${em.labels.length - 3}</span>` : ''}
                </span>
              ` : ''}
              ${(() => {
                // Inline indicators ordered:
                //   sender → labels → paperclip → reply (needs reply) → draft (draft ready)
                // The paperclip has three threat-tier variants so the user
                // spots dangerous PJ at a glance.
                const a = em.attachments || { total: 0, dangerous: 0, suspicious: 0 };
                if (!a.total) return '';
                if (a.dangerous)  return `<i data-lucide="shield-alert" class="w-3.5 h-3.5 mb-att-warn" title="${t('mb.att.dangerous')}"></i>`;
                if (a.suspicious) return `<i data-lucide="paperclip" class="w-3.5 h-3.5 mb-att-warn" title="${t('mb.att.suspicious')}"></i>`;
                return `<i data-lucide="paperclip" class="w-3.5 h-3.5 mb-att-icon" title="${t('mb.att.count', { n: a.total })}"></i>`;
              })()}
              ${em.injection_flag ? `<i data-lucide="alert-triangle" class="w-3.5 h-3.5 mb-inject-inline" title="${t('mb.injection.flag')}"></i>` : ''}
              ${aiOn && em.needs_reply ? `<i data-lucide="reply" class="w-3.5 h-3.5 mb-reply-inline" title="${t('mb.ai.needs_reply')}"></i>` : ''}
              ${aiOn && em.draft_response ? `<i data-lucide="pencil-line" class="w-3.5 h-3.5 mb-draft-inline${em.draft_auto ? ' mb-draft-auto' : ''}" title="${em.draft_auto ? t('mb.ai.draft_auto') : t('mb.ai.draft_ready')}"></i>` : ''}
            </div>
            ${em.thread_count > 1 ? `<span class="mb-thread-count" title="${t('mb.thread.count', { n: em.thread_count })}"><i data-lucide="messages-square" class="w-3 h-3"></i>${em.thread_count}</span>` : ''}
            ${em.category && em.category !== 'pending' ? `<i data-lucide="${CATEGORY_ICON[em.category] || 'tag'}" class="mb-cat-icon" style="color:${CATEGORY_COLOR[em.category] || 'var(--muted-2)'}" title="${escapeHtml(CATEGORY_LABEL[em.category] || em.category)}"></i>` : ''}
            <span class="mb-date">${escapeHtml(shortDate(em.date_received))}</span>
          </div>
          <div class="mb-subj">
            <span>${escapeHtml(em.subject || t('mb.no_subject'))}</span>
          </div>
          ${showSummary ? `<div class="mb-summary">${escapeHtml(em.summary)}</div>` : ''}
        </div>
        <div class="mb-card-meta">
          ${score > 0 ? `<span class="score-pill ${scoreClass(score)}" title="${t('mb.score.title', { n: score })}">${score}</span>` : '<span></span>'}
          ${em.is_favourite ? `<span class="mb-fav-star" title="${t('mb.favorite')}"><i data-lucide="star" class="w-3.5 h-3.5"></i></span>` : ''}
          ${accAvatar}
        </div>
      </article>
    `;
  }

  // ── Multi-selection (avatar-click) ────────────────────────
  function _selectCard(intId) {
    const prev = host.querySelector('.mb-card.selected');
    if (prev) prev.classList.remove('selected');
    const next = host.querySelector(`.mb-card[data-id="${intId}"]`);
    if (next) next.classList.add('selected');
  }

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
    refreshGlobalSelectAll();
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
    _lastCheckedId = id;
    refreshGlobalSelectAll();
    renderSelectionBar();
  }

  // Range-select from _lastCheckedId to `id` (inclusive) over the filtered list.
  function rangeSelect(id) {
    const ids = state.filteredIds;
    const fromIdx = _lastCheckedId != null ? ids.indexOf(_lastCheckedId) : -1;
    const toIdx = ids.indexOf(id);
    if (fromIdx === -1 || toIdx === -1) {
      toggleSelection(id);
      return;
    }
    const [lo, hi] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
    for (let i = lo; i <= hi; i++) {
      const eid = ids[i];
      state.selectedIds.add(eid);
      const card = host.querySelector(`.mb-card[data-id="${eid}"]`);
      if (card) {
        card.classList.add('checked');
        const av = card.querySelector('.mb-avatar');
        if (av) av.setAttribute('aria-checked', 'true');
      }
    }
    _lastCheckedId = id;
    renderSelectionBar();
  }

  function refreshGlobalSelectAll() {
    const btn = $('#sel-all-global');
    if (!btn) return;
    const total = state.filteredIds.length;
    const allSelected = total > 0 && state.selectedIds.size >= total
      && state.filteredIds.every((id) => state.selectedIds.has(id));
    const someSelected = state.selectedIds.size > 0 && !allSelected;
    const label = allSelected ? t('mb.sel.none_short') : someSelected ? t('mb.sel.cancel_short') : t('mb.sel.all_short');
    const icon = allSelected ? 'square' : someSelected ? 'x' : 'check-square';
    const title = allSelected ? t('mb.sel.deselect_all') : someSelected ? t('mb.sel.clear') : t('mb.sel.all');
    const span = btn.querySelector('span');
    if (span) span.textContent = label;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    const iconEl = btn.querySelector('i, svg');
    if (iconEl) {
      const isSvg = iconEl.tagName === 'SVG';
      if (isSvg) {
        const parent = iconEl.parentNode;
        parent.innerHTML = `<i data-lucide="${icon}" class="w-4 h-4"></i>`;
        window.lucide?.createIcons({ el: parent });
      } else {
        iconEl.setAttribute('data-lucide', icon);
        window.lucide?.createIcons();
      }
    }
  }

  function clearSelection() {
    closePopover();
    if (!state.selectedIds.size) return;
    state.selectedIds.clear();
    _lastCheckedId = null;
    host.querySelectorAll('.mb-card.checked').forEach((c) => {
      c.classList.remove('checked');
      const av = c.querySelector('.mb-avatar');
      if (av) av.setAttribute('aria-checked', 'false');
    });
    refreshGlobalSelectAll();
    renderSelectionBar();
  }

  function renderSelectionBar() {
    const bar = $('#sel-bar');
    if (!bar) return;
    const n = state.selectedIds.size;
    if (n === 0) {
      if (!bar.hidden) {
        bar.classList.add('leaving');
        setTimeout(() => { bar.hidden = true; bar.classList.remove('leaving'); }, 180);
      }
      closePopover();
      return;
    }
    bar.classList.remove('leaving');
    bar.hidden = false;
    const num = $('#sel-count-num');
    if (num) num.textContent = String(n);
    refreshGlobalSelectAll();
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
      window.toast(target ? t('mb.toast.marked_read', { n: updated }) : t('mb.toast.marked_unread', { n: updated }));
    } else {
      window.toast(target ? t('mb.toast.already_read') : t('mb.toast.already_unread'));
    }
  }

  // Animate a card out (slide-left + height collapse), then resolve after 280ms.
  // intId can be a number or a list of numbers.
  function animateCardLeave(intIds) {
    const ids = Array.isArray(intIds) ? intIds : [intIds];
    ids.forEach((id) => {
      host.querySelectorAll(`.mb-card[data-id="${id}"]`).forEach((card) => {
        card.classList.add('mb-card-leaving');
      });
    });
    return new Promise((resolve) => setTimeout(resolve, 280));
  }

  async function bulkSetCategory(category) {
    const ids = [...state.selectedIds];
    if (!ids.length) return;
    await animateCardLeave(ids);
    await Promise.all(ids.map((id) => api.patchEmail(id, { category }).catch(() => {})));
    window.toast(t('mb.toast.categorized', { n: ids.length }));
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
      return { patch: p, verb: t('mb.verb.starred'), leavesView: currentFolder !== 'inbox' };
    }
    if (target === 'deleted') {
      return { patch: { folder: 'deleted' }, verb: t('mb.verb.deleted'), leavesView: currentFolder !== 'deleted' };
    }
    if (target === 'inbox') {
      // From the Favourites view, "back to inbox" means unstar — the mail is
      // already in inbox so the only state change is dropping the flag.
      if (currentFolder === 'favourite') {
        return { patch: { is_favourite: false }, verb: t('mb.verb.unstarred'), leavesView: true };
      }
      // From Trash, restore the folder; keep the favourite flag if any.
      if (currentFolder === 'deleted') {
        return { patch: { folder: 'inbox' }, verb: t('mb.verb.restored'), leavesView: true };
      }
      // Already in inbox — no-op (the popover hides this option in that case).
      return null;
    }
    // Phase 4 — custom folder. Match against the user's folder list
    // so a typo in the popover can't punch an arbitrary string into
    // emails.folder. Verb is "déplacé(s) vers <name>" so the toast
    // tells the user where it went.
    const custom = (state.customFolders || []).find((f) => f.name === target);
    if (custom) {
      return {
        patch: { folder: custom.name },
        verb: t('mb.verb.moved_to', { name: custom.name }),
        leavesView: currentFolder !== custom.name,
      };
    }
    return null;
  }

  async function bulkSetTarget(target) {
    const ids = [...state.selectedIds];
    if (!ids.length) return;
    const cur = state.folder || 'inbox';
    const plan = _patchForTarget(target, cur);
    if (!plan) return;
    if (plan.leavesView) await animateCardLeave(ids);

    // Drafts in the Brouillons folder use synthetic negative ids and
    // live in the `drafts` table. `api.patchEmail` would 404 silently
    // on them and the rows reappear after loadEmails. Route each id
    // to the right endpoint. Only `delete` makes sense for drafts;
    // mark_read / foldering are no-ops on them.
    const draftIds = [];
    const realIds  = [];
    for (const id of ids) {
      if (id < 0) {
        const row = state.emails.find((e) => e.int_id === id);
        const realDraftId = row?._draft?.id;
        if (realDraftId != null) draftIds.push(realDraftId);
      } else {
        realIds.push(id);
      }
    }

    // Drop the deleted drafts from state.emails synchronously so the
    // list updates instantly, before the network round-trip.
    if (target === 'deleted' && draftIds.length) {
      const removed = new Set(draftIds);
      state.emails = state.emails.filter(
        (e) => !(e._draft && removed.has(e._draft.id))
      );
    }

    const tasks = [];
    if (target === 'deleted' && draftIds.length) {
      for (const did of draftIds) {
        tasks.push(api.deleteDraft(did).catch((err) => {
          // 404 = already gone, treat as success.
          if (err && err.status !== 404) throw err;
        }));
      }
    }
    for (const id of realIds) {
      tasks.push(api.patchEmail(id, plan.patch).catch(() => {}));
    }
    await Promise.all(tasks);

    window.toast(t('mb.toast.bulk_done', { n: ids.length, verb: plan.verb }));
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
    const toastCtrl = window.toast({
      variant: 'loading',
      message: t('mb.ai.bulk.progress', { done: 0, total }),
      progress: 0,
      duration: 0,
    });
    for (const id of ids) {
      try {
        const updated = await api.reanalyzeEmail(id);
        const idx = state.emails.findIndex((e) => e.int_id === id);
        if (idx >= 0 && updated) state.emails[idx] = { ...state.emails[idx], ...updated };
        done++;
      } catch (_) {
        failed++;
      }
      const completed = done + failed;
      toastCtrl?.update({
        message: t('mb.ai.bulk.progress', { done: completed, total }),
        progress: Math.round((completed / total) * 100),
      });
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
    if (failed) toastCtrl?.error(t('mb.ai.bulk.partial', { done, fail: failed }));
    else        toastCtrl?.success(t('mb.ai.bulk.done', { done, total }));
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
      // Close THIS popover BEFORE running the picker callback. If we
      // closed after, and onPick opened a fresh popover (the "tag"
      // case opens openTagPopover synchronously), our closePopover()
      // would tear down the new popover instead of this one.
      closePopover();
      onPick(opt.dataset.value);
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

  // Multi-select popover for assigning personal labels to the
  // currently selected emails. Each row is a checkbox; the union of
  // labels currently set on ALL selected emails is pre-checked, so
  // "apply" replaces. Saving issues one PUT per email (idempotent
  // replace-all) so partial intersections also resolve cleanly.
  function openTagPopover(anchor, opts = {}) {
    const ids = opts.ids ? [...opts.ids] : [...state.selectedIds];
    if (!ids.length) return;
    closePopover();

    if (!state.userLabels.length) {
      window.toast(t('mb.label.toast.create_first'));
      return;
    }

    // Pre-tick labels that ALL targeted emails carry (intersection).
    // Partially-applied labels start unchecked; saving will REMOVE
    // them from rows that had them — that's the explicit user
    // contract of a replace-all picker. `opts.labels` lets the read
    // pane pass an already-loaded labels array for the single email
    // case (it may not be in state.emails if opened via deep-link).
    const idSet = new Set(ids);
    const labelCount = new Map();
    if (opts.labels) {
      for (const l of opts.labels) labelCount.set(l.id, ids.length);
    } else {
      for (const em of state.emails) {
        if (!idSet.has(em.int_id)) continue;
        for (const l of (em.labels || [])) {
          labelCount.set(l.id, (labelCount.get(l.id) || 0) + 1);
        }
      }
    }
    const initiallyChecked = new Set(
      [...labelCount.entries()].filter(([, n]) => n === ids.length).map(([id]) => id)
    );

    const pop = document.createElement('div');
    pop.className = 'sel-popover mb-tag-popover';
    pop.setAttribute('role', 'menu');
    pop.innerHTML = `
      <div class="mb-tag-popover-head">${t('mb.tag_pop.head', { n: ids.length })}</div>
      <div class="mb-tag-popover-list">
        ${state.userLabels.map((l) => `
          <label class="mb-tag-popover-opt">
            <input type="checkbox" data-label-id="${l.id}" ${initiallyChecked.has(l.id) ? 'checked' : ''}>
            <span class="mb-label-chip-dot" style="background:${escapeHtml(l.color)}"></span>
            <span class="mb-tag-popover-name">${escapeHtml(l.name)}</span>
          </label>
        `).join('')}
      </div>
      <div class="mb-tag-popover-footer">
        <button class="mb-tag-popover-cancel" type="button">${t('mb.cancel')}</button>
        <button class="mb-tag-popover-apply"  type="button">${t('mb.apply')}</button>
      </div>
    `;
    document.body.appendChild(pop);
    window.lucide?.createIcons({ el: pop });

    // Anchor positioning — same logic as openPopover.
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

    const onOutside = (e) => {
      if (pop.contains(e.target) || anchor.contains(e.target)) return;
      closePopover();
    };
    setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
    _popCleanup = () => {
      document.removeEventListener('mousedown', onOutside);
      pop.remove();
    };

    pop.querySelector('.mb-tag-popover-cancel').addEventListener('click', () => closePopover());
    pop.querySelector('.mb-tag-popover-apply').addEventListener('click', async () => {
      const checked = [...pop.querySelectorAll('input[type="checkbox"]:checked')]
        .map((cb) => parseInt(cb.dataset.labelId, 10));
      closePopover();
      try {
        await Promise.all(ids.map((eid) => api.setEmailLabels(eid, checked).catch(() => {})));
        // Mirror locally so cards repaint without a full reload.
        const labelById = new Map(state.userLabels.map((l) => [l.id, l]));
        const labelsArr = checked.map((id) => labelById.get(id)).filter(Boolean);
        for (const em of state.emails) {
          if (idSet.has(em.int_id)) em.labels = labelsArr.slice();
        }
        applyFilter();
        if (typeof opts.onUpdated === 'function') {
          opts.onUpdated(labelsArr);
        }
        window.toast(t('mb.toast.tagged', { n: ids.length }));
      } catch (err) {
        window.toast(err?.message || t('mb.toast.fail_tag'));
      }
    });
  }

  function openMovePopover(anchor) {
    const cur = state.folder || 'inbox';
    // Tailor the labels so they match what the action will actually do from
    // the current view (e.g. "back to inbox" from Favourites means unstar).
    const labelInbox = cur === 'favourite' ? t('mb.move.unstar')
      : cur === 'deleted' ? t('mb.move.restore')
      : t('mb.move.inbox');
    const builtins = [
      { value: 'inbox',     label: labelInbox,              icon: 'inbox' },
      { value: 'favourite', label: t('mb.folder.favourite'), icon: 'star' },
      { value: 'deleted',   label: t('mb.folder.deleted'),   icon: 'trash-2' },
    ].filter((it) => {
      if (it.value === 'inbox' && cur === 'inbox') return false;       // already there
      if (it.value === 'favourite' && cur === 'favourite') return false; // already starred-view
      if (it.value === 'deleted' && cur === 'deleted') return false;     // already trashed
      return true;
    });
    // Phase 4 — append every custom folder, skipping the one the
    // user is already viewing (would be a no-op move).
    const customs = (state.customFolders || [])
      .filter((f) => f.name !== cur)
      .map((f) => ({ value: f.name, label: f.name, icon: 'folder' }));
    openPopover(anchor, [...builtins, ...customs], (target) => bulkSetTarget(target));
  }

  function onSelBarClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'clear')       return clearSelection();
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

    const listWrap = host.querySelector('.mb-list-wrap');

    if (hasSelection) {
      // Opening: lock list-wrap width to its current size so cards don't
      // reflow while the pane expands. Clear any leftover lock first.
      if (inner) inner.style.width = '';
      if (layoutChanging && listWrap) {
        const lw = listWrap.getBoundingClientRect().width;
        if (lw > 0) listWrap.style.width = lw + 'px';
      }
      mailbox.classList.remove('no-selection');
      // Reveal chips and release list-wrap lock once layout has settled.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (chips) delete chips.dataset.hiding;
        if (listWrap) listWrap.style.width = '';
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
        if (listWrap) listWrap.style.width = '';
        _selModeTimer = null;
      }, PANE_ANIM_MS + 20);
    }
  }

  function renderSkeleton() {
    const list = $('#email-list');
    if (!list) return;
    const rows = Array.from({ length: 8 }, () => `
      <div class="mb-card mb-card-skeleton">
        <div class="mb-avatar sk-avatar"></div>
        <div class="mb-card-body">
          <div class="mb-card-row">
            <div class="sk-line sk-line-short"></div>
            <div class="sk-line sk-line-xs"></div>
          </div>
          <div class="mb-subj">
            <div class="sk-line sk-line-med"></div>
          </div>
          <div class="mb-summary-sk">
            <div class="sk-line sk-line-long"></div>
          </div>
        </div>
        <div class="mb-card-meta">
          <div class="sk-line sk-line-tiny"></div>
        </div>
      </div>`).join('');
    list.innerHTML = rows;
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
    if (level === 'dangerous') return `<span class="att-badge att-danger" title="${t('mb.att.badge.dangerous_tip')}"><i data-lucide="shield-alert" class="w-3 h-3"></i>${t('mb.att.badge.dangerous')}</span>`;
    if (level === 'blocked')   return `<span class="att-badge att-blocked" title="${t('mb.att.badge.blocked_tip')}"><i data-lucide="ban" class="w-3 h-3"></i>${t('mb.att.badge.blocked')}</span>`;
    if (level === 'suspicious')return `<span class="att-badge att-warn" title="${t('mb.att.badge.suspicious_tip')}"><i data-lucide="alert-triangle" class="w-3 h-3"></i>${t('mb.att.badge.suspicious')}</span>`;
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
            <span>${t('mb.att.scanning')}</span>
            <button class="att-rescan" id="btn-rescan-one" data-id="${em.int_id}">${t('mb.att.retry')}</button>
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
        ? `<span class="att-unavail">${t('mb.att.unavailable')}</span>`
        : `<button class="att-download" data-id="${a.id}" data-level="${escapeHtml(a.threat_level)}" data-name="${escapeHtml(a.filename)}" data-reasons="${escapeHtml(reasons)}" aria-label="${t('mb.att.download_aria', { name: escapeHtml(a.filename) })}">
             <i data-lucide="${isDangerous ? 'shield-alert' : 'download'}" class="w-4 h-4"></i>
             <span>${t('mb.att.download')}</span>
           </button>`;
      return `
        <div class="att-row att-${escapeHtml(a.threat_level)}" ${titleAttr}>
          <div class="att-icon"><i data-lucide="${icon}" class="w-5 h-5"></i></div>
          <div class="att-meta">
            <div class="att-name">${escapeHtml(a.filename)}${a.is_inline ? `<span class="att-inline-tag" title="${t('mb.att.inline_tip')}">${t('mb.att.inline')}</span>` : ''}</div>
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
    const headLabel = t('mb.att.head', { n: totals })
      + (dangerCount ? ` <span class="att-head-warn">· ${t('mb.att.at_risk', { n: dangerCount })}</span>` : '');
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
            t('mb.att.danger_confirm', { name, reasons: reasons ? t('mb.att.danger_reasons', { r: reasons }) : '' })
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
        rescan.textContent = t('mb.att.scanning_short');
        // Re-fetch the email after a short wait — this triggers a fresh
        // lazy-scan task on the backend if needed.
        setTimeout(async () => {
          try { await openEmail(em.int_id); } catch (_) {}
        }, 1500);
      });
    }
  }

  function buildForwardBody(em) {
    const sName = senderName(em.sender);
    const sEmail = senderEmail(em.sender);
    const date = em.date_received ? longDate(em.date_received) : '';
    const body = (em.body_text || '').trim() || '';
    return (
      '---------- ' + t('mb.forward.header') + ' ----------\n' +
      t('mb.composer.from') + ': ' + sName + ' <' + sEmail + '>\n' +
      t('mb.composer.to') + ': ' + (em.account_email || '') + '\n' +
      t('mb.composer.subject') + ': ' + (em.subject || t('mb.no_subject')) + '\n' +
      (date ? t('mb.forward.date') + ': ' + date + '\n' : '') +
      '\n' +
      body
    );
  }

  function renderEmail(em) {
    const cat = em.category || 'pending';
    const sName = senderName(em.sender);
    const sEmail = senderEmail(em.sender);
    const ini = initials(sName || sEmail);
    const col = avatarColor(sEmail || sName);
    const logoImg = avatarImgHtml(sEmail, 36);

    const aiOn = !!window.aiEnabled;
    const aiBox = aiOn && em.summary ? `
      <div class="mb-ai-box">
        <div class="ai-body">
          <div class="ai-title">
            <div class="ai-icon"><i data-lucide="sparkles" class="w-4 h-4"></i></div>
            <span>${t('mb.ai.analysis_title')}</span>
            <span class="score-pill ${scoreClass(em.importance_score || 0)}">${em.importance_score || 0}</span>
          </div>
          <div class="ai-summary">${escapeHtml(em.summary)}</div>
          ${em.importance_reason ? `<div class="ai-reason">${escapeHtml(em.importance_reason)}</div>` : ''}
        </div>
      </div>
    ` : '';

    // The draft panel shows whatever is the most recent in-flight
    // reply for this email. Two possible sources, picked in order:
    //   • a user draft (drafts table, in_reply_to_int = em.int_id) —
    //     freshly typed content the user wants to come back to
    //   • the AI suggestion (emails.draft_response) generated by the
    //     LLM during ingestion or via the AI button
    // Initial render uses only `em.draft_response` because the user
    // draft fetch is async (kicks off in renderEmail's reply-state
    // initialisation below); the box re-renders via refreshDraftBox()
    // once the lookup completes.
    const initialAiBody = em.draft_response || '';
    const hasInitialDraft = !!initialAiBody;
    const draftBox = `
      <div class="mb-draft" id="mb-draft" style="display:${hasInitialDraft ? '' : 'none'}" data-loaded="${hasInitialDraft ? '1' : '0'}" data-source="${hasInitialDraft ? 'ai' : 'none'}">
        <div class="dh">
          <div class="dh-label">
            <i data-lucide="sparkles" class="w-4 h-4" id="mb-draft-icon"></i>
            <span id="mb-draft-source-label">${t('mb.draft.ai_suggestion')}</span>
          </div>
          <div class="da">
            <button class="ghost" id="btn-draft-discard" title="${t('mb.draft.discard_title')}"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            <button id="btn-draft-edit"><i data-lucide="pencil" class="w-4 h-4"></i>${t('mb.draft.edit')}</button>
            <button class="primary" id="btn-draft-send"><i data-lucide="send" class="w-4 h-4"></i>${t('mb.send')}</button>
          </div>
        </div>
        <div class="dt" id="mb-draft-text">${hasInitialDraft ? escapeHtml(initialAiBody) : ''}</div>
      </div>
    `;

    // Build the body block. Three branches, priorité HTML d'abord :
    //   • HTML body in a sandboxed iframe (95% des emails — MIME multipart)
    //   • plain-text body (linkified) en fallback quand pas de HTML
    //   • empty placeholder
    //
    // Avant ce changement, body_text était préféré quand il existait
    // (présent dans presque tous les emails standards via multipart/
    // alternative). Résultat : on perdait la mise en forme du sender
    // (paragraphes, listes, citations, signature). L'iframe sandboxée
    // gère toutes les protections (no scripts, image-blocker, suspicious
    // links) ; aucune raison de la sacrifier pour économiser un iframe.
    //
    // Le fallback texte sert maintenant uniquement aux emails text-only
    // (notifications GitHub anciennes, alertes CLI, etc.) — rare.
    //
    // L'image-blocker honore `em.sender_images_trusted`. Quand le sender
    // est trusted, l'iframe rend le HTML original. Sinon rewriteRemoteImages
    // strippe + banner avec deux boutons (one-shot ou toujours pour ce
    // domaine).
    const hasHtml = em.body_html && em.body_html.trim().length;
    const hasText = em.body_text && em.body_text.trim().length;
    const body = hasHtml
      ? buildHtmlBodyBlock(em)
      : (hasText
         ? `<div class="mb-body-text">${linkify(em.body_text)}</div>`
         : `<div style="color:var(--muted);font-style:italic">${t('mb.read.empty_body')}</div>`);

    $('#read-pane').innerHTML = `
      <div class="mb-read-inner">
      <div class="mb-read-head">
        <span class="cat-chip" data-cat="${escapeHtml(cat)}">
          <i data-lucide="tag" class="w-3 h-3"></i>${escapeHtml(CATEGORY_LABEL[cat] || cat)}
        </span>
        ${Array.isArray(em.labels) && em.labels.length ? em.labels.map((l) => `
          <span class="mb-label-chip" style="background:${escapeHtml(l.color)}33;color:${escapeHtml(l.color)}" title="${escapeHtml(l.name)}">
            <span class="mb-label-chip-dot" style="background:${escapeHtml(l.color)}"></span>${escapeHtml(l.name)}
          </span>
        `).join('') : ''}
        <div class="mb-read-actions">
          <button class="icon-btn ${em.is_favourite ? 'is-fav' : ''}" id="btn-fav-toggle" title="${em.is_favourite ? t('mb.action.unstar') : t('mb.action.star')}" aria-pressed="${em.is_favourite ? 'true' : 'false'}">
            <i data-lucide="star" class="w-4 h-4"></i>
          </button>
          <button class="icon-btn" id="btn-tag" title="${t('mb.action.tag')}"><i data-lucide="tag" class="w-4 h-4"></i></button>
          <button class="icon-btn" id="btn-print" title="${t('mb.action.print')}"><i data-lucide="printer" class="w-4 h-4"></i></button>
          <button class="icon-btn" id="btn-more" title="${t('mb.action.more')}"><i data-lucide="more-vertical" class="w-4 h-4"></i></button>
          <div class="mb-read-sep"></div>
          <button class="icon-btn" id="btn-close-read" title="${t('mb.close')}"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
      </div>
      <div class="mb-read-body">
        <div class="mb-read-meta">
          <div class="mb-read-date">${escapeHtml(longDate(em.date_received))}</div>
          <h1 class="mb-read-subject">${escapeHtml(em.subject || t('mb.no_subject'))}</h1>

          <div class="mb-thread-item">
            <div class="mb-avatar" style="width:36px;height:36px;font-size:12px;background:${col}">
              <span class="av-text" style="font-size:12px">${escapeHtml(ini)}</span>
              ${logoImg}
            </div>
            <div>
              <div class="name">${escapeHtml(sName || t('mb.unknown_sender'))}${authBadgeHtml(em.auth_results)}</div>
              <div class="meta meta-route">
                <i data-lucide="send" class="w-3 h-3 meta-icon"></i><span class="meta-addr">${escapeHtml(sEmail)}</span>
                <i data-lucide="arrow-right" class="w-3 h-3 meta-arrow"></i>
                <i data-lucide="inbox" class="w-3 h-3 meta-icon"></i><span class="meta-addr meta-to">${escapeHtml(em.account_email || '')}</span>
              </div>
            </div>
            <div class="mb-thread-actions">
              <div class="meta">${escapeHtml(shortDate(em.date_received))}</div>
              <!-- Group 1 — gestion : marquer lu / supprimer -->
              <button class="read-action-btn read-action-btn-muted" id="btn-read-toggle" title="${em.is_read ? t('mb.action.mark_unread') : t('mb.action.mark_read')}">
                <i data-lucide="${em.is_read ? 'mail' : 'mail-open'}" class="w-4 h-4"></i>
              </button>
              <button class="read-action-btn read-action-btn-danger" id="btn-trash" title="${t('mb.action.delete')}">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
              <span class="mb-thread-actions-sep" aria-hidden="true"></span>
              <!-- Group 2 — engagement : analyser IA / répondre.
                   The analyse-IA button is hidden in no-AI mode — clicking
                   it would just hit the 409 from /reanalyze. -->
              ${aiOn ? `<button class="read-action-btn read-action-btn-ai ${em.summary ? 'has-analysis' : ''}" id="btn-analyze" title="${em.summary ? t('mb.action.reanalyze') : t('mb.action.analyze')}">
                <i data-lucide="sparkles" class="w-4 h-4"></i>
              </button>` : ''}
              <button class="read-action-btn" id="btn-reply-toggle" title="${t('mb.action.reply')}">
                <i data-lucide="reply" class="w-4 h-4"></i>
              </button>
              <button class="read-action-btn" id="btn-forward" title="${t('mb.action.forward')}">
                <i data-lucide="forward" class="w-4 h-4"></i>
              </button>
            </div>
          </div>

          ${aiBox}
        </div>

        <div class="mb-read-content">
          ${body}

          ${renderAttachmentsBlock(em)}

          ${draftBox}
        </div>

        <!-- The composer is a sibling of .mb-read-content (NOT inside it)
             so the email body and the composer split the available
             vertical room. Growing the composer shrinks the body's
             visible window without scrolling it out of view; the body
             keeps its own internal scroll, so the user can still read
             every line of the email while typing. -->
        <div class="mb-composer" id="mb-composer" style="display:none">
          <div class="mb-composer-handle" id="mb-composer-handle" role="separator" aria-orientation="horizontal" aria-label="${t('mb.composer.handle_aria')}" title="${t('mb.composer.handle_title')}">
            <span class="mb-composer-handle-grip"></span>
          </div>
          ${buildComposerMetaHtml({
            mode: 'reply',
            accounts: state.accounts,
            defaultAccount: em.account_email || '',
            to: senderEmail(em.sender),
            subject: em.subject ? (em.subject.toLowerCase().startsWith('re:') ? em.subject : `Re: ${em.subject}`) : '',
          })}
          <textarea placeholder="${t('mb.composer.placeholder')}" aria-label="${t('mb.composer.aria')}"></textarea>
          <div class="mb-attach-strip" id="mb-attach-strip" data-empty="1"></div>
          <input type="file" id="mb-file-input" multiple style="display:none">
          <input type="file" id="mb-image-input" accept="image/*" multiple style="display:none">
          <div class="mb-composer-bar">
            <div style="display:flex;gap:4px;color:var(--muted)">
              <button class="icon-btn" id="btn-attach-file" title="${t('mb.composer.attach_file')}" aria-label="${t('mb.composer.attach_file')}"><i data-lucide="paperclip" class="w-4 h-4"></i></button>
              <button class="icon-btn" id="btn-attach-image" title="${t('mb.composer.attach_image')}" aria-label="${t('mb.composer.attach_image')}"><i data-lucide="image" class="w-4 h-4"></i></button>
            </div>
            <div style="display:flex;gap:8px;align-items:center;margin-left:auto">
              <span class="mb-compose-savetag" id="mb-compose-savetag-reply" aria-live="polite"></span>
              ${aiOn ? `<button class="mb-ai-draft-btn" id="btn-ai-draft" title="${t('mb.ai.draft_btn_title')}">
                <i data-lucide="sparkles" class="w-4 h-4"></i>
                ${t('mb.ai.draft_btn')}
              </button>` : ''}
              <button class="send" id="btn-composer-send">
                <i data-lucide="send" class="w-4 h-4"></i>
                ${t('mb.send')}
              </button>
              <button class="icon-btn mb-composer-close" id="btn-composer-close" title="${t('mb.close')}" aria-label="${t('mb.composer.close_aria')}">
                <i data-lucide="x" class="w-4 h-4"></i>
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

    bindComposerFromDropdown($('#read-pane'));
    bindAttachmentHandlers(em);

    $('#btn-close-read').addEventListener('click', () => {
      host.querySelector('.mb-card.selected')?.classList.remove('selected');
      renderEmpty();
    });

    // Wire up the "Charger pour ce mail" / "Toujours pour cet expéditeur"
    // banner buttons after the iframe has been mounted. No-op when the
    // sender is already trusted (no banner present).
    attachImageBlockerHandlers(em);

    // Top-level "Étiqueter" — opens the multi-select label popover
    // anchored on the button. Pre-fills with whatever labels the email
    // currently carries; onUpdated repaints chips in the read pane.
    $('#btn-tag')?.addEventListener('click', () => {
      const anchor = $('#btn-tag');
      openTagPopover(anchor, {
        ids: [em.int_id],
        labels: em.labels || [],
        onUpdated: (newLabels) => {
          em.labels = newLabels;
          try { renderEmail(em); } catch (_) {}
        },
      });
    });

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
      btn.title = target ? t('mb.action.unstar') : t('mb.action.star');
      btn.setAttribute('aria-pressed', target ? 'true' : 'false');
      try { await api.patchEmail(em.int_id, { is_favourite: target }); } catch (_) {}
      await loadEmails();
      window.toast(target ? t('mb.toast.starred') : t('mb.toast.unstarred'));
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
      btn.title = target ? t('mb.action.mark_unread') : t('mb.action.mark_read');
      btn.innerHTML = `<i data-lucide="${target ? 'mail' : 'mail-open'}" class="w-4 h-4"></i>`;
      window.lucide?.createIcons();
      try { await api.patchEmail(em.int_id, { is_read: target }); } catch (_) {}
      window.toast(target ? t('mb.toast.read') : t('mb.toast.unread'));
    });

    $('#btn-trash').addEventListener('click', async () => {
      await animateCardLeave(em.int_id);
      try { await api.patchEmail(em.int_id, { folder: 'deleted' }); } catch (_) {}
      window.toast(t('mb.toast.deleted'));
      renderEmpty();
      await loadEmails();
    });

    $('#btn-more').addEventListener('click', () => {
      const anchor = $('#btn-more');
      const cur = state.folder || 'inbox';
      const moveLabel = cur === 'deleted' ? t('mb.move.restore') : t('mb.move.to_trash');
      const items = [
        { value: 'ai',     label: t('mb.action.reanalyze'), icon: 'sparkles' },
        { value: 'move',   label: moveLabel,                icon: cur === 'deleted' ? 'inbox' : 'folder-input' },
      ];
      openPopover(anchor, items, async (action) => {
        if (action === 'ai') {
          const toastCtrl = window.toast({ variant: 'loading', message: t('mb.ai.analyzing'), duration: 0 });
          try {
            const fresh = await api.reanalyzeEmail(em.int_id);
            renderEmail(fresh);
            await loadEmails();
            toastCtrl?.success(t('mb.ai.done'));
          } catch (_) {
            toastCtrl?.error(t('mb.ai.fail'));
          }
        } else if (action === 'move') {
          const target = cur === 'deleted' ? 'inbox' : 'deleted';
          await animateCardLeave(em.int_id);
          try { await api.patchEmail(em.int_id, { folder: target }); } catch (_) {}
          window.toast(target === 'deleted' ? t('mb.toast.moved_trash') : t('mb.toast.restored'));
          renderEmpty();
          await loadEmails();
        }
      });
    });

    function openComposer(prefill = null) {
      const composer = $('#mb-composer');
      if (!composer) return;
      const draft = $('#mb-draft');
      // Cancel any in-flight close animation + clear its inline residue
      // so the open transition starts from a known clean state.
      if (composer.dataset.closing === '1') {
        composer.getAnimations?.().forEach((a) => a.cancel());
        delete composer.dataset.closing;
      }
      $('#btn-reply-toggle')?.classList.add('active');
      if (draft) draft.style.display = 'none';

      const wasHidden = composer.style.display === 'none' || composer.offsetParent === null;

      composer.style.display = '';
      composer.style.opacity = '';
      composer.style.transform = '';

      const ta = composer.querySelector('textarea');
      if (ta && prefill !== null) ta.value = prefill;

      if (!wasHidden) {
        // Already on screen (e.g. user clicked Modifier on an open
        // draft) — no animation, just refresh focus on the textarea.
        composer.style.height = '';
        composer.style.overflow = '';
        ta?.focus();
        return;
      }

      // Measure the natural height with the composer briefly visible
      // but invisible-to-eye, so we know the target frame for the
      // height transition. Snapshot margins too — they collapse to 0
      // at the start of the open animation alongside height.
      composer.style.height = 'auto';
      const h = composer.offsetHeight;
      const cs = getComputedStyle(composer);
      const mt = cs.marginTop;
      const mb = cs.marginBottom;
      composer.style.height = '0px';
      composer.style.overflow = 'hidden';

      composer.dataset.opening = '1';
      const anim = composer.animate(
        [
          { height: '0px',    opacity: 0, transform: 'translateY(14px)', marginTop: '0px', marginBottom: '0px' },
          { height: h + 'px', opacity: 1, transform: 'translateY(0)',    marginTop: mt,    marginBottom: mb },
        ],
        { duration: 320, easing: 'cubic-bezier(.4, 0, .2, 1)' }
      );
      const cleanup = () => {
        composer.style.height = '';
        composer.style.overflow = '';
        delete composer.dataset.opening;
      };
      anim.onfinish = cleanup;
      anim.oncancel = cleanup;
      // Focus the textarea right away so the user can type during the
      // slide-in — feels snappier than waiting 320ms.
      ta?.focus();
    }

    // Reply-composer autosave state. Persisted in the `drafts` table
    // with `in_reply_to_int = em.int_id` so the draft survives across
    // app restarts AND shows up in the Brouillons folder.
    const replyDraft = {
      id: null,
      lastSnapshot: '',
      timer: null,
      // Promise of an in-flight save. New saves chain onto this so we
      // never run two API calls in parallel — that's how a single
      // typing burst used to create TWO rows when the second save
      // fired before the first createDraft had returned an id.
      inflight: null,
      deleted: false,        // user/send killed it; ignore late saves
    };

    // Repaint the #mb-draft box from current state. Called after every
    // autosave + delete + AI-generation event so the visible box stays
    // truthful. Source priority: user draft (drafts table) > AI
    // suggestion (em.draft_response). Hides itself when neither.
    function refreshDraftBox() {
      const box = $('#mb-draft');
      if (!box) return;
      const txtEl = $('#mb-draft-text');
      const labEl = $('#mb-draft-source-label');
      const iconEl = $('#mb-draft-icon');
      const userBody = (em._user_reply_draft && em._user_reply_draft.body_text) || '';
      const aiBody = em.draft_response || '';
      let source, body;
      if (userBody.trim()) {
        source = 'user';
        body = userBody;
      } else if (aiBody.trim()) {
        source = 'ai';
        body = aiBody;
      } else {
        source = 'none';
        body = '';
      }
      box.dataset.source = source;
      if (source === 'none') {
        box.dataset.loaded = '0';
        box.style.display = 'none';
        if (txtEl) txtEl.innerText = '';
        return;
      }
      box.dataset.loaded = '1';
      box.style.display = '';
      if (txtEl) txtEl.innerText = body;
      if (labEl) {
        labEl.textContent = source === 'user'
          ? t('mb.draft.user_label')
          : t('mb.draft.ai_suggestion');
      }
      if (iconEl) {
        // lucide icons are inlined as <svg> after createIcons(); swap
        // the data-lucide attribute and force a redraw so the visual
        // matches the source (pencil for user, sparkles for AI).
        const wantedIcon = source === 'user' ? 'pencil' : 'sparkles';
        if (iconEl.dataset?.lucide !== wantedIcon) {
          iconEl.outerHTML = `<i data-lucide="${wantedIcon}" class="w-4 h-4" id="mb-draft-icon"></i>`;
          window.lucide?.createIcons();
        }
      }
    }

    // Find any existing user draft saved against this email so the
    // composer can pre-fill it on first open. We never block render on
    // this — the lookup is async and the box updates via
    // refreshDraftBox() once the row arrives.
    (async () => {
      try {
        const rows = await api.getDrafts(em.account_email, { inReplyToInt: em.int_id });
        if (rows && rows.length) {
          replyDraft.id = rows[0].id;
          replyDraft.lastSnapshot = JSON.stringify({
            to:      rows[0].to || '',
            subject: rows[0].subject || '',
            body:    rows[0].body_text || '',
          });
          em._user_reply_draft = rows[0];
          refreshDraftBox();
        }
      } catch (_) { /* best-effort; no draft just means a fresh slate */ }
    })();

    // Persist the current composer state into the drafts table. Empty
    // forms don't materialise — saving "" everywhere would litter the
    // Brouillons folder with phantom rows. Saves are SERIALISED via
    // `replyDraft.inflight`: a second invocation while a first one is
    // still running waits for its result before deciding whether to
    // create or update. Without that gate, two scheduled saves with
    // `replyDraft.id == null` both fire createDraft in parallel and
    // produce duplicate rows.
    const flagSavingReply = (txt) => {
      const tag = $('#mb-compose-savetag-reply');
      if (tag) tag.textContent = txt;
    };

    async function saveReplyDraft() {
      // Chain onto any in-flight save so they run sequentially.
      const prior = replyDraft.inflight;
      const run = (async () => {
        if (prior) { try { await prior; } catch (_) {} }
        if (replyDraft.deleted) return;
        const ta = $('#mb-composer textarea');
        const toEl = $('#mbc-to');
        const subjEl = $('#mbc-subject');
        const fromEl = $('#mbc-from');
        if (!ta || !fromEl) return;
        const body = ta.value;
        const to = (toEl?.value || '').trim();
        const subject = (subjEl?.value || '').trim();
        const fromAcc = (fromEl.value || '').trim() || em.account_email;
        const snap = JSON.stringify({ to, subject, body });
        if (snap === replyDraft.lastSnapshot) return;
        const isEmpty = !to && !subject && !body.trim();
        if (isEmpty && replyDraft.id == null) return;
        flagSavingReply(t('mb.draft.saving'));
        try {
          let row = null;
          if (replyDraft.id == null) {
            row = await api.createDraft({
              from_account: fromAcc,
              to,
              subject,
              body_text: body,
              in_reply_to_int: em.int_id,
            });
            replyDraft.id = row?.id ?? null;
          } else {
            row = await api.updateDraft(replyDraft.id, {
              from_account: fromAcc,
              to,
              subject,
              body_text: body,
            });
          }
          replyDraft.lastSnapshot = snap;
          em._user_reply_draft = row || {
            id: replyDraft.id, account_email: fromAcc, to, subject, body_text: body,
          };
          refreshDraftBox();
          flagSavingReply(t('mb.draft.saved'));
          setTimeout(() => flagSavingReply(''), 2000);
          // If the visible folder is Brouillons, refresh so the row
          // updated_at hops back to the top.
          if (state.folder === 'draft') loadEmails();
        } catch (_) {
          flagSavingReply(t('mb.draft.save_fail'));
          // Network/validation failure — keep going; next keystroke
          // schedules another attempt.
        }
      })();
      replyDraft.inflight = run;
      try { await run; }
      finally {
        // Only clear if this is still the current promise — a fresh
        // save that started after us would have replaced `inflight`,
        // and we musn't wipe its reference.
        if (replyDraft.inflight === run) replyDraft.inflight = null;
      }
    }

    function scheduleReplyDraftSave() {
      if (replyDraft.timer) clearTimeout(replyDraft.timer);
      replyDraft.timer = setTimeout(() => {
        replyDraft.timer = null;
        saveReplyDraft();
      }, 1500);
    }

    // Drop the linked draft. Called after a successful send (the reply
    // is no longer "in progress") and from the trash button on the
    // draft box. Resilient to the row not existing yet. Also clears
    // `em.draft_response` when invoked from a "discard everything"
    // affordance (opts.alsoClearAi=true) so a polluted AI slot from
    // earlier code paths can be cleaned up via the same control.
    async function deleteReplyDraft({ alsoClearAi = false } = {}) {
      replyDraft.deleted = true;
      if (replyDraft.timer) { clearTimeout(replyDraft.timer); replyDraft.timer = null; }
      // Drain any save still running so it can't recreate the row
      // AFTER the DELETE round-trip.
      if (replyDraft.inflight) { try { await replyDraft.inflight; } catch (_) {} }
      const id = replyDraft.id;
      replyDraft.id = null;
      em._user_reply_draft = null;
      replyDraft.lastSnapshot = '';
      if (id != null) {
        try { await api.deleteDraft(id); } catch (_) {}
      }
      if (alsoClearAi && em.draft_response) {
        em.draft_response = '';
        const idx = state.emails.findIndex((e) => e.int_id === em.int_id);
        if (idx >= 0) state.emails[idx].draft_response = '';
        api.patchEmail(em.int_id, { draft_response: '' }).catch(() => {});
        _patchCardDraftIcon(em.int_id, false);
      }
      // Allow saveReplyDraft to fire again after a discard if the user
      // keeps typing — wiping `replyDraft.deleted` re-enables the
      // autosave path so the next keystroke creates a fresh row.
      replyDraft.deleted = false;
      refreshDraftBox();
      if (state.folder === 'draft') loadEmails();
    }

    function closeComposer({ skipDraftSync = false } = {}) {
      const composer = $('#mb-composer');
      if (!composer) return;
      // Confirm close if the user typed something
      const ta = composer.querySelector('textarea');
      if (ta && ta.value.trim().length > 0) {
        if (!window.confirm(t('mb.composer.confirm_discard'))) return;
      }
      const draft = $('#mb-draft');
      $('#btn-reply-toggle')?.classList.remove('active');
      // Flush any pending autosave so the user doesn't lose the last
      // <1.5s of typing. Skip on send paths — the draft is about to
      // be deleted anyway and we'd race the DELETE.
      if (!skipDraftSync) {
        if (replyDraft.timer) { clearTimeout(replyDraft.timer); replyDraft.timer = null; }
        saveReplyDraft();
      }

      const finalize = () => {
        composer.style.display = 'none';
        composer.style.height = '';
        composer.style.overflow = '';
        delete composer.dataset.closing;
        if (draft && draft.dataset.loaded === '1') draft.style.display = '';
      };

      // Already hidden or mid-close — short-circuit to the final state
      // so a double-click on the X / a race with sendCurrentMessage
      // doesn't restart the animation.
      if (composer.style.display === 'none' || composer.dataset.closing === '1') {
        finalize();
        return;
      }
      // Cancel a running open animation so we don't fight it. The
      // post-cancel offsetHeight gives us the real "current" height
      // wherever the open was at, which is the start frame we want.
      if (composer.dataset.opening === '1') {
        composer.getAnimations?.().forEach((a) => a.cancel());
        delete composer.dataset.opening;
      }
      composer.dataset.closing = '1';

      // Snapshot the current height: auto-height can't transition, so
      // we lock pixels for the start frame, then animate to 0.
      const h = composer.offsetHeight;
      const cs = getComputedStyle(composer);
      const mt = cs.marginTop;
      const mb = cs.marginBottom;
      composer.style.overflow = 'hidden';
      composer.style.height = h + 'px';

      // Slide-down + fade. Margins collapse to 0 alongside so the
      // surrounding email body smoothly reclaims the gap. Web
      // Animations API leaves no inline styles behind once it
      // finishes, which keeps the next openComposer() clean.
      const anim = composer.animate(
        [
          { height: h + 'px', opacity: 1, transform: 'translateY(0)',     marginTop: mt,    marginBottom: mb },
          { height: '0px',    opacity: 0, transform: 'translateY(14px)',  marginTop: '0px', marginBottom: '0px' },
        ],
        { duration: 320, easing: 'cubic-bezier(.4, 0, .2, 1)' }
      );
      anim.onfinish = finalize;
      // Some browsers fire `cancel` instead of `finish` if the
      // composer is removed mid-anim (renderEmail rebuild). Treat both
      // the same way so we don't leave the element in a half-closed
      // state.
      anim.oncancel = finalize;
    }

    // Collect From/To/Subject/body from the meta strip + textarea, post
    // /api/emails/send and surface the result via toast. Used by both the
    // composer's own send button and the AI draft box's "Envoyer" button.
    // `replyToIntId` threads the message correctly when present.
    // Phase 4 — staged attachments for the reply composer.
    // Each entry: { upload_id, filename, size, content_type, kind }
    // where `kind` is 'attachment' (paperclip) or 'inline' (image
    // button — embedded as cid: in the HTML body). Re-rendered via
    // renderAttachStrip on every mutation.
    const stagedAttachments = [];

    function renderAttachStrip() {
      const strip = $('#mb-attach-strip');
      if (!strip) return;
      strip.dataset.empty = stagedAttachments.length ? '0' : '1';
      strip.innerHTML = stagedAttachments.map((a, i) => `
        <span class="mb-attach-pill" data-idx="${i}">
          <i data-lucide="${a.kind === 'inline' ? 'image' : 'paperclip'}" class="w-3 h-3"></i>
          <span class="mb-attach-name" title="${escapeHtml(a.filename)}">${escapeHtml(a.filename)}</span>
          <span class="mb-attach-size">${fmtBytes(a.size)}</span>
          <button type="button" class="mb-attach-remove" data-idx="${i}" title="${t('mb.att.remove')}" aria-label="${t('mb.att.remove')}">
            <i data-lucide="x" class="w-3 h-3"></i>
          </button>
        </span>
      `).join('');
      window.lucide?.createIcons({ el: strip });
      strip.querySelectorAll('.mb-attach-remove').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const idx = parseInt(btn.dataset.idx, 10);
          const removed = stagedAttachments.splice(idx, 1)[0];
          renderAttachStrip();
          if (removed?.upload_id) {
            try { await api.deleteUpload(removed.upload_id); } catch (_) {}
          }
        });
      });
    }

    async function handleFilePick(files, kind) {
      if (!files || !files.length) return;
      for (const file of files) {
        const tmp = { upload_id: null, filename: file.name, size: file.size, content_type: file.type, kind, uploading: true };
        stagedAttachments.push(tmp);
        renderAttachStrip();
        try {
          const meta = await api.uploadAttachment(file);
          tmp.upload_id = meta.upload_id;
          tmp.filename = meta.filename;
          tmp.size = meta.size;
          tmp.content_type = meta.content_type;
          tmp.uploading = false;
          renderAttachStrip();
        } catch (err) {
          // Remove the failed entry, surface the error.
          const idx = stagedAttachments.indexOf(tmp);
          if (idx >= 0) stagedAttachments.splice(idx, 1);
          renderAttachStrip();
          window.toast(err?.message || t('mb.toast.upload_fail'), 5000);
        }
      }
    }

    $('#btn-attach-file')?.addEventListener('click', () => $('#mb-file-input')?.click());
    $('#btn-attach-image')?.addEventListener('click', () => $('#mb-image-input')?.click());
    $('#mb-file-input')?.addEventListener('change', (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      handleFilePick(files, 'attachment');
    });
    $('#mb-image-input')?.addEventListener('change', (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      handleFilePick(files, 'inline');
    });
    // Drag-and-drop files onto the composer (uses delegation on read-pane
    // so it covers both the inline reply composer and the standalone new composer).
    const onDropFiles = (e) => {
      const composer = e.target.closest('#mb-composer');
      if (!composer) return;
      e.preventDefault();
      composer.classList.remove('mb-composer-dragover');
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      // Detect which composer is active: new compose has its own handler
      const isNew = composer.classList.contains('mb-composer-standalone');
      handleFilePick(files, 'attachment');
    };
    host.addEventListener('dragenter', (e) => {
      if (!e.target.closest('#mb-composer')) return;
      e.preventDefault();
      e.target.closest('#mb-composer')?.classList.add('mb-composer-dragover');
    });
    host.addEventListener('dragover', (e) => {
      if (!e.target.closest('#mb-composer')) return;
      e.preventDefault();
    });
    host.addEventListener('dragleave', (e) => {
      const composer = e.target.closest('#mb-composer');
      if (!composer) return;
      if (!composer.contains(e.relatedTarget)) composer.classList.remove('mb-composer-dragover');
    });
    host.addEventListener('drop', onDropFiles);

    async function sendCurrentMessage({ trigger, replyToIntId, bodyOverride } = {}) {
      const fromSel = $('#mbc-from');
      const toInp   = $('#mbc-to');
      const subjInp = $('#mbc-subject');
      const ta      = $('#mb-composer textarea');
      const fromAcc = (fromSel?.value || '').trim();
      const toRaw   = (toInp?.value || '').trim();
      const subject = (subjInp?.value || '').trim();
      const body    = (bodyOverride != null ? bodyOverride : (ta?.value || '')).trim();

      if (!fromAcc) { window.toast(t('mb.toast.from_required')); return; }
      if (!toRaw)   { window.toast(t('mb.toast.to_required')); toInp?.focus(); return; }
      if (!body)    { window.toast(t('mb.toast.body_empty')); ta?.focus(); return; }
      // Refuse sending while uploads are still in flight.
      if (stagedAttachments.some((a) => a.uploading)) {
        window.toast(t('mb.toast.uploading')); return;
      }

      const toList = toRaw.split(',').map((s) => s.trim()).filter(Boolean);
      const attachIds = stagedAttachments.filter((a) => a.kind === 'attachment' && a.upload_id).map((a) => a.upload_id);
      const inlineIds = stagedAttachments.filter((a) => a.kind === 'inline'     && a.upload_id).map((a) => a.upload_id);
      const btn = trigger || $('#btn-composer-send');
      const setSending = sendButtonStateFactory(btn, t('mb.send'));
      setSending('loading');
      try {
        await api.sendEmail({
          from_account: fromAcc,
          to: toList,
          subject,
          body_text: body,
          reply_to_int_id: replyToIntId ?? null,
          attachments: attachIds,
          inline_images: inlineIds,
        });
        setSending('sent');
        window.toast(t('mb.toast.sent'));
        // Drop BOTH the user-typed draft AND the AI suggestion. Avant ce
        // changement seul le user draft était nettoyé, ce qui laissait
        // la box #mb-draft réapparaître après closeComposer (parce que
        // em.draft_response était toujours en DB + dataset.loaded='1').
        // Résultat : l'user voyait le brouillon "encore là" alors qu'il
        // venait de l'envoyer, expérience confuse. La réponse est partie,
        // le brouillon n'a plus aucune raison d'être.
        await deleteReplyDraft({ alsoClearAi: true });
        // Backend already cleaned the staged uploads on success; clear
        // the local list so a re-open of the composer starts empty.
        stagedAttachments.length = 0;
        renderAttachStrip();
        // Hold the green "Envoyé" pulse long enough for the user to
        // register success — short enough that the pane still feels
        // responsive. ~1500 ms reads as a deliberate confirmation beat.
        await new Promise((r) => setTimeout(r, 1500));
        closeComposer({ skipDraftSync: true });
        if (ta) ta.value = '';
        setSending('idle');
      } catch (err) {
        setSending('idle');
        const msg = (err && err.message) || t('mb.toast.send_fail');
        window.toast(msg, 6000);
      }
    }

    $('#btn-reply-toggle').addEventListener('click', () => {
      if ($('#btn-reply-toggle').classList.contains('active')) {
        closeComposer();
      } else {
        // Prefer the user's saved draft (drafts table, in_reply_to_int)
        // over the AI suggestion when both exist — the user already
        // moved past the AI text. The composer-specific autosave keeps
        // the draft fresh.
        let prefill = null;
        if (em._user_reply_draft && (em._user_reply_draft.body_text || '').length) {
          prefill = em._user_reply_draft.body_text;
        } else {
          const draft = $('#mb-draft');
          const hasDraft = draft && draft.dataset.loaded === '1';
          prefill = hasDraft ? ($('#mb-draft-text')?.innerText ?? null) : null;
        }
        openComposer(prefill);
        // Also restore To/Subject from a saved user draft (the AI
        // suggestion only carries body text, the meta is fresh).
        if (em._user_reply_draft) {
          const d = em._user_reply_draft;
          if (d.to)      { const el = $('#mbc-to');      if (el) el.value = d.to; }
          if (d.subject) { const el = $('#mbc-subject'); if (el) el.value = d.subject; }
        }
        // Wire input listeners once the composer is open. Idempotent
        // via dataset flag so re-opening doesn't stack listeners.
        bindReplyAutosave();
      }
    });

    $('#btn-forward').addEventListener('click', () => {
      const subj = em.subject
        ? (em.subject.toLowerCase().startsWith('fw:') ? em.subject : 'Fw: ' + em.subject)
        : '';
      renderComposeNew({
        draft: {
          account_email: em.account_email || '',
          to: '',
          subject: subj,
          body_text: buildForwardBody(em),
        },
      });
    });

    $('#btn-composer-close')?.addEventListener('click', () => closeComposer());

    $('#btn-draft-edit')?.addEventListener('click', () => {
      const text = $('#mb-draft-text')?.innerText ?? '';
      openComposer(text);
      bindReplyAutosave();
    });

    // Trash icon on the draft box: discards both the user-typed draft
    // (drafts table row) AND any AI suggestion (em.draft_response) so
    // the box drops back to "no draft for this email".
    $('#btn-draft-discard')?.addEventListener('click', async () => {
      const sourceWasUser = $('#mb-draft')?.dataset?.source === 'user';
      const confirmMsg = sourceWasUser
        ? t('mb.draft.confirm.delete_draft')
        : t('mb.draft.confirm.delete_suggestion');
      if (!confirm(confirmMsg)) return;
      const ta = $('#mb-composer textarea');
      if (ta) ta.value = '';
      await deleteReplyDraft({ alsoClearAi: true });
      const composer = $('#mb-composer');
      if (composer && composer.style.display !== 'none') {
        closeComposer({ skipDraftSync: true });
      }
      window.toast(t('mb.toast.draft_deleted'));
    });

    // Attach `input` listeners on the four composer fields exactly
    // once. The flag lives on the composer DOM node so reopen ↔ close
    // cycles don't re-register and the same handler keeps firing for
    // the lifetime of the rendered email pane.
    function bindReplyAutosave() {
      const composer = $('#mb-composer');
      if (!composer || composer.dataset.autosaveBound === '1') return;
      composer.dataset.autosaveBound = '1';
      ['#mbc-to', '#mbc-subject', '#mbc-from'].forEach((sel) => {
        composer.querySelector(sel)?.addEventListener('input',  scheduleReplyDraftSave);
        composer.querySelector(sel)?.addEventListener('change', scheduleReplyDraftSave);
      });
      composer.querySelector('textarea')?.addEventListener('input', scheduleReplyDraftSave);
    }

    // Composer's own Send button — uses whatever the user typed in the
    // textarea + meta strip.
    $('#btn-composer-send')?.addEventListener('click', (e) => {
      sendCurrentMessage({
        trigger: e.currentTarget,
        replyToIntId: em.int_id,
      });
    });

    // AI draft box's Send button — sends the AI-generated text as-is
    // without needing the user to open the composer first. Pre-fills
    // body from #mb-draft-text so the meta strip is read from the
    // (still-rendered) composer DOM.
    $('#btn-draft-send')?.addEventListener('click', (e) => {
      const text = $('#mb-draft-text')?.innerText || '';
      // Make sure the composer is open so the meta strip exists in the DOM.
      openComposer(text);
      sendCurrentMessage({
        trigger: e.currentTarget,
        replyToIntId: em.int_id,
        bodyOverride: text,
      });
    });

    // Composer drag-to-resize: dragging the top handle UP grows the
    // textarea, dragging DOWN shrinks it. Pointer-events + capture so
    // the drag stays glued to the cursor even when it leaves the
    // handle's hit area.
    $('#mb-composer-handle')?.addEventListener('pointerdown', (e) => {
      const handle = e.currentTarget;
      const composer = $('#mb-composer');
      const ta = composer?.querySelector('textarea');
      if (!composer || !ta) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('is-dragging');

      const startY = e.clientY;
      const startH = ta.offsetHeight;
      // .mb-read-content (email body) and .mb-composer are flex
      // siblings of .mb-read-body. Composer grows = email body
      // viewport shrinks. The cap must keep .mb-read-content tall
      // enough that none of its inner content overflows — otherwise
      // a scrollbar appears on .mb-read-content itself, which is what
      // we want to avoid. Threshold = read-content's own paddings +
      // sum of fixed (non-iframe) children + the iframe's min-height
      // (the iframe absorbs all extra flex room, so its min-height
      // is what sets the floor). Snapshotted at drag start so the
      // cap doesn't drift mid-drag while the layout reflows.
      const readBody    = host.querySelector('.mb-read-body');
      const meta        = host.querySelector('.mb-read-meta');
      const readContent = host.querySelector('.mb-read-content');
      const iframe      = readContent?.querySelector('.mb-body-iframe');

      let minContentH = 80; // safe default if measurement fails
      if (readContent) {
        const cs = getComputedStyle(readContent);
        minContentH = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        for (const child of readContent.children) {
          if (child === iframe) continue;
          if (getComputedStyle(child).display === 'none') continue;
          minContentH += child.offsetHeight;
        }
        if (iframe) {
          minContentH += parseFloat(getComputedStyle(iframe).minHeight) || 0;
        }
      }

      const composerCs = getComputedStyle(composer);
      const composerMargins = (parseFloat(composerCs.marginTop) || 0)
                            + (parseFloat(composerCs.marginBottom) || 0);
      const nonTaH = composer.offsetHeight - startH;       // handle + bar + paddings
      const bodyH  = readBody?.clientHeight || window.innerHeight;
      const metaH  = meta?.offsetHeight || 0;

      // Two ceilings, take the smaller:
      //   1. Layout cap: composer can't grow past what leaves room for
      //      the email body's minimum (no scrollbar on .mb-read-content).
      //   2. Hard cap (ABSOLUTE_MAX_COMPOSER): even when the window is
      //      huge, a reply composer doesn't need to be a thousand pixels
      //      tall. Caps the textarea around what comfortably fits a long
      //      paragraph reply without dwarfing the email it replies to.
      const ABSOLUTE_MAX_COMPOSER = 520;
      const layoutCap   = Math.max(120, bodyH - metaH - minContentH - composerMargins);
      const maxComposerH = Math.min(layoutCap, ABSOLUTE_MAX_COMPOSER);
      const maxH = Math.max(60, maxComposerH - nonTaH);
      const minH = 60;

      const onMove = (ev) => {
        const dy = startY - ev.clientY;                    // drag up → positive
        const newH = Math.max(minH, Math.min(maxH, startH + dy));
        ta.style.height = newH + 'px';
      };
      const onUp = () => {
        handle.classList.remove('is-dragging');
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });

    // Top-bar sparkles button — triggers AI analysis (summary + importance
    // score). Repaints the read pane with the fresh em so the mb-ai-box
    // appears.
    $('#btn-analyze')?.addEventListener('click', async () => {
      const btn = $('#btn-analyze');
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('loading');
      const toastCtrl = window.toast({ variant: 'loading', message: t('mb.ai.analyzing'), duration: 0 });
      try {
        const fresh = await api.reanalyzeEmail(em.int_id);
        renderEmail(fresh);
        await loadEmails();
        toastCtrl?.success(t('mb.ai.done'));
      } catch (_) {
        toastCtrl?.error(t('mb.ai.fail'));
      } finally {
        // renderEmail rebuilt the DOM, so the local btn ref is stale —
        // safe to no-op if it was replaced.
        const live = $('#btn-analyze');
        if (live) {
          live.disabled = false;
          live.classList.remove('loading');
        }
      }
    });

    // Composer-bar sparkles — generates a draft reply and streams the
    // tokens into the textarea as they arrive. Streaming endpoint is
    // local-only ; en mode OpenAI on retombe sur l'endpoint non-streaming
    // (api.generateDraft) qui renvoie le texte complet en un coup.
    $('#btn-ai-draft')?.addEventListener('click', async () => {
      const btn = $('#btn-ai-draft');
      const ta = $('#mb-composer textarea');
      if (!btn || !ta || btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('loading');
      // Vide la zone — on remplace par le draft généré. Si l'user
      // tenait déjà à un brouillon perso, le bouton ne devrait pas
      // exister (l'UI le cache quand draft_response est déjà défini)
      // mais on protège quand même : on prévient avant d'écraser.
      if (ta.value && !window.confirm(t('mb.ai.overwrite_confirm'))) {
        btn.disabled = false;
        btn.classList.remove('loading');
        return;
      }
      ta.value = '';
      window.railToast?.setAiBusy?.(true);
      try {
        const streamed = await _streamDraftInto(em.int_id, ta);
        if (!streamed.ok) {
          // Soit le streaming a refusé (provider OpenAI → 409), soit
          // il a crashé en cours. Fallback non-streaming.
          if (streamed.fallback) {
            const res = await api.generateDraft(em.int_id);
            const text = res.draft_response || '';
            if (!text) { window.toast(t('mb.ai.draft_fail')); return; }
            ta.value = text;
          } else {
            window.toast(t('mb.ai.draft_error'));
            return;
          }
        }
        ta.focus();
        // Mirror the new state locally (backend already flipped
        // needs_reply=1) so the list card icons stay coherent without a
        // full re-fetch.
        const finalText = ta.value;
        em.draft_response = finalText;
        em.needs_reply = 1;
        const idx = state.emails.findIndex((e) => e.int_id === em.int_id);
        if (idx >= 0) {
          state.emails[idx].draft_response = finalText;
          state.emails[idx].needs_reply = 1;
        }
        _patchCardReplyIcon(em.int_id, true);
        _patchCardDraftIcon(em.int_id, true);
      } catch (_) {
        window.toast(t('mb.ai.draft_error'));
      } finally {
        window.railToast?.setAiBusy?.(false);
        btn.disabled = false;
        btn.classList.remove('loading');
      }
    });

    window.lucide?.createIcons();
  }

  async function openEmail(intId) {
    // Drafts use synthetic negative ids — re-route to the composer
    // pre-filled with the saved body/recipient/subject instead of
    // hitting /api/emails (which wouldn't find the row).
    if (intId < 0) {
      const row = state.emails.find((e) => e.int_id === intId);
      if (row && row._draft) {
        state.selectedId = intId;
        setSelectionMode(true);
        _selectCard(intId);
        renderComposeNew({ draft: row._draft });
        return;
      }
    }
    state.selectedId = intId;
    setSelectionMode(true);
    // Reflect selection in list (targeted, not full iteration)
    _selectCard(intId);
    try {
      const em = await api.getEmail(intId);
      // Prevent re-animation when switching between emails: brief fade
      const pane = $('#read-pane');
      if (pane && pane.innerHTML.trim()) pane.classList.add('mb-read-swap');
      renderEmail(em);
      if (pane) setTimeout(() => pane.classList.remove('mb-read-swap'), 280);
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
      $('#read-pane').innerHTML = `<div class="mb-read-empty">${t('mb.read.error_load', { msg: escapeHtml(err.message) })}</div>`;
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
      icon.title = t('mb.att.dangerous');
    } else if (suspicious) {
      icon = document.createElement('i');
      icon.setAttribute('data-lucide', 'paperclip');
      icon.className = 'w-3.5 h-3.5 mb-att-warn';
      icon.title = t('mb.att.suspicious');
    } else if (total > 0) {
      icon = document.createElement('i');
      icon.setAttribute('data-lucide', 'paperclip');
      icon.className = 'w-3.5 h-3.5 mb-att-icon';
      icon.title = t('mb.att.count', { n: total });
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

  /**
   * Stream a generated draft from the backend into `targetTextarea`.
   * Returns `{ok: true}` when the stream completed cleanly, or
   * `{ok: false, fallback: true}` when the server refused with 409
   * (provider doesn't support streaming → caller can retry on the
   * non-streaming endpoint), `{ok: false}` for unexpected failures.
   *
   * The SSE format is:
   *    data: {"delta": "...chunk..."}
   *    ...
   *    data: {"done": true, "full_text": "...", "needs_reply": true}
   *
   * We don't try to parse the JSON incrementally — events arrive
   * whole, one per `\n\n` boundary. Network-level chunking is handled
   * by the loop via a buffer.
   */
  async function _streamDraftInto(intId, targetTextarea) {
    let resp;
    try {
      resp = await fetch(`/api/emails/${intId}/draft/stream`, {
        method: 'POST',
      });
    } catch (e) {
      return { ok: false };
    }
    if (resp.status === 409) {
      // Provider doesn't support streaming — let caller fall back.
      return { ok: false, fallback: true };
    }
    if (!resp.ok || !resp.body) {
      return { ok: false };
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let finalText = '';
    let sawError = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const evt = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = evt.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        let payload;
        try {
          payload = JSON.parse(dataLine.slice(5).trim());
        } catch {
          continue;
        }
        if (payload.error) {
          sawError = true;
          continue;
        }
        if (payload.delta) {
          // Append to textarea + autoscroll to bottom so the user sees
          // the latest tokens. requestAnimationFrame avoids a layout
          // thrash on each chunk (chunks can be ≤3 tokens, that's
          // dozens of renders per second).
          targetTextarea.value += payload.delta;
          targetTextarea.scrollTop = targetTextarea.scrollHeight;
        }
        if (payload.done) {
          // Use the server's final (post-strip-prefix) text as the
          // authoritative value — we replace what was streamed because
          // the backend may have trimmed a "Voici la réponse:" preamble.
          if (typeof payload.full_text === 'string') {
            finalText = payload.full_text;
            if (targetTextarea.value !== finalText) {
              targetTextarea.value = finalText;
            }
          } else {
            finalText = targetTextarea.value;
          }
        }
      }
    }
    if (sawError && !finalText) return { ok: false };
    return { ok: true };
  }

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
      t('mb.ai.needs_reply'),
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
      t('mb.ai.draft_ready'),
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
    _lastLoadAt = Date.now();
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
            favourite: a.favourite || 0,
            draft: a.draft || 0,
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
            unread: 0, needs_reply: 0, favourite: 0, draft: 0, total: 0,
            sync_error: a.sync_error || null,
          };
        } else {
          state.accountStats[a.email].sync_error = errMap[a.email] || null;
        }
      }
      // Purge accountFilters entries that no longer exist in config.
      // MUST run inside the try: on a transient network blip (catch path)
      // state.accounts becomes [] and a purge here would wipe every chip
      // the user just selected. We only reconcile when we trust the
      // server response.
      const activeEmails = new Set(accs.map((a) => a.email));
      for (const em of [...state.accountFilters]) {
        if (!activeEmails.has(em)) state.accountFilters.delete(em);
      }
    } catch (_) {
      // Transient error — keep state.accounts and state.accountFilters
      // as-is. The next successful tick will reconcile them.
    }
    renderChips();
    renderAccounts();
    // Only re-filter the list once the initial render has completed.
    // On the very first load, loadEmails() owns the first renderList() call
    // (with _firstRender=true) — calling applyFilter() here before that would
    // either steal the animation token or wipe the animation mid-play.
    if (!_firstRender) applyFilter();
    updateBadge();
  }

  async function loadEmails(opts) {
    const isBackground = opts?.background;
    // On background refresh skip skeleton (visual flash) and chip re-render.
    if (!isBackground) renderSkeleton();

    // Capture a fresh token. Any in-flight call with an older token is
    // considered stale and its response is dropped — a slow response
    // must never overwrite the state set by a more recent call.
    const myToken = ++_loadEmailsToken;
    _lastLoadAt = Date.now();
    // Exit search mode on a real navigation (folder/category/account/thread
    // toggle). Background refreshes keep the active search; the first load
    // preserves a deep-linked ?q=.
    if (!isBackground && _navLoadSeen && state.query) {
      state.query = '';
      state.searchResults = null;
      const sinp = $('#search');
      if (sinp) sinp.value = '';
    }
    _navLoadSeen = true;
    try {
      // 1 selected → single-account filter. 2+ selected → server-side
      // IN() filter via `accounts=` so the 2000-row cap applies to the
      // chosen set instead of the global stream (otherwise busy accounts
      // evict mail from lighter ones before the multi-selection sees it).
      // 0 selected → no filter (show all accounts).
      const accFilters = [...state.accountFilters];
      const singleAcc = accFilters.length === 1 ? accFilters[0] : undefined;
      const multiAccs = accFilters.length > 1 ? accFilters.join(',') : undefined;

      // The Brouillons folder lives in its own table — re-shape draft
      // rows so the rest of the list-rendering code (cardHtml, sort,
      // filter…) works without per-folder branching. Drafts use a
      // negative int_id so they never collide with real emails; the
      // open path detects this and re-routes to renderDraftEditor.
      if ((state.folder || 'inbox') === 'draft') {
        const drafts = await api.getDrafts(singleAcc);
        if (myToken !== _loadEmailsToken) return;  // stale → drop
        state.emails = drafts.map((d) => ({
          int_id: -Math.abs(d.id),
          message_id: `draft:${d.id}`,
          account_email: d.account_email,
          subject: d.subject || t('mb.draft.no_subject'),
          sender: d.account_email || t('mb.draft.sender_fallback'),
          recipient: d.to || '',
          date_received: d.updated_at || d.created_at || '',
          body_text: d.body_text || '',
          body_html: '',
          category: 'other',
          folder: 'draft',
          is_read: 1,
          is_favourite: 0,
          summary: '',
          needs_reply: 0,
          draft_response: null,
          importance_score: 0,
          attachments: { total: 0, dangerous: 0, suspicious: 0 },
          _draft: d,
        }));
        if (state.selectedIds.size) {
          const present = new Set(state.emails.map((e) => e.int_id));
          for (const id of [...state.selectedIds]) {
            if (!present.has(id)) state.selectedIds.delete(id);
          }
          renderSelectionBar();
        }
        applyFilter(isBackground);
        return;
      }

      const params = {
        limit: 500,
        account: singleAcc,
        accounts: multiAccs,
        // category / is_read / needs_reply are applied client-side in
        // applyFilter() — we always load the broad folder set so chip
        // toggles don't round-trip the DB. Passing them here would slow
        // the chip back down and waste the cached state.emails.
        folder: state.folder || 'inbox',
        label: state.labelFilter ?? undefined,
        // Conversation view collapses the list to one row per thread.
        view: state.threadView ? 'threads' : undefined,
      };
      const fresh = await api.getEmails(params);
      if (myToken !== _loadEmailsToken) return;  // stale → drop
      state.emails = fresh;
      // Drop selections that are no longer present in the loaded set.
      if (state.selectedIds.size) {
        const present = new Set(state.emails.map((e) => e.int_id));
        for (const id of [...state.selectedIds]) {
          if (!present.has(id)) state.selectedIds.delete(id);
        }
        renderSelectionBar();
      }
      applyFilter(isBackground);

      // A background refresh that lands while a search is active would
      // otherwise re-render the stale searchResults (new mail invisible).
      // Re-issue the search so the result set reflects the fresh data.
      if (isBackground && state.query.trim() && state.searchResults) {
        runServerSearch();
      }

      // Auto-focus from URL ?focus=. Always open — even if the email is
      // outside the visible list (older than the 300 row cap, in another
      // folder, hidden by current filters…). openEmail() fetches the row
      // through the API so the read pane works regardless of list state.
      const m = location.hash.match(/[?&]focus=(\d+)/);
      if (m) {
        const id = parseInt(m[1], 10);
        if (Number.isFinite(id)) openEmail(id);
      }
      // NOTE: renderEmpty() is intentionally NOT called here for background
      // refreshes — the initial mount already calls it, and periodic reloads
      // must never close a mail the user is currently reading.
    } catch (err) {
      if (myToken !== _loadEmailsToken) return;  // stale → drop (don't paint old error)
      $('#email-list').innerHTML = `<div style="padding:24px;color:var(--danger)">${t('mb.list.error', { msg: escapeHtml(err.message) })}</div>`;
    }
  }

  // ── Sync ──────────────────────────────────────────────────
  function setSyncSpinner(on) {
    $('#btn-sync')?.classList.toggle('syncing', on);
  }

  async function triggerSync() {
    const btn = $('#btn-sync');
    if (btn?.disabled) return;
    try {
      const r = await api.triggerSync();
      window.toast({
        variant: r.ok ? 'loading' : 'info',
        message: r.message || (r.ok ? t('mb.sync.started') : t('mb.sync.already_running')),
        duration: 2400,
      });
      _syncWasRunning = true;
      setSyncSpinner(true);
      pollSync();
    } catch (err) {
      // Rate-limit: the backend already shipped a French message in
      // err.message ("Trop de requêtes…"). Honour Retry-After by
      // disabling the button so the user can't keep hammering it.
      if (err.status === 429) {
        const wait = Math.max(3, err.retryAfter || 10);
        window.toast({
          variant: 'warning',
          message: err.message || t('mb.sync.wait', { n: wait }),
          duration: wait * 1000,
        });
        if (btn) {
          btn.disabled = true;
          btn.classList.add('is-cooldown');
          setTimeout(() => {
            btn.disabled = false;
            btn.classList.remove('is-cooldown');
          }, wait * 1000);
        }
      } else {
        window.toast({ variant: 'error', message: t('mb.sync.error', { msg: err.message || '' }) });
      }
    }
  }

  let syncTimer = null;
  let _syncWasRunning = false; // module-level so triggerSync() can prime it

  async function pollSync() {
    if (syncTimer) return;
    const tick = async () => {
      try {
        const s = await api.getSyncStatus();
        if (s.running) {
          _syncWasRunning = true;
          setSyncSpinner(true);
        } else {
          setSyncSpinner(false);
          if (_syncWasRunning) {
            _syncWasRunning = false;
            // Background refresh: a completed sync is NOT a navigation, so it
            // must not clear an active search or flash the skeleton.
            loadEmails({ background: true });
            loadAccounts();
          }
        }
      } catch (_) {
        setSyncSpinner(false);
      }
    };
    syncTimer = setInterval(tick, 5000);
    tick();
  }

  // ── Search ────────────────────────────────────────────────
  // Server-side search (Gmail-style operators) when a query is active;
  // debounced + token-guarded so out-of-order responses can't overwrite a
  // newer search. Empty query restores the local view over the loaded set.
  let _searchTimer;
  let _searchToken = 0;

  // Run one server-side search for the current query, scoped to the active
  // folder + account. The Drafts folder lives in a separate table, so there
  // we skip the server and let applyFilter() filter the loaded drafts locally.
  async function runServerSearch() {
    const q = state.query.trim();
    if (!q) { _searchToken++; state.searchResults = null; applyFilter(); return; }
    const folder = state.folder || 'inbox';
    if (folder === 'draft') { state.searchResults = null; applyFilter(); return; }
    const myToken = ++_searchToken;
    const params = { folder };
    if (state.accountFilters.size === 1) params.account = [...state.accountFilters][0];
    try {
      const res = await api.searchEmails(q, params);
      if (myToken !== _searchToken) return;   // superseded by a newer search
      state.searchResults = res.results || [];
    } catch (_) {
      if (myToken !== _searchToken) return;
      state.searchResults = null;             // fall back to local filtering
    }
    applyFilter();
  }

  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    if (_searchTimer) clearTimeout(_searchTimer);
    if (!state.query.trim()) { _searchToken++; state.searchResults = null; applyFilter(); return; }
    _searchTimer = setTimeout(runServerSearch, 250);
  });

  // Conversation-view toggle: collapse the list by thread (server-side).
  (function wireThreadToggle() {
    const btn = $('#thread-toggle');
    if (!btn) return;
    const sync = () => {
      btn.classList.toggle('is-active', state.threadView);
      btn.setAttribute('aria-pressed', state.threadView ? 'true' : 'false');
    };
    sync();
    btn.addEventListener('click', () => {
      state.threadView = !state.threadView;
      try { localStorage.setItem('mb-thread-view', state.threadView ? '1' : '0'); } catch (_) {}
      sync();
      loadEmails();
    });
  })();

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
    // `#/inbox?reply=1` — deep-link from the command palette ("what needs a reply").
    if (hash.match(/[?&]reply=1/)) {
      state.onlyReply = true;
      renderChips();
    }
  })();

  // `#/inbox?smart=<id>` deep-link is handled after smart folders load (see below).

  // Render a compose-from-scratch pane in #read-pane. Used by both the
  // sidebar "Nouveau message" CTA and the 'c' keyboard shortcut. The
  // pane has the same composer skeleton as renderEmail, minus the email
  // body / thread metadata. Sending or closing returns to renderEmpty().
  function renderComposeNew(opts = {}) {
    const pane = host.querySelector('#read-pane');
    if (!pane) return;
    // Drop any per-email selection so the back-out path lands cleanly.
    if (!opts.draft) state.selectedId = null;
    setSelectionMode(true);
    if (!opts.draft) {
      host.querySelector('.mb-card.selected')?.classList.remove('selected');
    }
    const defaultAccount = (opts.draft?.account_email)
      || state.accounts[0]?.email
      || '';
    const initialTo      = opts.draft?.to || '';
    const initialSubject = opts.draft?.subject || '';
    const initialBody    = opts.draft?.body_text || '';
    // The draft id starts known when re-opening from /api/drafts; for
    // a fresh compose we mint it on the first save (POST → returns
    // id) and PATCH every subsequent autosave.
    let draftId = opts.draft?.id ?? null;
    let lastSnapshot = JSON.stringify({
      from: defaultAccount, to: initialTo, subject: initialSubject, body: initialBody,
    });

    pane.innerHTML = `
      <div class="mb-read-inner mb-read-inner-compose">
        <div class="mb-read-head">
          <h1 class="mb-compose-title">
            <i data-lucide="mail-plus" class="w-5 h-5"></i>
            <span>${opts.draft ? t('mb.draft.title') : t('mb.compose')}</span>
          </h1>
          <div class="mb-read-actions">
            ${opts.draft ? `<button class="icon-btn" id="btn-delete-draft" title="${t('mb.draft.delete_title')}"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
            <button class="icon-btn" id="btn-close-compose" title="${t('mb.close')}"><i data-lucide="x" class="w-4 h-4"></i></button>
          </div>
        </div>
        <div class="mb-read-body">
          <div class="mb-read-content"></div>
          <div class="mb-composer mb-composer-standalone" id="mb-composer">
            ${buildComposerMetaHtml({
              mode: 'compose',
              accounts: state.accounts,
              defaultAccount,
              to: initialTo,
              subject: initialSubject,
            })}
            <textarea placeholder="${t('mb.composer.placeholder')}" aria-label="${t('mb.composer.aria')}">${escapeHtml(initialBody)}</textarea>
            <div class="mb-attach-strip" id="mb-attach-strip-new" data-empty="1"></div>
            <input type="file" id="mb-file-input-new" multiple style="display:none">
            <input type="file" id="mb-image-input-new" accept="image/*" multiple style="display:none">
            <div class="mb-composer-bar">
              <div style="display:flex;gap:4px;color:var(--muted)">
                <button class="icon-btn" id="btn-attach-file-new" title="${t('mb.composer.attach_file')}" aria-label="${t('mb.composer.attach_file')}"><i data-lucide="paperclip" class="w-4 h-4"></i></button>
                <button class="icon-btn" id="btn-attach-image-new" title="${t('mb.composer.attach_image')}" aria-label="${t('mb.composer.attach_image')}"><i data-lucide="image" class="w-4 h-4"></i></button>
              </div>
              <div style="display:flex;gap:8px;align-items:center;margin-left:auto">
                <span class="mb-compose-savetag" id="mb-compose-savetag" aria-live="polite"></span>
                <button class="send" id="btn-compose-send-new">
                  <i data-lucide="send" class="w-4 h-4"></i>
                  ${t('mb.send')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    pane.querySelectorAll('[data-toast]').forEach((el) => {
      el.addEventListener('click', (e) => { e.preventDefault(); window.toast(el.dataset.toast); });
    });

    bindComposerFromDropdown(pane);

    // Phase 4 — staged attachments for compose-new (same shape as the
    // reply variant; scoped to this pane via local closure).
    const stagedAttachmentsNew = [];

    function renderAttachStripNew() {
      const strip = pane.querySelector('#mb-attach-strip-new');
      if (!strip) return;
      strip.dataset.empty = stagedAttachmentsNew.length ? '0' : '1';
      strip.innerHTML = stagedAttachmentsNew.map((a, i) => `
        <span class="mb-attach-pill" data-idx="${i}">
          <i data-lucide="${a.kind === 'inline' ? 'image' : 'paperclip'}" class="w-3 h-3"></i>
          <span class="mb-attach-name" title="${escapeHtml(a.filename)}">${escapeHtml(a.filename)}</span>
          <span class="mb-attach-size">${fmtBytes(a.size)}</span>
          <button type="button" class="mb-attach-remove" data-idx="${i}" title="${t('mb.att.remove')}" aria-label="${t('mb.att.remove')}">
            <i data-lucide="x" class="w-3 h-3"></i>
          </button>
        </span>
      `).join('');
      window.lucide?.createIcons({ el: strip });
      strip.querySelectorAll('.mb-attach-remove').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const idx = parseInt(btn.dataset.idx, 10);
          const removed = stagedAttachmentsNew.splice(idx, 1)[0];
          renderAttachStripNew();
          if (removed?.upload_id) {
            try { await api.deleteUpload(removed.upload_id); } catch (_) {}
          }
        });
      });
    }

    async function handleFilePickNew(files, kind) {
      if (!files || !files.length) return;
      for (const file of files) {
        const tmp = { upload_id: null, filename: file.name, size: file.size, content_type: file.type, kind, uploading: true };
        stagedAttachmentsNew.push(tmp);
        renderAttachStripNew();
        try {
          const meta = await api.uploadAttachment(file);
          tmp.upload_id = meta.upload_id;
          tmp.filename = meta.filename;
          tmp.size = meta.size;
          tmp.content_type = meta.content_type;
          tmp.uploading = false;
          renderAttachStripNew();
        } catch (err) {
          const idx = stagedAttachmentsNew.indexOf(tmp);
          if (idx >= 0) stagedAttachmentsNew.splice(idx, 1);
          renderAttachStripNew();
          window.toast(err?.message || t('mb.toast.upload_fail'), 5000);
        }
      }
    }

    pane.querySelector('#btn-attach-file-new')?.addEventListener('click', () => pane.querySelector('#mb-file-input-new')?.click());
    pane.querySelector('#btn-attach-image-new')?.addEventListener('click', () => pane.querySelector('#mb-image-input-new')?.click());
    pane.querySelector('#mb-file-input-new')?.addEventListener('change', (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      handleFilePickNew(files, 'attachment');
    });
    pane.querySelector('#mb-image-input-new')?.addEventListener('change', (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = '';
      handleFilePickNew(files, 'inline');
    });

    const tagEl = pane.querySelector('#mb-compose-savetag');
    let saveTimer = null;
    let savePromise = null;
    let pendingDelete = false;  // set when user clicks the trash; aborts the next autosave
    const collect = () => ({
      from_account: (pane.querySelector('#mbc-from')?.value || '').trim(),
      to:       (pane.querySelector('#mbc-to')?.value || '').trim(),
      subject:  (pane.querySelector('#mbc-subject')?.value || '').trim(),
      body_text:(pane.querySelector('textarea')?.value || ''),
    });
    const flagSaving = (txt) => { if (tagEl) tagEl.textContent = txt; };

    // Persist now. Returns a promise resolving to the (possibly new)
    // draft id, or null when the form is empty (we don't materialise
    // an empty row).
    async function saveNow() {
      if (pendingDelete) return null;
      const v = collect();
      const isEmpty = !v.to && !v.subject && !v.body_text.trim();
      const snap = JSON.stringify({ from: v.from_account, to: v.to, subject: v.subject, body: v.body_text });
      if (snap === lastSnapshot) return draftId;
      if (isEmpty && !draftId) return null;
      flagSaving(t('mb.draft.saving'));
      try {
        if (draftId == null) {
          const created = await api.createDraft(v);
          draftId = created?.id ?? null;
        } else {
          await api.updateDraft(draftId, v);
        }
        lastSnapshot = snap;
        flagSaving(t('mb.draft.saved'));
        // Brief auto-clear so the tag doesn't permanently squat the bar.
        setTimeout(() => { if (tagEl && tagEl.textContent === t('mb.draft.saved')) tagEl.textContent = ''; }, 2000);
      } catch (err) {
        flagSaving(t('mb.draft.save_fail'));
      }
      return draftId;
    }

    function scheduleSave() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        savePromise = saveNow();
      }, 1500);  // 1.5s of inactivity before persisting
    }

    // Wire keystrokes on every editable field. The To/Subject/From
    // controls are the inputs inside the meta strip + the textarea +
    // the hidden #mbc-from updated by the custom dropdown.
    ['#mbc-to', '#mbc-subject', '#mbc-from'].forEach((sel) => {
      pane.querySelector(sel)?.addEventListener('input',  scheduleSave);
      pane.querySelector(sel)?.addEventListener('change', scheduleSave);
    });
    pane.querySelector('textarea')?.addEventListener('input', scheduleSave);

    pane.querySelector('#btn-delete-draft')?.addEventListener('click', async () => {
      if (draftId == null) { renderEmpty(); return; }
      if (!confirm(t('mb.draft.confirm.delete_draft'))) return;
      pendingDelete = true;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      try {
        await api.deleteDraft(draftId);
        window.toast(t('mb.toast.draft_deleted'));
        renderEmpty();
        if (state.folder === 'draft') loadEmails();
      } catch (err) {
        pendingDelete = false;
        window.toast(t('mb.toast.fail_delete') + ': ' + (err.message || ''));
      }
    });

    pane.querySelector('#btn-close-compose')?.addEventListener('click', async () => {
      // Confirm close if the user typed something
      const ta = pane.querySelector('textarea');
      if (ta && ta.value.trim().length > 0 && !draftId) {
        if (!window.confirm(t('mb.composer.confirm_discard'))) return;
      }
      // Flush any pending edit before closing so the user doesn't lose
      // a draft they typed during the last 1.5s.
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      try { await saveNow(); } catch (_) {}
      renderEmpty();
      if (state.folder === 'draft') loadEmails();
    });

    pane.querySelector('#btn-compose-send-new')?.addEventListener('click', async (e) => {
      const v = collect();
      if (!v.from_account) { window.toast(t('mb.toast.from_required')); return; }
      if (!v.to)   { window.toast(t('mb.toast.to_required')); return; }
      if (!v.body_text.trim()) { window.toast(t('mb.toast.body_empty')); return; }
      if (stagedAttachmentsNew.some((a) => a.uploading)) {
        window.toast(t('mb.toast.uploading')); return;
      }
      const toList = v.to.split(',').map((s) => s.trim()).filter(Boolean);
      const attachIds = stagedAttachmentsNew.filter((a) => a.kind === 'attachment' && a.upload_id).map((a) => a.upload_id);
      const inlineIds = stagedAttachmentsNew.filter((a) => a.kind === 'inline'     && a.upload_id).map((a) => a.upload_id);
      const setSending = sendButtonStateFactory(e.currentTarget, t('mb.send'));
      // Cancel pending autosave — the message is about to leave anyway.
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      setSending('loading');
      try {
        await api.sendEmail({
          from_account: v.from_account,
          to: toList,
          subject: v.subject,
          body_text: v.body_text.trim(),
          attachments: attachIds,
          inline_images: inlineIds,
        });
        setSending('sent');
        window.toast(t('mb.toast.sent'));
        // Drop the on-disk draft (if any) — the message has been sent
        // and a stale draft would re-appear in Brouillons next visit.
        if (draftId != null) {
          pendingDelete = true;
          api.deleteDraft(draftId).catch(() => {});
        }
        stagedAttachmentsNew.length = 0;
        await new Promise((r) => setTimeout(r, 1500));
        renderEmpty();
        if (state.folder === 'draft') loadEmails();
      } catch (err) {
        setSending('idle');
        const msg = (err && err.message) || t('mb.toast.send_fail');
        window.toast(msg, 6000);
      }
    });

    // Focus the To field so typing starts the destination address —
    // unless we're re-opening an existing draft, in which case put the
    // cursor at the end of the body for quick continuation.
    setTimeout(() => {
      if (opts.draft && initialBody) {
        const ta = pane.querySelector('textarea');
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      } else {
        pane.querySelector('#mbc-to')?.focus();
      }
    }, 0);
    window.lucide?.createIcons();
  }

  $('#cta-compose').addEventListener('click', () => renderComposeNew());

  // ── Keyboard ──────────────────────────────────────────────
  function onKey(e) {
    const k = e.detail.key;
    const sel = state.selectedId;
    if (k === 'j') moveSelection(1);
    else if (k === 'k') moveSelection(-1);
    else if (k === 'Enter' && sel == null && state.filteredIds.length) openEmail(state.filteredIds[0]);
    else if (k === 'e' && sel != null) {
      api.patchEmail(sel, { is_read: true }).catch(() => {});
      const c = host.querySelector(`.mb-card[data-id="${sel}"]`);
      if (c) c.classList.remove('unread');
    }
    // Gmail-like shortcuts (only when no input is focused)
    else if (k === 'r' && sel != null) $('#btn-reply-toggle')?.click();
    else if (k === 'f' && sel != null) $('#btn-forward')?.click();
    else if (k === '#' && sel != null) {
      const cur = state.folder || 'inbox';
      let target = cur === 'deleted' ? 'inbox' : 'deleted';
      if (state.selectedIds.size > 1) { bulkSetTarget(target); } else { bulkSetTarget(target); }
    }
    else if (k === 's' && sel != null) $('#btn-fav-toggle')?.click();
    else if (k === 'u') { triggerSync().catch(() => {}); }
    else if (k === 'c') $('#cta-compose')?.click();
    else if (k === 'm' && sel != null) {
      const cur = state.folder || 'inbox';
      if (cur === 'deleted') return;
      bulkSetTarget('archived');
    }
    else if (k === 'v' && sel != null) openMovePopover($(`.mb-card[data-id="${sel}"]`) || undefined);
    else if (k === '*') selectAll();
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

  // Auto-refresh every 60s — was 20s but on a 750-mail / 14-account
  // session that hammered the DB and CPU for no UX win. The Sync button
  // is one click away if the user wants something newer.
  //
  // Mid-interaction guard: a popover open or a multi-selection live
  // means a background refresh that rebuilds the list would close the
  // popover and may evict the checked rows from the visible window —
  // both feel broken. Skip this tick; the next 60s tick will catch up.
  function _userIsBusy() {
    if (_popCleanup) return true;
    if (state.selectedIds && state.selectedIds.size) return true;
    return false;
  }

  function _backgroundRefresh() {
    if (_userIsBusy()) return;
    loadEmails({ background: true }).catch(() => {});
    loadAccounts().catch(() => {});
  }

  const refreshTimer = setInterval(_backgroundRefresh, 60_000);

  // Refresh when the user comes back to the tab, but debounce: a quick
  // tab-switch must not trigger a second reload on top of the periodic
  // refresh that just fired.
  const onVisibility = () => {
    if (document.hidden) return;
    if (Date.now() - _lastLoadAt < 10_000) return;
    _backgroundRefresh();
  };
  document.addEventListener('visibilitychange', onVisibility);

  // ── Initial render ────────────────────────────────────────
  const _mountedAt = Date.now(); // used to synchronise accounts stagger with static stagger
  renderFolders();
  renderLabels();
  renderUserLabels();
  loadUserLabels();
  loadCustomFolders();
  renderChips();
  renderSortBtn();
  renderAccounts();
  renderEmpty();

  // "+" button next to the Dossiers section title — opens the
  // folder-create modal. event.stopPropagation on the parent <button>
  // markup prevents the section title from collapsing when clicking +.
  $('#btn-add-folder')?.addEventListener('click', () => openFolderModal(null));

  // "+" button next to the Étiquettes section title — opens the
  // create modal. event.stopPropagation in the markup keeps the
  // section from collapsing when the user just wants to add a
  // label.
  $('#btn-add-label')?.addEventListener('click', () => openLabelModal(null));

  // Collapsible sidebar sections — all open by default.
  // One-time migration: the old code force-set 'sb-folders' and 'sb-accounts'
  // to '1' (collapsed). Clear those stored values once so new sessions start open.
  if (!localStorage.getItem('sb-open-default-v1')) {
    localStorage.removeItem('sb-folders');
    localStorage.removeItem('sb-accounts');
    localStorage.setItem('sb-open-default-v1', '1');
  }
  initCollapsible($('#title-folders'),     $('#wrap-folders'),     'sb-folders');
  initCollapsible($('#title-labels'),      $('#wrap-labels'),      'sb-labels');
  // ÉTIQUETTES (personal labels) is rarely populated on first run and
  // adds noise to the sidebar when empty. Start it folded; once the
  // user opens it the choice is remembered.
  initCollapsible($('#title-userlabels'),  $('#wrap-userlabels'),  'sb-userlabels',
                  { defaultCollapsed: true });

  setupSidebarReorder();

  $('#btn-sync').addEventListener('click', triggerSync);
  $('#sel-bar').addEventListener('click', onSelBarClick);
  // Swipe-back gesture on the reading pane (mobile)
  let _swipeStartX = 0, _swipeStartY = 0;
  const readPane = $('#read-pane');
  if (readPane) {
    readPane.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      _swipeStartX = e.touches[0].clientX;
      _swipeStartY = e.touches[0].clientY;
    }, { passive: true });
    readPane.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - _swipeStartX;
      const dy = e.touches[0].clientY - _swipeStartY;
      // Only horizontal swipes, ignore vertical scrolling
      if (Math.abs(dx) > Math.abs(dy) * 1.5 && dx > 60) {
        e.preventDefault();
        host.querySelector('.mb-card.selected')?.classList.remove('selected');
        renderEmpty();
        _swipeStartX = 0;
      }
    }, { passive: false });
  }

  // Event delegation for card clicks (avoids per-card listeners).
  $('#email-list').addEventListener('click', (e) => {
    const card = e.target.closest('.mb-card');
    if (!card) return;
    const id = parseInt(card.dataset.id, 10);
    if (!Number.isFinite(id)) return;
    // Avatar click = toggle selection; body click = open.
    if (e.target.closest('.mb-avatar')) {
      e.stopPropagation();
      e.preventDefault();
      if (e.shiftKey && _lastCheckedId != null) rangeSelect(id);
      else toggleSelection(id);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      toggleSelection(id);
    } else if (e.shiftKey && _lastCheckedId != null) {
      e.preventDefault();
      rangeSelect(id);
    } else {
      openEmail(id);
    }
  });

  $('#sel-all-global').addEventListener('click', (e) => {
    e.stopPropagation();
    const total = state.filteredIds.length;
    const allSelected = total > 0 && state.filteredIds.every((id) => state.selectedIds.has(id));
    if (state.selectedIds.size > 0 && !allSelected) { clearSelection(); return; }
    if (allSelected) { clearSelection(); return; }
    selectAll();
  });

  // Materialise every static <i data-lucide> placeholder baked into
  // host.innerHTML (Sync button, Compose CTA, section "+" buttons,
  // collapse chevrons…) into real <svg> before the entrance cascade
  // begins. Without this the icons stay as zero-size <i> placeholders
  // during the fade-up and only pop in at the global createIcons()
  // call at the very end of mount — making icons look like they "load"
  // a beat after their labels.
  window.lucide?.createIcons();

  // Sidebar stagger animation.
  //
  // `.mb-stagger` is baked into the markup above so the CSS rule
  // (style.css → `.mb-stagger .mb-folder { opacity: 0; animation: … }`)
  // takes effect on the very first paint. Without that, children
  // briefly rendered at opacity:1 default before this JS ran, then the
  // class was added and flipped them back to opacity:0 — exactly the
  // "elements visible then animation kicks in" flash the user saw.
  //
  // We still wait for loadAccounts() (fast — ~50 ms) so the COMPTES
  // subtree exists when we stamp --i, giving every element its proper
  // cascade slot. loadEmails() is intentionally NOT awaited here — it
  // typically dominates the round-trip and gating the sidebar on it
  // produced a delayed entrance that lined up exactly with mail arrival
  // (the previous "re-fire" symptom). The email list has its own
  // fade-in via `.mb-list-wrap`.
  const _emailsLoading = loadEmails();
  await loadAccounts();

  const sidebar = host.querySelector('.mb-side');
  if (sidebar) {
    const els = sidebar.querySelectorAll(
      '.mb-side-head, .mb-cta, .mb-section-title, .mb-subsection-title, ' +
      '.mb-folder, .mb-label, .mb-userlabel-empty'
    );
    els.forEach((el, i) => el.style.setProperty('--i', i));
    // Drop .mb-stagger + --i once the cascade has finished, so subsequent
    // refreshes (loadAccounts() rebuild) don't re-trigger the entrance.
    const STEP = 28, BASE = 120, DUR = 260, SAFETY = 50;
    setTimeout(() => {
      sidebar.classList.remove('mb-stagger');
      els.forEach((el) => el.style.removeProperty('--i'));
    }, BASE + els.length * STEP + DUR + SAFETY);
  }

  // loadEmails() paints its own inline error on failure; just keep the
  // unhandled-rejection warning quiet.
  _emailsLoading.catch(() => {});

  pollSync();
  window.lucide?.createIcons();

  // Cleanup on unmount
  return () => {
    if (_sortDropCleanup) _sortDropCleanup();
    closePopover();
    _teardownListObserver();
    if (syncTimer) clearInterval(syncTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('app:key', onKey);
    document.removeEventListener('keydown', onEscape);
  };
}
