// SPDX-License-Identifier: GPL-3.0-or-later
// RailToast — single-slot circular notification hosted in the rail's bottom
// slot (see #rail-toast-host in index.html), with a placeholder cercle
// shown when no toast is active. Falls back to a detached, centered-bottom
// host for pages without a rail (onboarding).
//
// Public API (via window.railToast):
//   const t = railToast.show({
//     variant: 'success' | 'error' | 'warning' | 'info' | 'loading',
//     message: 'Texte',
//     progress: null,            // 0..100 for determinate ring, null for spin
//     duration: 1800,            // ms before auto-dismiss; 0 = persistent
//     collapseAfter: 1500,       // ms before pill morphs to circle (0 = never)
//     detached: false,           // true => centered bottom (onboarding)
//     icon: null,                // override Lucide icon name
//   });
//   t.update({ message, variant, progress });
//   t.success(msg?), t.error(msg?), t.warning(msg?), t.info(msg?);
//   t.dismiss();
//
// Single-slot semantics: calling show() while another toast is alive
// dismisses the current one immediately and replaces it.

// Icon names per variant. The disc is already a circle, so we avoid
// icons that contain their own circular frame (alert-circle, info-
// circle…) — they produced a "circle in a circle" look. The chosen
// set keeps the geometry simple:
//   success → check          (two clean strokes)
//   error   → x              (two strokes, mirrors success symmetry)
//   warning → triangle-alert (distinct triangle, doesn't fight disc)
//   info    → info           (lucide has no non-circular info icon;
//                             the inner ring still reads at 18px)
//   loading → null           (replaced by the spinner pseudo-element)
const VARIANT_ICONS = {
  success: 'check',
  error:   'x',
  warning: 'triangle-alert',
  info:    'info',
  loading: null,
};

const HOST_ID = 'rail-toast-host';

function ensureHost() {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('role', 'status');
    document.body.appendChild(host);
  }
  // One-time wiring for the idle loader: start on hover, stop after the
  // current loop finishes when hover ends (no mid-cycle pause).
  if (!host.dataset.rtIdleWired) {
    host.dataset.rtIdleWired = '1';
    let stopping = false;

    const getLoader = () => host.querySelector('.rt-placeholder .loader');

    host.addEventListener('mouseenter', () => {
      if (host.classList.contains('rt-host-active')) return; // toast overlays placeholder
      stopping = false;
      host.classList.add('rt-idle-running');
    });

    host.addEventListener('mouseleave', () => {
      if (!host.classList.contains('rt-idle-running')) return;
      // Don't pause immediately: request stop at next iteration boundary.
      stopping = true;
    });

    // Animation events fire on the element that carries the animation.
    host.addEventListener('animationiteration', (e) => {
      if (!stopping) return;
      const loader = getLoader();
      if (loader && e.target === loader) {
        host.classList.remove('rt-idle-running');
        // Hard-reset to the exact start frame so there's no residual Y-rotation
        // (some browsers can pause a fraction into the next cycle).
        loader.style.animation = 'none';
        // Force reflow.
        void loader.offsetHeight;
        loader.style.animation = '';
        stopping = false;
      }
    });
  }
  return host;
}

function classifyMessage(msg) {
  const s = String(msg || '');
  if (/Échec|Erreur|Impossible|KO|Échoué|Failed|failed/i.test(s)) return 'error';
  if (/requis|vide|déjà|Patientez|Veuillez|invalide/i.test(s))    return 'warning';
  if (/…|en cours|Lancement|lancée?/i.test(s))                    return 'loading';
  if (/(envoyé|créée?|supprimée?|ajoutée?|terminée?|mise? à jour|enregistrée?|appliquée?|étiqueté|restaurée?|marqué|retiré|effectué|ouverte?|déplacée?|désabonn|reçu|copié|sauvegardé)\b/i.test(s)) return 'success';
  return 'info';
}

