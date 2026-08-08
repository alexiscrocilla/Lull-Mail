// SPDX-License-Identifier: GPL-3.0-or-later
// Router + theme + global UI for Lull Mail.

import { mountMailbox } from '/static/mailbox.js';
import { mountCleanup } from '/static/cleanup.js';
import { mountAI } from '/static/ai.js';
import { mountSettings } from '/static/settings.js';
import { initCommandPalette } from '/static/command-palette.js';

const view = document.getElementById('view');
let cleanup = null;

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

// ── Routing ────────────────────────────────────────────────
// The old '#/dashboard' route is gone — its only real job (watching the AI
// analysis queue) lives in the rail's queue indicator now. Unknown hashes,
// including stale dashboard bookmarks, normalise to the inbox.
const ROUTES = ['inbox', 'cleanup', 'ai', 'settings'];

function currentRoute() {
  const h = location.hash || '';
  // Match the route segment exactly: startsWith() accepted '#/dashboardXYZ'
  // as the dashboard, and any typo ('#/reglages') silently fell through to
  // the inbox while the address bar kept claiming otherwise.
  const seg = h.replace(/^#\/?/, '').split(/[?&/]/)[0];
  return ROUTES.includes(seg) ? seg : null;
}

// Unknown routes get normalised so the hash stops lying about where we are.
// replace(), not assign(), to avoid leaving the bad URL in history.
function resolveRoute() {
  const r = currentRoute();
  if (r) return r;
  const clean = '#/inbox';
  if (location.hash !== clean) location.replace(clean);
  return 'inbox';
}

function setActiveRail(route) {
  document.querySelectorAll('.rail-btn[data-route]').forEach((b) => {
    b.classList.toggle('active', b.dataset.route === route);
  });

  // Slide the indicator to the active button
  const activeBtn  = document.querySelector('.rail-btn.active[data-route]');
  const indicator  = document.getElementById('rail-indicator');
  const rail       = document.getElementById('rail');
  if (!activeBtn || !indicator || !rail) return;

  const railRect = rail.getBoundingClientRect();
  const btnRect  = activeBtn.getBoundingClientRect();
  const top = btnRect.top - railRect.top + (btnRect.height - 22) / 2;

  indicator.style.top     = top + 'px';
  indicator.style.opacity = '1';
}

let _renderGen = 0;

async function render() {
  // Generation guard: two navigations in quick succession both run render()
  // concurrently (each awaits an async mount). Without this token, a slow
  // mount A can resolve AFTER mount B and overwrite `cleanup` with A's
  // teardown — orphaning B's listeners/intervals so they never get removed
  // and pile up on the next mount. We stamp a generation, and any render
  // that finds itself superseded tears down its own view immediately.
  const gen = ++_renderGen;
  if (cleanup) {
    try { cleanup(); } catch (_) {}
    cleanup = null;
  }
  view.innerHTML = '';
  const route = resolveRoute();
  setActiveRail(route);

  let fn;
  if (route === 'cleanup') {
    fn = await mountCleanup(view, { onRouteChange: navigate });
  } else if (route === 'ai') {
    fn = await mountAI(view, { onRouteChange: navigate });
  } else if (route === 'settings') {
    fn = await mountSettings(view, { onRouteChange: navigate });
  } else {
    fn = await mountMailbox(view, { onRouteChange: navigate });
  }

  if (gen !== _renderGen) {
    // A newer render() already ran while we were mounting — this view is
    // stale. Tear it down now instead of stashing its cleanup (which the
    // newer render already cleared).
    try { fn?.(); } catch (_) {}
    return;
  }
  cleanup = fn;
  refreshIcons();
}

function navigate(target) {
  if (location.hash === target) {
    render();
  } else {
    location.hash = target;
  }
}

window.addEventListener('hashchange', render);

// ── Theme ──────────────────────────────────────────────────
const themeBtn = document.getElementById('theme-toggle');
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('theme', t); } catch (_) {}
  refreshIcons();
}
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});

