// Router + theme + global UI for Lull Mail.

import { mountMailbox } from '/static/mailbox.js';
import { mountDashboard } from '/static/dashboard.js';
import { mountCleanup } from '/static/cleanup.js';
import { mountSettings } from '/static/settings.js';

const view = document.getElementById('view');
let cleanup = null;

function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
}

// ── Routing ────────────────────────────────────────────────
function currentRoute() {
  const h = location.hash || '';
  if (h.startsWith('#/dashboard')) return 'dashboard';
  if (h.startsWith('#/cleanup')) return 'cleanup';
  if (h.startsWith('#/settings')) return 'settings';
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

async function render() {
  if (cleanup) {
    try { cleanup(); } catch (_) {}
    cleanup = null;
  }
  view.innerHTML = '';
  const route = currentRoute();
  setActiveRail(route);

  if (route === 'dashboard') {
    cleanup = await mountDashboard(view, { onRouteChange: navigate });
  } else if (route === 'cleanup') {
    cleanup = await mountCleanup(view, { onRouteChange: navigate });
  } else if (route === 'settings') {
    cleanup = await mountSettings(view, { onRouteChange: navigate });
  } else {
    cleanup = await mountMailbox(view, { onRouteChange: navigate });
  }
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
const toastEl = document.getElementById('toast');
let toastTimer = null;
window.toast = function toast(msg, ms = 1800) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
};

document.querySelectorAll('[data-toast]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    window.toast(el.dataset.toast);
  });
});

// ── Cheat sheet (?) ────────────────────────────────────────
const cheat = document.getElementById('cheat-overlay');
function openCheat() { cheat.classList.remove('hidden'); refreshIcons(); }
function closeCheat() { cheat.classList.add('hidden'); }
cheat.addEventListener('click', (e) => { if (e.target === cheat) closeCheat(); });
cheat.querySelector('.cheat-close').addEventListener('click', closeCheat);

// ── Global keyboard shortcuts ──────────────────────────────
let gPending = false;
let gTimer = null;

function isTypingTarget(t) {
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!cheat.classList.contains('hidden')) {
      closeCheat();
      e.preventDefault();
      return;
    }
  }

  if (isTypingTarget(e.target)) return;

  if (e.key === '?' || (e.shiftKey && e.key === '/')) {
    e.preventDefault();
    openCheat();
    return;
  }

  if (e.key === '/') {
    const search = document.querySelector('[data-role="search"]');
    if (search) {
      e.preventDefault();
      search.focus();
      search.select();
    }
    return;
  }

  if (e.key === 'g' && !gPending) {
    gPending = true;
    if (gTimer) clearTimeout(gTimer);
    gTimer = setTimeout(() => { gPending = false; }, 800);
    return;
  }
  if (gPending) {
    gPending = false;
    if (gTimer) clearTimeout(gTimer);
    if (e.key === 'i') { e.preventDefault(); navigate('#/inbox'); return; }
    if (e.key === 'd') { e.preventDefault(); navigate('#/dashboard'); return; }
    if (e.key === 'c') { e.preventDefault(); navigate('#/cleanup'); return; }
    if (e.key === 's') { e.preventDefault(); navigate('#/settings'); return; }
  }

  if (e.key === 'c') {
    e.preventDefault();
    window.toast('Composer : bientôt');
    return;
  }

  if (['j', 'k', 'Enter', 'e'].includes(e.key)) {
    window.dispatchEvent(new CustomEvent('app:key', { detail: { key: e.key } }));
  }
});

// ── Boot ───────────────────────────────────────────────────
if (!location.hash) location.hash = '#/inbox';
render();
refreshIcons();

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
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.setAttribute('role', 'status');
  banner.innerHTML = `
    <span>Lull Mail <strong>${info.latest_version}</strong> est disponible&nbsp;—&nbsp;votre version&nbsp;: ${info.current_version}</span>
    <button id="update-banner-install" title="Télécharger et installer la mise à jour">
      Installer
    </button>
    <button id="update-banner-dismiss" aria-label="Fermer">✕</button>
  `;
  document.body.prepend(banner);

  document.getElementById('update-banner-install').addEventListener('click', async () => {
    const btn = document.getElementById('update-banner-install');
    btn.disabled = true;
    btn.textContent = 'Téléchargement…';
    try {
      await fetch('/api/update/install', { method: 'POST' });
      btn.textContent = 'Installation en cours…';
      window.toast('Mise à jour en cours — l\'app va se fermer.', 5000);
    } catch (_) {
      btn.disabled = false;
      btn.textContent = 'Installer';
      window.toast('Erreur lors du lancement de la mise à jour.');
    }
  });

  document.getElementById('update-banner-dismiss').addEventListener('click', () => {
    banner.classList.add('hidden');
    try { sessionStorage.setItem('update-banner-dismissed', info.latest_version); } catch (_) {}
  });
}

checkForUpdate();