function createRailToast() {
  let current = null;

  function destroy(node, fast = false) {
    if (!node || !node.parentNode) return;
    const host = node.parentNode;
    const onGone = () => {
      node.remove();
      // Reveal the placeholder again only if no other toast was inserted
      // since (e.g. show() called destroy(fast=true) then appended a new node).
      if (host && !host.querySelector('.rt')) host.classList.remove('rt-host-active');
    };
    if (fast) { onGone(); return; }
    node.classList.add('rt-leaving');
    node.addEventListener('animationend', onGone, { once: true });
    setTimeout(onGone, 260);
  }

  function buildIconHtml(variant, iconOverride) {
    const name = iconOverride || VARIANT_ICONS[variant];
    if (!name) return '';
    return `<i data-lucide="${name}" class="w-4 h-4"></i>`;
  }

  function applyVariant(node, variant) {
    node.dataset.variant = variant;
    const isErr = variant === 'error';
    node.setAttribute('aria-live', isErr ? 'assertive' : 'polite');
    if (isErr) node.setAttribute('role', 'alert');
    else       node.setAttribute('role', 'status');
  }

  function applyProgress(node, progress) {
    if (progress == null) {
      node.classList.remove('rt-determinate');
      node.style.removeProperty('--rt-progress');
    } else {
      const p = Math.max(0, Math.min(100, Number(progress) || 0));
      node.classList.add('rt-determinate');
      node.style.setProperty('--rt-progress', String(p));
    }
  }

  function refreshIcons(node) {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      try { window.lucide.createIcons({ nameAttr: 'data-lucide', icons: undefined }); }
      catch (_) {
        try { window.lucide.createIcons(); } catch (_) {}
      }
    }
    void node;
  }

  function show(opts = {}) {
    if (typeof opts === 'string') opts = { message: opts };
    const {
      variant = 'info',
      message = '',
      progress = null,
      duration = 1800,
      collapseAfter = 1500,
      detached = false,
      icon = null,
    } = opts;

    if (current) destroy(current.node, true);

    const host = ensureHost();
    host.classList.toggle('rt-host-detached', !!detached);
    host.classList.add('rt-host-active');
    const node = document.createElement('div');
    node.className = 'rt rt-emerging';
    if (detached) node.classList.add('rt-detached');
    applyVariant(node, variant);
    applyProgress(node, variant === 'loading' ? progress : null);

    // The `.rt-pacman` element is injected only inside loading toasts.
    // It carries the determinate-progress animation (a Pac-Man eating
    // dots that fly in from the right). CSS gates its visibility so
    // it only shows when both `loading` and `.rt-determinate` are set
    // — otherwise the regular comet-trail spinner from .rt-icon::before
    // remains visible.
    const innerLoader = (variant === 'loading')
      ? '<span class="rt-pacman" aria-hidden="true"></span>'
      : '';
    node.innerHTML = `
      <span class="rt-ring" aria-hidden="true"></span>
      <span class="rt-icon">${buildIconHtml(variant, icon)}${innerLoader}</span>
      <span class="rt-text"></span>
    `;
    node.querySelector('.rt-text').textContent = message;
    host.appendChild(node);
    refreshIcons(node);

    // Trigger the morph: with the toast mounted in .rt-emerging (same
    // 36x36 footprint as the placeholder), removing the class on the
    // next paint kicks the CSS transitions on max-width / padding /
    // border-color so it grows rightward into the pill. Two rAFs so
    // the browser commits the initial computed style before the
    // transition target — Chromium sometimes collapses both into a
    // single layout pass and the morph never plays.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        node.classList.remove('rt-emerging');
      });
    });

    const state = {
      node,
      variant,
      message,
      progress,
      duration,
      collapseAfter: detached ? 0 : collapseAfter,
      detached,
      icon,
      collapseTimer: null,
      dismissTimer: null,
      hover: false,
      destroyed: false,
    };

    function startTimers() {
      clearTimers();
      if (state.collapseAfter > 0) {
        state.collapseTimer = setTimeout(() => {
          if (!state.destroyed && !state.hover) node.classList.add('rt-collapsed');
        }, state.collapseAfter);
      }
      if (state.duration > 0) {
        state.dismissTimer = setTimeout(() => {
          if (!state.destroyed && !state.hover) handle.dismiss();
        }, state.duration);
      }
    }

    function clearTimers() {
      if (state.collapseTimer) { clearTimeout(state.collapseTimer); state.collapseTimer = null; }
      if (state.dismissTimer)  { clearTimeout(state.dismissTimer);  state.dismissTimer  = null; }
    }

    node.addEventListener('mouseenter', () => {
      state.hover = true;
      node.classList.remove('rt-collapsed');
      clearTimers();
    });
    node.addEventListener('mouseleave', () => {
      state.hover = false;
      startTimers();
    });

    const handle = {
      get node() { return state.node; },
      get destroyed() { return state.destroyed; },
      update(patch = {}) {
        if (state.destroyed) return handle;
        if (patch.variant && patch.variant !== state.variant) {
          state.variant = patch.variant;
          applyVariant(node, state.variant);
          const iconHtml = buildIconHtml(state.variant, patch.icon ?? state.icon);
          node.querySelector('.rt-icon').innerHTML = iconHtml;
          refreshIcons(node);
        }
        if (typeof patch.message === 'string') {
          state.message = patch.message;
          node.querySelector('.rt-text').textContent = patch.message;
        }
        if ('progress' in patch) {
          state.progress = patch.progress;
          applyProgress(node, state.variant === 'loading' ? patch.progress : null);
        }
        if (typeof patch.duration === 'number') {
          state.duration = patch.duration;
        }
        if (typeof patch.collapseAfter === 'number') {
          state.collapseAfter = state.detached ? 0 : patch.collapseAfter;
        }
        // A meaningful update should re-show the pill so the user sees the change.
        node.classList.remove('rt-collapsed');
        startTimers();
        return handle;
      },
      success(msg) {
        return handle.update({
          variant: 'success',
          message: msg ?? state.message,
          progress: null,
          duration: 1800,
        });
      },
      error(msg) {
        return handle.update({
          variant: 'error',
          message: msg ?? state.message,
          progress: null,
          duration: 4000,
        });
      },
      warning(msg) {
        return handle.update({
          variant: 'warning',
          message: msg ?? state.message,
          progress: null,
          duration: 2400,
        });
      },
      info(msg) {
        return handle.update({
          variant: 'info',
          message: msg ?? state.message,
          progress: null,
          duration: 1800,
        });
      },
      dismiss() {
        if (state.destroyed) return;
        state.destroyed = true;
        clearTimers();
        if (current && current.node === node) current = null;
        destroy(node, false);
      },
    };

    current = { node, handle };
    startTimers();
    return handle;
  }

  function dismiss() {
    if (current) current.handle.dismiss();
  }

  return { show, dismiss, classifyMessage };
}