// ── Toast ──────────────────────────────────────────────────
// Backwards-compatible facade over window.railToast. A string call still works
// as window.toast("msg", ms) — the message is auto-classified by keywords so
// existing call-sites get the right variant for free. New call-sites can
// pass a config object with { variant, message, progress, duration, ... }.
window.toast = function toast(arg, ms) {
  const rt = window.railToast;
  if (!rt) return null;
  if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
    return rt.show(arg);
  }
  const message = String(arg ?? '');
  const variant = rt.classifyMessage(message);
  // Heuristic durations per variant. The caller's explicit `ms` always wins
  // — including 0 for "persistent until explicit dismiss" (rare for string
  // calls; new code wanting a persistent loading should pass the object form).
  let duration;
  if (typeof ms === 'number') duration = ms;
  else if (variant === 'error')   duration = 4000;
  else if (variant === 'warning') duration = 2400;
  else if (variant === 'loading') duration = 2400;
  else                            duration = 1800;
  return rt.show({ variant, message, duration });
};

document.querySelectorAll('[data-toast]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    window.toast(el.dataset.toast);
  });
});

// ── Modal focus management ─────────────────────────────────
// The overlays used to only toggle `.hidden`: focus stayed on whatever opened
// them (a rail button, behind the overlay), Tab walked the whole page
// underneath, and closing left focus nowhere useful. This keeps focus inside
// the dialog while it is open and hands it back to the trigger on close.
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', 'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const _trapReturn = new WeakMap();

function trapFocus(dialog) {
  _trapReturn.set(dialog, document.activeElement);
  const onKeydown = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll(FOCUSABLE)]
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    // Wrap at both ends, and pull focus back in if it escaped somehow.
    if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  };
  dialog.addEventListener('keydown', onKeydown);
  dialog._untrap = () => dialog.removeEventListener('keydown', onKeydown);
  // Prefer the first control; fall back to the dialog itself.
  const target = dialog.querySelector(FOCUSABLE) || dialog;
  if (target === dialog && !dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
  requestAnimationFrame(() => target.focus());
}

function releaseFocus(dialog) {
  dialog._untrap?.();
  dialog._untrap = null;
  const back = _trapReturn.get(dialog);
  _trapReturn.delete(dialog);
  if (back && document.contains(back)) back.focus();
}

// ── Cheat sheet (?) ────────────────────────────────────────
const cheat = document.getElementById('cheat-overlay');
function openCheat() { cheat.classList.remove('hidden'); refreshIcons(); trapFocus(cheat); }
function closeCheat() { cheat.classList.add('hidden'); releaseFocus(cheat); }
cheat.addEventListener('click', (e) => { if (e.target === cheat) closeCheat(); });
cheat.querySelector('.cheat-close').addEventListener('click', closeCheat);
document.getElementById('cheat-toggle').addEventListener('click', openCheat);

// ── Bug / feedback report ──────────────────────────────────
// "Signaler un bug" lives below the keyboard shortcuts list. It opens a
// preview modal, fetches /api/diagnostics, and builds a GitHub issue URL
// that the user can open in a new tab — nothing leaves the machine until
// they click the final button.
const GITHUB_REPO = 'alexiscrocilla/Lull-Mail';
const reportOverlay = document.getElementById('report-overlay');
const reportTitle    = document.getElementById('report-title');
const reportWhat     = document.getElementById('report-what');
const reportExpected = document.getElementById('report-expected');
const reportSteps    = document.getElementById('report-steps');
const reportProblem  = document.getElementById('report-problem');
const reportSolution = document.getElementById('report-solution');
const reportFieldsBug  = document.getElementById('report-fields-bug');
const reportFieldsIdea = document.getElementById('report-fields-idea');
const reportInclude  = document.getElementById('report-include-diag');
const reportPreview  = document.getElementById('report-diag-preview');
const reportOpenGh   = document.getElementById('report-open-gh');
let reportDiagCache = null;