const railToast = createRailToast();

// ── AI-busy indicator ────────────────────────────────────────────────────
// Affiche un toast persistant `variant: 'loading'` dans le rail tant que
// l'IA travaille. On préfère le spinner du toast (.rt > .rt-icon) à la
// pièce coin-flip du placeholder parce qu'il est plus lisible : forme
// d'attente standard, message texte visible au hover.
//
// Deux sources alimentent l'indicateur :
//   1. Sync background poll — couvre le travail de l'AnalyzerServer
//      pendant un sync (manuel ou auto toutes les 10 min).
//   2. Wraps explicites via `railToast.setAiBusy(true/false)` pour les
//      opérations on-demand qui ne passent pas par un sync (ex. génération
//      de brouillon, re-analyse d'un email).
// Le compteur on-demand est indépendant du flag sync pour que deux
// opérations simultanées ne s'annulent pas.
let _onDemandBusyCount = 0;
let _syncBusy = false;
let _busyToast = null;

function _busyMessage() {
  // Pull i18n lazily — i18n.js may not be loaded yet when this module
  // runs (onboarding pages, settings opened immediately). Fall back to FR.
  if (typeof window !== 'undefined' && typeof window.t === 'function') {
    return window.t('rt.ai_busy') || 'Analyse IA en cours…';
  }
  return 'Analyse IA en cours…';
}

function _refreshBusyToast() {
  const want = _syncBusy || _onDemandBusyCount > 0;
  if (want && (!_busyToast || _busyToast.destroyed)) {
    // Spawn a persistent loading toast. duration:0 = no auto-dismiss,
    // collapseAfter:1500 = morph to circle after a second so it doesn't
    // hog the rail with a full pill while still being visible.
    _busyToast = railToast.show({
      variant: 'loading',
      message: _busyMessage(),
      duration: 0,
      collapseAfter: 1500,
    });
  } else if (!want && _busyToast && !_busyToast.destroyed) {
    _busyToast.dismiss();
    _busyToast = null;
  }
}

function setAiBusy(busy) {
  if (busy) _onDemandBusyCount++;
  else      _onDemandBusyCount = Math.max(0, _onDemandBusyCount - 1);
  _refreshBusyToast();
}

async function checkAiBusy() {
  try {
    const r = await fetch('/api/sync/status');
    if (!r.ok) return;
    const s = await r.json();
    const next = !!s.running;
    if (next !== _syncBusy) {
      _syncBusy = next;
      _refreshBusyToast();
    }
  } catch (_) {
    // Network hiccup or backend down — leave the previous state alone.
  }
}

if (typeof window !== 'undefined') {
  window.railToast = railToast;
  window.railToast.setAiBusy = setAiBusy;
  // Permet à un appelant (ex. dashboard.js après un POST /api/sync) de
  // forcer un poll immédiat sans attendre les 3 s de l'intervalle —
  // évite le gap visuel entre le clic et l'apparition du toast.
  window.railToast.checkAiBusy = checkAiBusy;
  try { ensureHost(); } catch (_) {}
  setInterval(checkAiBusy, 3000);
  checkAiBusy();
}

export { railToast, createRailToast };