function reportFormatDiag(d) {
  const tt = window.t || ((k) => k);
  if (!d) return tt('diag.unavailable');
  const flavor = d.app?.frozen ? tt('diag.flavor.build') : tt('diag.flavor.dev');
  const accounts = tt('diag.accounts_active', {
    enabled: d.config?.accounts_enabled ?? 0,
    total:   d.config?.accounts_total   ?? 0,
  });
  const ai = d.config?.ai_enabled
    ? tt('diag.ai_on', { model: d.config.ai_model || tt('diag.value.unknown_model') })
    : tt('diag.value.no');
  const push = d.config?.has_ntfy ? tt('diag.value.yes') : tt('diag.value.no');
  const lastSync = (d.sync?.last_sync || '—')
    + (d.sync?.running ? ` (${tt('diag.value.sync_running')})` : '');
  const lines = [
    `${tt('diag.label.app')}        : ${d.app?.name || 'Lull Mail'} ${d.app?.version || '?'} (${flavor})`,
    `${tt('diag.label.os')}         : ${d.os?.platform || '?'}`,
    `${tt('diag.label.python')}     : ${d.python || '?'}`,
    `${tt('diag.label.accounts')}   : ${accounts}`,
    `${tt('diag.label.ai')}         : ${ai}`,
    `${tt('diag.label.push')} : ${push}`,
    `${tt('diag.label.last_sync')} : ${lastSync}`,
  ];
  if (d.log_tail && d.log_tail.trim()) {
    lines.push('', tt('diag.log_section'), d.log_tail.trim());
  }
  return lines.join('\n');
}

function reportSelectedKind() {
  const checked = document.querySelector('input[name="report-kind"]:checked');
  return checked ? checked.value : 'bug';
}

function reportBuildUrl() {
  const kind = reportSelectedKind();
  const template = kind === 'idea' ? 'feature_request.yml' : 'bug_report.yml';
  const titlePrefix = kind === 'idea' ? '[Idée] ' : '[Bug] ';
  const userTitle = (reportTitle?.value || '').trim();
  const includeDiag = !!reportInclude?.checked;

  const params = new URLSearchParams();
  params.set('template', template);
  if (userTitle) params.set('title', titlePrefix + userTitle);

  if (kind === 'bug') {
    const what     = (reportWhat?.value     || '').trim();
    const expected = (reportExpected?.value || '').trim();
    const steps    = (reportSteps?.value    || '').trim();
    if (reportDiagCache) {
      params.set('version', reportDiagCache.app?.version || '');
      params.set('windows', reportDiagCache.os?.platform || '');
    }
    if (what)     params.set('what-happened', what);
    if (expected) params.set('expected',      expected);
    if (steps)    params.set('steps',         steps);
    if (includeDiag && reportDiagCache?.log_tail) {
      params.set('logs', reportDiagCache.log_tail);
    }
  } else {
    const problem  = (reportProblem?.value  || '').trim();
    const solution = (reportSolution?.value || '').trim();
    if (problem)  params.set('problem',  problem);
    if (solution) params.set('solution', solution);
    if (includeDiag && reportDiagCache) {
      params.set('alternatives',
        '— Diagnostics ——\n' + reportFormatDiag(reportDiagCache));
    }
  }

  return `https://github.com/${GITHUB_REPO}/issues/new?${params.toString()}`;
}

function reportToggleKindFields() {
  const kind = reportSelectedKind();
  reportFieldsBug?.classList.toggle('hidden',  kind !== 'bug');
  reportFieldsIdea?.classList.toggle('hidden', kind !== 'idea');
}

function reportRefresh() {
  const tt = window.t || ((k) => k);
  if (reportPreview) {
    reportPreview.textContent = reportInclude?.checked
      ? reportFormatDiag(reportDiagCache)
      : tt('report.diag_off');
  }
  if (reportOpenGh) reportOpenGh.href = reportBuildUrl();
}

async function openReport() {
  reportOverlay.classList.remove('hidden');
  refreshIcons();
  trapFocus(reportOverlay);
  reportToggleKindFields();
  if (reportDiagCache === null) {
    if (reportPreview) reportPreview.textContent = (window.t || ((k) => k))('diag.loading');
    try {
      const r = await fetch('/api/diagnostics');
      reportDiagCache = r.ok ? await r.json() : null;
    } catch (_) {
      reportDiagCache = null;
    }
  }
  reportRefresh();
}
function closeReport() { reportOverlay.classList.add('hidden'); releaseFocus(reportOverlay); }

document.getElementById('report-toggle').addEventListener('click', openReport);
document.getElementById('report-close').addEventListener('click', closeReport);
document.getElementById('report-cancel').addEventListener('click', closeReport);
reportOverlay.addEventListener('click', (e) => {
  if (e.target === reportOverlay) closeReport();
});
[reportTitle, reportWhat, reportExpected, reportSteps, reportProblem, reportSolution]
  .forEach((el) => el?.addEventListener('input', reportRefresh));
reportInclude?.addEventListener('change', reportRefresh);
document.querySelectorAll('input[name="report-kind"]').forEach((el) => {
  el.addEventListener('change', () => { reportToggleKindFields(); reportRefresh(); });
});

// ── Brand-logo fallback ────────────────────────────────────
// Sender-domain logos (<img class="av-img">) 404 when the backend has no
// favicon for that domain. `error` doesn't bubble, so we catch it in the
// capture phase globally and drop the broken image — the coloured initials
// bubble rendered underneath then shows through. One listener covers every
// avatar in the list, the read pane and dialogs, present and future.
document.addEventListener('error', (e) => {
  const el = e.target;
  if (el && el.tagName === 'IMG' && el.classList && el.classList.contains('av-img')) {
    el.remove();
  }
}, true);

// ── Global keyboard shortcuts ──────────────────────────────
function isTypingTarget(t) {
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!reportOverlay.classList.contains('hidden')) {
      closeReport();
      e.preventDefault();
      return;
    }
    if (!cheat.classList.contains('hidden')) {
      closeCheat();
      e.preventDefault();
      return;
    }
  }

  // Command palette (Cmd/Ctrl-K) — works even while typing in a field.
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    window.commandPalette?.open();
    return;
  }

  if (isTypingTarget(e.target)) return;

  // Global shortcuts (toutes pages)
  if (e.key === '?' || (e.shiftKey && e.key === '/')) {
    e.preventDefault();
    openCheat();
    return;
  }

  // Raccourcis réservés à l'inbox
  if (currentRoute() !== 'inbox') return;

  if (e.key === '/') {
    const search = document.querySelector('[data-role="search"]');
    if (search) {
      e.preventDefault();
      search.focus();
      search.select();
    }
    return;
  }

  if (['j', 'k', 'Enter', 'e'].includes(e.key)) {
    window.dispatchEvent(new CustomEvent('app:key', { detail: { key: e.key } }));
  }
});

// ── AI mode global ─────────────────────────────────────────
// Every view (mailbox, dashboard) reads `window.aiEnabled` to decide
// whether to render AI affordances (score badges, summaries, draft
// buttons, cost KPI). We probe /api/setup/status once at boot and
// re-probe whenever the Settings page broadcasts a change.
//
// Read `ai_enabled` (provider-agnostic) instead of `has_openai`. The
// backend's `cfg.ai_enabled()` returns true both for OpenAI (clé non
// vide) and for the local provider (analyzer GGUF present on disk).
// Before this fix the UI was hiding all AI features in local mode
// because `has_openai` was always false.
async function refreshAiFlag() {
  try {
    // Bound the probe: a hung backend must not stall the first render()
    // (which awaits this at boot) and leave a blank screen forever.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let r;
    try {
      r = await fetch('/api/setup/status', { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) return;
    const s = await r.json();
    // Backwards compat : older builds expose only `has_openai`.
    window.aiEnabled = (s.ai_enabled !== undefined)
      ? !!s.ai_enabled
      : !!s.has_openai;
  } catch (_) {
    // Network hiccup at boot — default to off so the no-AI UI renders;
    // a successful future probe will flip it back on.
    window.aiEnabled = false;
  }
}
window.addEventListener('ai-config-changed', async () => {
  await refreshAiFlag();
  syncAiRailButton();
  // Re-render so AI-conditional UI updates without a hard reload — but NOT
  // when the user is sitting in Settings, which is where the event comes from.
  // Saving an API key re-mounted the very page being edited: scrolled back to
  // the top, other sections' inputs cleared, and the previous instance's
  // loadAll() left running against detached DOM.
  if (currentRoute() !== 'settings') render();
});

// ── AI-queue rail indicator ────────────────────────────────
// Replaces the dashboard page. Rides the 3 s /api/sync/status poll that
// rail-toast.js already runs (re-broadcast as a 'sync-status' event): the
// ring spins while a sync/analysis pass runs, the badge shows how many
// mails still wait for analysis, a click launches a pass.
const queueInd = document.getElementById('queue-ind');
window.addEventListener('sync-status', (e) => {
  if (!queueInd) return;
  const s = e.detail || {};
  queueInd.classList.toggle('busy', !!s.running);
  const badge = document.getElementById('queue-ind-badge');
  if (badge) {
    const n = s.queue_pending | 0;
    badge.hidden = n <= 0;
    badge.textContent = n > 99 ? '99+' : String(n);
  }
});
queueInd?.addEventListener('click', async () => {
  try {
    await fetch('/api/sync', { method: 'POST' });
    // Force an immediate poll so the ring reacts to the click without
    // waiting out the 3 s interval.
    window.railToast?.checkAiBusy?.();
  } catch (_) { /* backend down — the poll will say so soon enough */ }
});

// ── Command palette rail button ────────────────────────────
// Mouse-first entry to the Cmd/Ctrl-K palette. The palette carries non-AI
// commands too (navigation, sync, theme), so it shows regardless of the AI
// flag — unlike the AI page entry below.
document.getElementById('palette-toggle')
  ?.addEventListener('click', () => window.commandPalette?.open());

// ── AI workspace rail entry ────────────────────────────────
// Navigates to the AI page (#/ai) — a processing cockpit over what the AI
// already computed, not a chat window. Cmd/Ctrl-K still opens the quick
// palette for one-off commands. Hidden while AI is unconfigured: the page
// would have nothing to show.
const aiToggle = document.getElementById('ai-toggle');
function syncAiRailButton() {
  if (aiToggle) aiToggle.hidden = !window.aiEnabled;
  // The AI-queue indicator is meaningless without an AI backend.
  if (queueInd) queueInd.hidden = !window.aiEnabled;
  // The rail indicator only tracks visible route buttons; when AI is off and
  // the hash still points at #/ai, send the user somewhere real.
  if (!window.aiEnabled && currentRoute() === 'ai') navigate('#/inbox');
}

// ── Boot ───────────────────────────────────────────────────
if (!location.hash) location.hash = '#/inbox';
// Resolve the AI flag before the first render so the initial paint is
// already correct. Awaiting here is fine — /api/setup/status is local,
// served by the same process.
await refreshAiFlag();
syncAiRailButton();
render();
refreshIcons();
initCommandPalette({ navigate });

// ── Auto-update banner ─────────────────────────────────────
async function checkForUpdate() {
  // Skip if the user already dismissed the banner for this version in this session.
  let dismissedVersion = null;
  try { dismissedVersion = sessionStorage.getItem('update-banner-dismissed'); } catch (_) {}

  let info;
  try {
    const r = await fetch('/api/update/check');
    if (!r.ok) return;
    info = await r.json();
  } catch (_) {
    return;
  }

  if (!info.available) return;
  if (dismissedVersion === info.latest_version) return;

  // Build the banner element.
  const tt = window.t || ((k) => k);
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.setAttribute('role', 'status');
  banner.innerHTML = `
    <span>${tt('update.banner.text_html', {
      latest:  info.latest_version,
      current: info.current_version,
    })}</span>
    <button id="update-banner-install" title="${tt('update.banner.install_title')}">
      ${tt('update.banner.install')}
    </button>
    <button id="update-banner-dismiss" aria-label="${tt('update.banner.dismiss')}">✕</button>
  `;
  document.body.prepend(banner);

  document.getElementById('update-banner-install').addEventListener('click', async () => {
    const btn = document.getElementById('update-banner-install');
    btn.disabled = true;
    btn.textContent = tt('update.banner.downloading');
    try {
      await fetch('/api/update/install', { method: 'POST' });
      btn.textContent = tt('update.banner.installing');
      window.toast(tt('update.toast.starting'), 5000);
    } catch (_) {
      btn.disabled = false;
      btn.textContent = tt('update.banner.install');
      window.toast(tt('update.toast.failed'));
    }
  });

  document.getElementById('update-banner-dismiss').addEventListener('click', () => {
    banner.classList.add('hidden');
    try { sessionStorage.setItem('update-banner-dismissed', info.latest_version); } catch (_) {}
  });
}

checkForUpdate();
