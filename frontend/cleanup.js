// SPDX-License-Identifier: GPL-3.0-or-later
// Cleanup workspace : group inbox clutter by sender, run bulk actions.

import {
  api,
  avatarColor, initials, senderDomain, avatarImgHtml,
  shortDate, escapeHtml,
  CATEGORY_COLOR,
} from '/static/api.js';
import { confirmAsync } from '/static/confirm.js';

// confirmAsync now lives in /static/confirm.js (imported above) so the
// mailbox can use the same dialog for bulk delete.

// Labels are resolved at runtime via t() inside mountCleanup.
// Kept as key references here so the array is still static at parse time.
const TABS = [
  { id: 'rules',       labelKey: 'cleanup.tab.rules',       icon: 'sliders',     enabled: true },
  { id: 'unsubscribe', labelKey: 'cleanup.tab.unsubscribe',  icon: 'mail-x',      enabled: true },
  { id: 'senders',     labelKey: 'cleanup.tab.senders',      icon: 'users',       enabled: true },
];

// Curated cleanup presets. The id is stable so jobs/state can key on it.
// `default` is the action surfaced as the primary button; `also` lists
// extra non-destructive actions exposed as secondary buttons.
// Labels/descriptions resolved at runtime via t() in mountCleanup.
const RULES = [
  {
    id: 'spam',
    labelKey: 'cleanup.rule.spam.label',
    descKey:  'cleanup.rule.spam.desc',
    icon: 'shield-x',
    accent: 'var(--danger)',
    filter: { categories: ['spam'] },
    actions: ['delete'],
  },
  {
    id: 'newsletters-old',
    labelKey: 'cleanup.rule.newsletters_old.label',
    descKey:  'cleanup.rule.newsletters_old.desc',
    icon: 'newspaper',
    accent: '#93C5FD',
    filter: { categories: ['newsletter'], older_than_days: 30 },
    actions: ['delete', 'mark_read'],
  },
  {
    id: 'low-score-unread',
    labelKey: 'cleanup.rule.low_score.label',
    descKey:  'cleanup.rule.low_score.desc',
    icon: 'arrow-down-narrow-wide',
    accent: '#C4B5FD',
    filter: { max_score: 3, is_read: false },
    actions: ['mark_read', 'delete'],
  },
  {
    id: 'very-old-unread',
    labelKey: 'cleanup.rule.very_old.label',
    descKey:  'cleanup.rule.very_old.desc',
    icon: 'archive',
    accent: 'var(--muted-2)',
    filter: { is_read: false, older_than_days: 180 },
    actions: ['delete', 'mark_read'],
  },
  {
    id: 'other-unread',
    labelKey: 'cleanup.rule.other_unread.label',
    descKey:  'cleanup.rule.other_unread.desc',
    icon: 'inbox',
    accent: '#FCD34D',
    filter: { categories: ['other'], is_read: false },
    actions: ['mark_read', 'delete'],
  },
];

// Categories shown as a stacked breakdown bar on each sender row.
// Order matters — it's the visual stacking order from left to right.
const CAT_ORDER = ['important', 'transactional', 'newsletter', 'other', 'spam', 'pending'];

function relativeFrench(iso) {
  const _t = window.t || ((k) => k);
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const sec  = Math.max(1, Math.round(diffMs / 1000));
  if (sec < 60)        return _t('cleanup.rel.sec',    { n: sec });
  const min = Math.round(sec / 60);
  if (min < 60)        return _t('cleanup.rel.min',    { n: min });
  const h = Math.round(min / 60);
  if (h < 24)          return _t('cleanup.rel.hour',   { n: h });
  const days = Math.round(h / 24);
  if (days < 30)       return _t('cleanup.rel.day',    { n: days });
  const months = Math.round(days / 30);
  if (months < 12)     return _t('cleanup.rel.month',  { n: months });
  const years = Math.round(months / 12);
  return _t('cleanup.rel.year', { n: years });
}

export async function mountCleanup(host, _opts) {
  const t = window.t || ((k) => k);

  // See the same helper in settings.js: document-level listeners survive the
  // router's host.innerHTML = '', so they have to be registered somewhere the
  // returned cleanup can reach.
  const _docTeardown = [];
  const onDoc = (type, fn, opt) => {
    document.addEventListener(type, fn, opt);
    _docTeardown.push(() => document.removeEventListener(type, fn, opt));
  };

  // Resolve translated labels for static arrays (TABS + RULES).
  const TABS_L  = TABS.map((tab) => ({ ...tab, label: t(tab.labelKey) }));
  const RULES_L = RULES.map((r)   => ({ ...r,  label: t(r.labelKey), description: t(r.descKey) }));

  host.innerHTML = `
    <div class="cln">
      <div class="cln-head">
        <div class="cln-head-titles">
          <h1>${t('cleanup.title')}</h1><div class="sub" id="cln-sub">${t('cleanup.loading')}</div>
        </div>
        <div class="cln-head-actions">
        </div>
      </div>

      <nav class="cln-tabs" role="tablist" aria-label="${t('cleanup.tabs_aria')}">
        ${TABS_L.map((tab, i) => `
          <button class="cln-tab ${i === 0 ? 'active' : ''} ${tab.enabled ? '' : 'is-disabled'}"
                  role="tab" data-tab="${tab.id}" ${tab.enabled ? '' : 'aria-disabled="true"'}
                  aria-selected="${i === 0}">
            <i data-lucide="${tab.icon}" class="w-4 h-4"></i>
            <span>${escapeHtml(tab.label)}</span>
            ${tab.enabled ? '' : `<span class="cln-tab-soon">${t('cleanup.tab.soon')}</span>`}
          </button>
        `).join('')}
      </nav>

      <section class="cln-pane" id="cln-pane">
        <!-- Pane content gets injected per-tab below -->
      </section>

      <!-- Custom-rule side panel + overlay live at the .cln level
           (NOT inside .cln-pane) so position:fixed actually anchors
           to the viewport. .cln-pane has a fade-up animation whose
           non-none transform creates a containing block for fixed
           descendants — moving the panel outside is the only way to
           keep it overlaying the head/tabs too. -->
      <div class="cln-custom-panel-overlay" id="cln-custom-overlay"></div>
      <div class="cln-custom-panel" id="cln-custom-panel" hidden></div>
    </div>
  `;

  const $ = (sel) => host.querySelector(sel);
  const state = {
    tab: TABS[0].id,
    senders: [],
    accounts: [],
    accountFilter: '',
    sortMode: 'total',  // total | unread | newsletter | recent | oldest
    busy: new Set(),    // sender emails currently being processed
    jobs: new Map(),    // sender email -> { id, action, total, done, failed, finished }
    ruleStats: new Map(),    // ruleId -> { total, unread, sample, loading, error }
    ruleBusy: new Set(),     // ruleIds currently being applied
    ruleJobs: new Map(),     // ruleId -> { id, action, total, done, failed, finished }
    selectedRule: RULES[0]?.id || null, // master-detail: which rule is open in the right pane
    sendersStale: false,     // a rule deleted mails -> senders cache is outdated

    // Custom ("plugin") rules
    customRules: [],          // loaded from DB
    customStats: new Map(),   // custom rule id (string "c-<id>") -> stats
    customBusy: new Set(),
    customJobs: new Map(),
    selectedCustomRule: null, // master-detail: which custom rule is open
    customPanel: false,       // template/new-rule side-panel is open
    customEditing: null,      // rule object being edited, or null (= new rule)

    // Désabonnement tab
    unsubSenders: [],
    unsubStats: null,
    selectedUnsub: null,
    unsubBusy: new Set(),
    unsubJobs: new Map(),
    backfillJob: null,
    unsubPurge: false,
  };

  // ── Tabs ──────────────────────────────────────────────────
  host.querySelectorAll('.cln-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.tab;
      const tab = TABS_L.find((tab) => tab.id === id);
      if (!tab) return;
      if (!tab.enabled) {
        window.toast(t('cleanup.tab.soon_toast', { label: tab.label }));
        return;
      }
      if (id === state.tab) return;
      // Close the rule-edit side panel when leaving the Rules tab —
      // it now lives at the .cln level (so position:fixed works) and
      // would otherwise stay visible over an unrelated tab.
      if (state.tab === 'rules' && state.customPanel) {
        closeCustomPanel();
      }
      state.tab = id;
      host.querySelectorAll('.cln-tab').forEach((b) => {
        const on = b.dataset.tab === id;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });

      renderPane();
      // Refresh senders if a rule modified the dataset since last load.
      if (id === 'senders' && state.sendersStale) {
        state.sendersStale = false;
        loadSenders();
      }
    });
  });

  // ── Pane rendering ────────────────────────────────────────
  function renderPane() {
    if (state.tab === 'senders')     renderSendersPane();
    else if (state.tab === 'rules')       renderRulesPane();
    else if (state.tab === 'unsubscribe') renderUnsubscribePane();
    else $('#cln-pane').innerHTML = '';
    // Restart the CSS animation so the pane re-animates on every tab switch.
    const pane = $('#cln-pane');
    if (pane) {
      pane.style.animation = 'none';
      void pane.offsetHeight; // force reflow
      pane.style.animation = '';
    }
  }

  function renderSendersPane() {
    const pane = $('#cln-pane');
    pane.innerHTML = `
      <div class="cln-toolbar">
        <div class="cln-toolbar-left">
          <div class="cln-acc-select" id="cln-acc-wrap">
            <button class="cln-acc-btn" id="cln-acc-btn" type="button">
              <i data-lucide="users" class="w-4 h-4"></i>
              <span id="cln-acc-label">${t('cleanup.all_accounts')}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            <div class="cln-acc-drop" id="cln-acc-drop" role="listbox" hidden></div>
          </div>
          <div class="cln-sort">
            ${[
              { v: 'total',      labelKey: 'cleanup.sort.total' },
              { v: 'unread',     labelKey: 'cleanup.sort.unread' },
              { v: 'newsletter', labelKey: 'cleanup.sort.newsletter' },
              { v: 'recent',     labelKey: 'cleanup.sort.recent' },
              { v: 'oldest',     labelKey: 'cleanup.sort.oldest' },
            ].map((o) => `
              <button class="cln-sort-btn ${state.sortMode === o.v ? 'active' : ''}" data-sort="${o.v}">${t(o.labelKey)}</button>
            `).join('')}
          </div>
        </div>
        <div class="cln-toolbar-right">
          <span class="cln-toolbar-count" id="cln-count">—</span>
        </div>
      </div>

      <div class="cln-senders" id="cln-senders" role="list"></div>
    `;

    pane.querySelectorAll('.cln-sort-btn').forEach((b) => {
      b.addEventListener('click', () => {
        state.sortMode = b.dataset.sort;
        pane.querySelectorAll('.cln-sort-btn').forEach((x) => x.classList.toggle('active', x === b));
        renderSenderList();
      });
    });

    setupAccountDropdown();
    renderSenderList();
  }

  // ── Account filter (custom dropdown that matches the rest of the UI) ─
  function setupAccountDropdown() {
    const btn = $('#cln-acc-btn');
    const drop = $('#cln-acc-drop');
    const label = $('#cln-acc-label');
    if (!btn || !drop) return;

    function paint() {
      const allAccLabel = t('cleanup.all_accounts');
      const items = [{ email: '', name: allAccLabel }, ...state.accounts];
      drop.innerHTML = items.map((a) => `
        <div class="acc-select-opt ${state.accountFilter === a.email ? 'active' : ''}"
             role="option" data-acc="${escapeHtml(a.email)}">
          ${escapeHtml(a.name || a.email || allAccLabel)}
        </div>
      `).join('');
      const cur = state.accountFilter
        ? (state.accounts.find((a) => a.email === state.accountFilter)?.name || state.accountFilter)
        : allAccLabel;
      label.textContent = cur;
    }
    paint();

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = drop.hidden;
      drop.hidden = !open;
    });
    drop.addEventListener('click', (e) => {
      const opt = e.target.closest('.acc-select-opt');
      if (!opt) return;
      state.accountFilter = opt.dataset.acc;
      drop.hidden = true;
      paint();
      loadSenders();
    });
    onDoc('click', (e) => {
      if (!drop.contains(e.target) && !btn.contains(e.target)) drop.hidden = true;
    });
  }

  // ── Senders list ─────────────────────────────────────────
  function sortSenders(arr) {
    const copy = [...arr];
    switch (state.sortMode) {
      case 'unread':     return copy.sort((a, b) => b.unread - a.unread || b.total - a.total);
      case 'newsletter': return copy.sort((a, b) => b.newsletter - a.newsletter || b.total - a.total);
      case 'recent':     return copy.sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || ''));
      case 'oldest':     return copy.sort((a, b) => (a.first_seen || '').localeCompare(b.first_seen || ''));
      default:           return copy.sort((a, b) => b.total - a.total || b.unread - a.unread);
    }
  }

  function renderSenderList() {
    const list = $('#cln-senders');
    if (!list) return;
    const items = sortSenders(state.senders);
    const totalEmails = items.reduce((acc, s) => acc + s.total, 0);
    const totalUnread = items.reduce((acc, s) => acc + s.unread, 0);
    $('#cln-count').textContent = t('cleanup.senders.count', {
      senders: items.length, emails: totalEmails, unread: totalUnread,
    });

    if (!items.length) {
      list.innerHTML = `
        <div class="cln-empty">
          <div class="cln-empty-ico"><i data-lucide="sparkles" class="w-7 h-7"></i></div>
          <div class="cln-empty-title">${t('cleanup.senders.empty_title')}</div>
          <div class="cln-empty-sub">${t('cleanup.senders.empty_sub')}</div>
        </div>`;
      window.lucide?.createIcons();
      return;
    }

    list.innerHTML = items.map((s) => senderRowHtml(s)).join('');

    list.querySelectorAll('.cln-row').forEach((row) => {
      const email = row.dataset.email;
      row.querySelector('[data-act="delete"]')?.addEventListener('click', () => act(email, 'delete', row));
      row.querySelector('[data-act="mark_read"]')?.addEventListener('click', () => act(email, 'mark_read', row));
      row.querySelector('[data-act="view"]')?.addEventListener('click', () => viewInInbox(email));
    });

    // If a job was running for a sender that survives in the list (e.g. a
    // mark-read job, or a delete that hasn't dropped the row yet), reattach
    // the progress UI to the new DOM node.
    for (const job of state.jobs.values()) {
      const row = list.querySelector(`.cln-row[data-email="${cssEscape(job.sender)}"]`);
      if (row) renderProgress(row, job);
    }

    window.lucide?.createIcons();
  }

  // Robust escape for use inside an attribute selector. CSS.escape handles
  // dots, @, dashes and other punctuation that would break a naive selector.
  function cssEscape(v) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(String(v));
    }
    return String(v).replace(/["\\]/g, '\\$&');
  }

  function senderRowHtml(s) {
    const display = s.name || s.email;
    const ini = initials(display);
    const col = avatarColor(s.email || display);
    const logoImg = avatarImgHtml(s.email);
    const domain = senderDomain(s.email);

    // Build the breakdown stack: only categories with count>0 contribute.
    const segs = CAT_ORDER
      .filter((k) => (s[k] || 0) > 0)
      .map((k) => ({
        key: k,
        count: s[k],
        color: CATEGORY_COLOR[k] || 'var(--muted-2)',
        pct: (s[k] / s.total) * 100,
      }));

    const breakdownBar = '';

    const isBusy = state.busy.has(s.email);
    const isAllRead = s.unread === 0 && s.total > 0;

    return `
      <article class="cln-row ${isBusy ? 'is-busy' : ''} ${isAllRead ? 'is-all-read' : ''}" role="listitem" data-email="${escapeHtml(s.email)}">
        <div class="cln-av" style="background:${col}">
          <span class="av-text">${escapeHtml(ini)}</span>
          ${logoImg}
        </div>
        <div class="cln-row-main">
          <div class="cln-row-top">
            <span class="cln-row-name">${escapeHtml(display)}</span>
            <span class="cln-row-mail">${escapeHtml(s.email)}</span>
            ${domain ? `<a class="cln-row-domain" href="https://${escapeHtml(domain)}" target="_blank" rel="noopener noreferrer" title="${t('cleanup.sender.open_domain', { domain: escapeHtml(domain) })}"><i data-lucide="external-link" class="w-3 h-3"></i></a>` : ''}
          </div>
          <div class="cln-row-stats">
            <span class="cln-stat"><strong>${s.total}</strong> msg</span>
            ${s.unread > 0 ? `<span class="cln-stat cln-stat-unread"><strong>${s.unread}</strong> ${t('cleanup.sender.unread')}</span>` : ''}
            ${s.newsletter > 0 ? `<span class="cln-stat" style="color:${CATEGORY_COLOR.newsletter}"><strong>${s.newsletter}</strong> news</span>` : ''}
            ${s.important > 0 ? `<span class="cln-stat" style="color:${CATEGORY_COLOR.important}"><strong>${s.important}</strong> imp.</span>` : ''}
            <span class="cln-stat cln-stat-date">${t('cleanup.sender.last_seen', { rel: escapeHtml(relativeFrench(s.last_seen)) })}</span>
          </div>
        </div>
        <div class="cln-row-actions">
          <button class="cln-act" data-act="view" title="${t('cleanup.act.view_title')}" aria-label="${t('cleanup.act.view_aria')}" ${isBusy ? 'disabled' : ''}>
            <i data-lucide="inbox" class="w-4 h-4"></i><span>${t('cleanup.act.view')}</span>
          </button>
          <button class="cln-act" data-act="mark_read" title="${t('cleanup.act.mark_read_title')}" aria-label="${t('cleanup.act.mark_read_title')}" ${isBusy ? 'disabled' : ''}>
            <i data-lucide="mail-open" class="w-4 h-4"></i><span>${t('cleanup.act.mark_read')}</span>
          </button>
          <button class="cln-act cln-act-danger" data-act="delete" title="${t('cleanup.act.delete_title')}" aria-label="${t('cleanup.act.delete_title')}" ${isBusy ? 'disabled' : ''}>
            <i data-lucide="trash-2" class="w-4 h-4"></i><span>${t('cleanup.act.delete')}</span>
          </button>
        </div>
        ${breakdownBar}
        <div class="cln-progress" hidden>
          <div class="cln-progress-track"><div class="cln-progress-fill" style="width:0%"></div></div>
          <div class="cln-progress-meta">
            <span class="cln-progress-label">—</span>
            <span class="cln-progress-count">0 / 0</span>
          </div>
        </div>
      </article>
    `;
  }

  // ── Actions ──────────────────────────────────────────────
  async function act(email, action, row) {
    if (state.busy.has(email)) return;
    const sender = state.senders.find((s) => s.email === email);
    if (!sender) return;

    if (action === 'delete') {
      const ok = await confirmAsync({
        title: t('cleanup.confirm.delete_title'),
        message: t('cleanup.confirm.delete_msg', { n: sender.total, name: sender.name || sender.email }),
        confirmLabel: t('cleanup.act.delete'),
        danger: true,
      });
      if (!ok) return;
    }

    state.busy.add(email);
    if (row) {
      row.classList.add('is-busy');
      row.querySelectorAll('.cln-act').forEach((b) => (b.disabled = true));
    }

    let res;
    try {
      const acc = state.accountFilter || undefined;
      res = await api.cleanupSender(email, action, acc);
    } catch (err) {
      window.toast(t('cleanup.toast.fail', { msg: err.message }));
      state.busy.delete(email);
      if (row) {
        row.classList.remove('is-busy');
        row.querySelectorAll('.cln-act').forEach((b) => (b.disabled = false));
      }
      return;
    }

    const affected = res?.affected ?? 0;
    const total = res?.total ?? 0;
    const jobId = res?.job_id;

    if (!jobId || total === 0) {
      // Nothing for IMAP to push (e.g. all already in trash). DB is in sync.
      window.toast(
        action === 'delete'
          ? (affected ? t('cleanup.toast.deleted', { n: affected }) : t('cleanup.toast.nothing_to_delete'))
          : (affected ? t('cleanup.toast.marked_read', { n: affected }) : t('cleanup.toast.already_read'))
      );
      finishLocalUpdate(email, action);
      return;
    }

    // Stream the IMAP propagation progress. The DB is already updated, so
    // for `delete` we keep the row in place during the IMAP push (with the
    // progress bar showing) instead of removing it immediately. The row is
    // dropped when the job finishes.
    const job = {
      id: jobId,
      sender: email,
      action,
      total,
      done: 0,
      failed: 0,
      finished: false,
    };
    state.jobs.set(email, job);
    if (row) renderProgress(row, job);

    pollJob(job);
  }

  function finishLocalUpdate(email, action) {
    if (action === 'delete') {
      state.senders = state.senders.filter((s) => s.email !== email);
      renderSenderList();
    } else {
      // Drop unread/pending counts to zero on the local sender to reflect
      // the just-issued mark-read; saves a full reload roundtrip.
      const s = state.senders.find((x) => x.email === email);
      if (s) s.unread = 0;
      renderSenderList();
    }
    state.busy.delete(email);
  }

  function renderProgress(row, job) {
    const progress = row.querySelector('.cln-progress');
    const actions = row.querySelector('.cln-row-actions');
    if (!progress || !actions) return;
    progress.hidden = false;
    actions.style.display = 'none';
    const fill = progress.querySelector('.cln-progress-fill');
    const label = progress.querySelector('.cln-progress-label');
    const count = progress.querySelector('.cln-progress-count');
    const ratio = job.total ? ((job.done + job.failed) / job.total) : 0;
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    const verb = job.action === 'delete' ? t('cleanup.progress.deleting') : t('cleanup.progress.marking');
    if (job.finished) {
      label.textContent = job.failed
        ? t('cleanup.progress.done_errors', { n: job.failed })
        : t('cleanup.progress.done');
    } else {
      label.textContent = verb;
    }
    count.textContent = `${job.done + job.failed} / ${job.total}`;
  }

  async function pollJob(job) {
    const tick = async () => {
      let snap;
      try {
        snap = await api.getCleanupJob(job.id);
      } catch (_) {
        // Job lost (server restart?) — give up gracefully.
        state.jobs.delete(job.sender);
        finishLocalUpdate(job.sender, job.action);
        return;
      }
      job.done = snap.done;
      job.failed = snap.failed;
      job.finished = snap.finished;
      const row = $(`.cln-row[data-email="${cssEscape(job.sender)}"]`);
      if (row) renderProgress(row, job);
      if (snap.finished) {
        state.jobs.delete(job.sender);
        window.toast(snap.failed
          ? t('cleanup.toast.job_errors', { done: snap.done, failed: snap.failed })
          : t('cleanup.toast.job_done', { done: snap.done, total: snap.total }));
        finishLocalUpdate(job.sender, job.action);
        return;
      }
      // Adaptive cadence: faster while moving, slower while waiting.
      const delay = (snap.done + snap.failed) > 0 ? 600 : 1200;
      setTimeout(tick, delay);
    };
    tick();
  }

  // Pre-fill the Inbox search with this sender's email so the user lands
  // on a filtered view of just their messages.
  function viewInInbox(email) {
    location.hash = `#/inbox?q=${encodeURIComponent(email)}`;
  }

  // ── Rules tab (master-detail layout) ─────────────────────
  function renderRulesPane() {
    const pane = $('#cln-pane');
    pane.innerHTML = `
      <div class="cln-rules-layout">
        <aside class="cln-rules-rail" aria-label="${t('cleanup.rules.rail_aria')}">
          <div class="cln-rules-rail-head">${t('cleanup.tab.rules')}</div>
          <div class="cln-rules-rail-list" id="cln-rules-rail"></div>
        </aside>
        <section class="cln-rules-detail" id="cln-rules-detail" aria-live="polite"></section>
      </div>
    `;
    renderRulesRail();
    if (state.selectedRule) openRuleDetail(state.selectedRule);
    // Lazily fetch counts for each rule. Cached in state.ruleStats so
    // switching tabs doesn't re-roundtrip every preset.
    for (const r of RULES_L) {
      if (!state.ruleStats.has(r.id)) loadRuleStats(r.id);
    }
    // Load custom rules
    if (state.customRules.length === 0) loadCustomRules();
  }

  function renderRulesRail() {
    const rail = $('#cln-rules-rail');
    if (!rail) return;
    const customItems = state.customRules.map((r) => customRailItemHtml(r)).join('');
    rail.innerHTML = `
      ${RULES_L.map((r) => ruleRailItemHtml(r)).join('')}
      <div class="cln-rail-sep" id="cln-rail-sep-custom">
        <span>${t('cleanup.rules.my_rules')}</span>
      </div>
      <div id="cln-custom-rail-list">
        ${customItems || `<div class="cln-rail-empty-hint">${t('cleanup.rules.no_custom')}</div>`}
      </div>
      <button class="cln-rail-add-btn" id="btn-add-custom-rule" type="button"
              title="${t('cleanup.rules.add_title')}">
        <i data-lucide="plus" class="w-4 h-4"></i>
        <span>${t('cleanup.rules.new_rule')}</span>
      </button>
    `;
    rail.querySelectorAll('.cln-rail-item[data-rule]').forEach((el) => {
      el.addEventListener('click', () => selectRule(el.dataset.rule));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectRule(el.dataset.rule);
        }
      });
    });
    rail.querySelectorAll('.cln-rail-item[data-custom-id]').forEach((el) => {
      el.addEventListener('click', () => selectCustomRule(Number(el.dataset.customId)));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectCustomRule(Number(el.dataset.customId));
        }
      });
    });
    rail.querySelector('#btn-add-custom-rule')?.addEventListener('click', () => openCustomPanel(null));
    window.lucide?.createIcons();
  }

  function ruleRailItemHtml(r) {
    const stats = state.ruleStats.get(r.id);
    const isActive = state.selectedRule === r.id;
    const isBusy = state.ruleBusy.has(r.id);
    const total = stats && !stats.loading ? stats.total : null;
    const isEmpty = total === 0;
    return `
      <button class="cln-rail-item ${isActive ? 'is-active' : ''} ${isEmpty ? 'is-empty' : ''} ${isBusy ? 'is-busy' : ''}"
              data-rule="${r.id}" type="button" role="tab" aria-selected="${isActive}">
        <span class="cln-rail-icn" style="background:color-mix(in oklab, ${r.accent} 18%, transparent); color: ${r.accent}">
          <i data-lucide="${r.icon}" class="w-4 h-4"></i>
        </span>
        <span class="cln-rail-text">
          <span class="cln-rail-name">${escapeHtml(r.label)}</span>
          <span class="cln-rail-desc">${escapeHtml(r.description)}</span>
        </span>
        <span class="cln-rail-count">${
          stats == null || stats.loading
            ? '…'
            : (stats.error ? '!' : String(stats.total))
        }</span>
      </button>
    `;
  }

  function selectRule(ruleId) {
    if (!RULES_L.some((r) => r.id === ruleId)) return;
    if (state.selectedRule === ruleId) return;
    state.selectedRule = ruleId;
    state.selectedCustomRule = null;
    // Update active state on rail items without rebuilding the whole rail
    $('#cln-rules-rail')?.querySelectorAll('.cln-rail-item').forEach((el) => {
      const on = el.dataset.rule === ruleId;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderRuleDetail(ruleId);
  }

  function selectCustomRule(customId) {
    const r = state.customRules.find((x) => x.id === customId);
    if (!r) return;
    state.selectedRule = null;
    state.selectedCustomRule = customId;
    $('#cln-rules-rail')?.querySelectorAll('.cln-rail-item').forEach((el) => {
      const on = Number(el.dataset.customId) === customId;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderCustomRuleDetail(customId);
  }

  // Helper used by both preset and custom rule detail opening
  function openRuleDetail(ruleId) {
    if (ruleId) renderRuleDetail(ruleId);
  }

  function paintRailItem(ruleId) {
    const rail = $('#cln-rules-rail');
    if (!rail) return;
    const item = rail.querySelector(`.cln-rail-item[data-rule="${ruleId}"]`);
    if (!item) return;
    const r = RULES_L.find((x) => x.id === ruleId);
    if (!r) return;
    item.outerHTML = ruleRailItemHtml(r);
    // Re-bind handlers on the replaced node
    const fresh = rail.querySelector(`.cln-rail-item[data-rule="${ruleId}"]`);
    if (fresh) {
      fresh.addEventListener('click', () => selectRule(ruleId));
      fresh.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectRule(ruleId);
        }
      });
      window.lucide?.createIcons();
    }
  }

  function paintCustomRailList() {
    const listEl = $('#cln-custom-rail-list');
    if (!listEl) return;
    const customItems = state.customRules.map((r) => customRailItemHtml(r)).join('');
    listEl.innerHTML = customItems || `<div class="cln-rail-empty-hint">${t('cleanup.rules.no_custom')}</div>`;
    listEl.querySelectorAll('.cln-rail-item[data-custom-id]').forEach((el) => {
      el.addEventListener('click', () => selectCustomRule(Number(el.dataset.customId)));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCustomRule(Number(el.dataset.customId)); }
      });
    });
    window.lucide?.createIcons();
  }

  async function loadRuleStats(ruleId) {
    const r = RULES_L.find((x) => x.id === ruleId);
    if (!r) return;
    state.ruleStats.set(ruleId, { loading: true, total: 0, unread: 0, sample: [] });
    paintRailItem(ruleId);
    if (state.selectedRule === ruleId) renderRuleDetail(ruleId);
    try {
      const res = await api.previewCleanupRule(r.filter);
      state.ruleStats.set(ruleId, {
        loading: false, error: null,
        total: res.total, unread: res.unread,
        by_account: res.by_account, sample: res.sample,
        top_senders: res.top_senders, date_oldest: res.date_oldest, date_newest: res.date_newest,
      });
    } catch (err) {
      state.ruleStats.set(ruleId, { loading: false, error: err.message, total: 0, unread: 0, sample: [] });
    }
    paintRailItem(ruleId);
    if (state.selectedRule === ruleId) renderRuleDetail(ruleId);
  }

  function renderRuleDetail(ruleId) {
    const detail = $('#cln-rules-detail');
    if (!detail) return;
    const r = RULES_L.find((x) => x.id === ruleId);
    if (!r) {
      detail.innerHTML = `<div class="cln-empty"><div class="cln-empty-title">${t('cleanup.rules.none_selected')}</div></div>`;
      return;
    }
    const stats = state.ruleStats.get(ruleId);
    const isBusy = state.ruleBusy.has(ruleId);
    const job = state.ruleJobs.get(ruleId);

    // ── Action buttons (top-right of header)
    const actionsBtns = r.actions.map((a, i) => {
      const isPrimary = i === 0;
      const danger = a === 'delete';
      const actLabel = a === 'delete' ? t('cleanup.act.delete') : t('cleanup.act.mark_all_read');
      const icon  = a === 'delete' ? 'trash-2' : 'mail-open';
      const empty = !stats || stats.total === 0 || stats.loading;
      return `<button class="cln-rule-act ${isPrimary ? 'cln-rule-act-primary' : ''} ${danger ? 'cln-rule-act-danger' : ''}"
                      data-rule-act="${a}" ${(isBusy || empty) ? 'disabled' : ''}>
                <i data-lucide="${icon}" class="w-3.5 h-3.5"></i>${actLabel}
              </button>`;
    }).join('');

    // Header (always rendered, regardless of loading state)
    const header = `
      <header class="cln-detail-head">
        <span class="cln-rule-icn cln-detail-icn"
              style="background:color-mix(in oklab, ${r.accent} 18%, transparent); color: ${r.accent}">
          <i data-lucide="${r.icon}" class="w-5 h-5"></i>
        </span>
        <div class="cln-detail-titles">
          <h2 class="cln-detail-name">${escapeHtml(r.label)}</h2>
          <p class="cln-detail-desc">${escapeHtml(r.description)}</p>
        </div>
        <div class="cln-detail-actions">
          ${actionsBtns}
        </div>
      </header>
    `;

    // Body switches based on loading / empty / data
    let body = '';
    if (!stats || stats.loading) {
      body = `<div class="cln-detail-empty">${t('cleanup.detail.loading')}</div>`;
    } else if (stats.error) {
      body = `<div class="cln-detail-empty cln-error">${t('cleanup.detail.error', { msg: escapeHtml(stats.error) })}</div>`;
    } else if (stats.total === 0) {
      body = `
        <div class="cln-detail-empty">
          <div class="cln-empty-ico"><i data-lucide="check" class="w-7 h-7"></i></div>
          <div class="cln-empty-title">${t('cleanup.detail.empty_title')}</div>
          <div class="cln-empty-sub">${t('cleanup.detail.empty_sub')}</div>
        </div>`;
    } else {
      body = renderRuleDetailBody(stats);
    }

    detail.innerHTML = `
      ${header}
      <div class="cln-detail-progress" data-progress hidden>
        <div class="cln-progress-track"><div class="cln-progress-fill" style="width:0%"></div></div>
        <div class="cln-progress-meta">
          <span class="cln-progress-label">—</span>
          <span class="cln-progress-count">0 / 0</span>
        </div>
      </div>
      <div class="cln-detail-body">${body}</div>
    `;

    // Wire up action buttons
    detail.querySelectorAll('[data-rule-act]').forEach((b) => {
      b.addEventListener('click', () => runRule(ruleId, b.dataset.ruleAct));
    });
    // Wire up sender chips → inbox filter
    detail.querySelectorAll('.cln-prv-sender').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        viewInInbox(btn.dataset.sender);
      });
    });
    // Sample row → open mail in inbox
    detail.querySelectorAll('.cln-prv-row[data-int-id]').forEach((row) => {
      const open = () => { location.hash = `#/inbox?focus=${encodeURIComponent(row.dataset.intId)}`; };
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });

    // Re-attach in-flight progress UI
    if (job) {
      const card = detail; // progress lives on the detail container
      renderRuleProgress(card, job);
    }

    window.lucide?.createIcons();
  }

  function renderRuleDetailBody(stats) {
    // ── Summary strip
    const accEntries = stats.by_account
      ? Object.entries(stats.by_account).sort((a, b) => b[1] - a[1])
      : [];
    const TOP_ACC = 3;
    const accChipsVisible = accEntries.slice(0, TOP_ACC)
      .map(([acc, n]) => `<span class="cln-prv-chip" title="${escapeHtml(acc)}">${escapeHtml(acc.split('@')[0])} · ${n}</span>`)
      .join('');
    const accHidden = accEntries.length - TOP_ACC;
    const accChips = accChipsVisible
      + (accHidden > 0 ? `<span class="cln-prv-chip cln-prv-chip-more">+${accHidden}</span>` : '');
    const dateSpanLabel = (stats.date_oldest && stats.date_newest)
      ? (stats.date_oldest === stats.date_newest
         ? t('cleanup.detail.date_single', { rel: escapeHtml(relativeFrench(stats.date_oldest)) })
         : t('cleanup.detail.date_range',  { from: escapeHtml(relativeFrench(stats.date_oldest)), to: escapeHtml(relativeFrench(stats.date_newest)) }))
      : '';

    // ── Top senders within the rule
    const topSenders = (stats.top_senders || []).slice(0, 6);
    const topSendersHtml = topSenders.length
      ? `
        <div class="cln-detail-section">
          <h4 class="cln-detail-section-title">${t('cleanup.detail.top_senders')}</h4>
          <div class="cln-prv-senders">
            ${topSenders.map((s) => {
              const display = s.name || s.email;
              const ini = initials(display);
              const col = avatarColor(s.email || display);
              const img = avatarImgHtml(s.email, 22);
              return `
                <button class="cln-prv-sender" type="button"
                        data-sender="${escapeHtml(s.email)}"
                        title="${t('cleanup.detail.sender_view', { name: escapeHtml(display) })}">
                  <span class="cln-prv-sender-av" style="background:${col}">
                    <span class="av-text">${escapeHtml(ini)}</span>
                    ${img}
                  </span>
                  <span class="cln-prv-sender-name">${escapeHtml(display)}</span>
                  <span class="cln-prv-sender-n">${s.count}</span>
                </button>
              `;
            }).join('')}
          </div>
        </div>`
      : '';

    // ── Sample list
    const sampleHtml = stats.sample.map((em) => {
      const sName = senderShort(em.sender);
      const sEmail = (em.sender || '').match(/<([^>]+)>/)?.[1] || em.sender || '';
      const ini = initials(sName);
      const col = avatarColor(sEmail || sName);
      const img = avatarImgHtml(sEmail, 28);
      const score = em.importance_score || 0;
      const cat = em.category || 'pending';
      const showId = em.int_id != null;
      return `
        <div class="cln-prv-row ${em.is_read ? '' : 'is-unread'}"
             ${showId ? `data-int-id="${em.int_id}" role="button" tabindex="0" title="${t('cleanup.detail.open_email')}"` : ''}>
          <span class="cln-prv-av" style="background:${col}">
            <span class="av-text">${escapeHtml(ini)}</span>
            ${img}
          </span>
          <div class="cln-prv-body">
            <div class="cln-prv-r1">
              <span class="cln-prv-from">${escapeHtml(sName || sEmail || t('cleanup.unknown_sender'))}</span>
              <span class="cln-prv-cat" style="background:${CATEGORY_COLOR[cat] || 'var(--muted-2)'}" title="${escapeHtml(cat)}"></span>
              ${score > 0 ? `<span class="cln-prv-score s-${score >= 7 ? 'hi' : (score >= 4 ? 'md' : 'lo')}">${score}</span>` : ''}
              <span class="cln-prv-date">${escapeHtml(relativeFrench(em.date_received))}</span>
            </div>
            <div class="cln-prv-subj">${escapeHtml(em.subject || t('cleanup.no_subject'))}</div>
          </div>
        </div>
      `;
    }).join('');

    const remaining = stats.total - stats.sample.length;

    return `
      <div class="cln-prv-summary">
        <div class="cln-prv-summary-row">
          <span class="cln-prv-kpi"><strong>${stats.total}</strong>&nbsp;message${stats.total > 1 ? 's' : ''}</span>
          <span class="cln-prv-kpi cln-prv-kpi-muted"><strong>${stats.unread}</strong>&nbsp;non&nbsp;lu${stats.unread > 1 ? 's' : ''}</span>
          ${(dateSpanLabel || accChips) ? `<div class="cln-prv-row-right">
            ${dateSpanLabel ? `<span class="cln-prv-span">${dateSpanLabel}</span>` : ''}
            ${accChips ? `<div class="cln-prv-chips">${accChips}</div>` : ''}
          </div>` : ''}
        </div>
      </div>
      ${topSendersHtml}
      <div class="cln-detail-section">
        <h4 class="cln-detail-section-title">${stats.sample.length === stats.total
          ? t('cleanup.detail.all_messages', { n: stats.total })
          : t('cleanup.detail.recent_messages', { n: stats.sample.length })
        }</h4>
        <div class="cln-prv-list cln-prv-list-tall">${sampleHtml}</div>
        ${remaining > 0
          ? `<div class="cln-prv-more">${t('cleanup.detail.more', { n: remaining })}</div>`
          : ''}
      </div>
    `;
  }

  function senderShort(raw) {
    if (!raw) return (window.t || ((k) => k))('cleanup.unknown_sender');
    const m = /<([^>]+)>/.exec(raw);
    if (m) {
      const name = raw.split('<', 1)[0].trim().replace(/^"|"$/g, '').trim();
      return name || m[1];
    }
    return raw;
  }

  // ── Confirmation modale pour suppression ─────────────────────────────────
  function confirmDelete(count, label) {
    return new Promise((resolve) => {
      const id = `del-modal-${Date.now()}`;
      const el = document.createElement('div');
      el.id = id;
      el.innerHTML = `
        <div class="cln-del-overlay" id="${id}-overlay">
          <div class="cln-del-modal" role="alertdialog" aria-modal="true"
               aria-label="${(window.t||((k)=>k))('cleanup.confirm.delete_aria')}">
            <div class="cln-del-icon">
              <i data-lucide="trash-2" class="w-6 h-6"></i>
            </div>
            <div class="cln-del-title">${(window.t||((k)=>k))('cleanup.confirm.delete_count_title', { n: count })}</div>
            <div class="cln-del-body">
              ${(window.t||((k)=>k))('cleanup.confirm.delete_body_html', { label: escapeHtml(label) })}
            </div>
            <div class="cln-del-actions">
              <button class="cln-rule-act" id="${id}-cancel">${(window.t||((k)=>k))('cleanup.cancel')}</button>
              <button class="cln-rule-act cln-rule-act-danger" id="${id}-confirm">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                ${(window.t||((k)=>k))('cleanup.act.delete_n', { n: count })}
              </button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(el);
      window.lucide?.createIcons({ el });

      const cleanup = (result) => {
        el.querySelector(`#${id}-overlay`).classList.add('cln-del-closing');
        setTimeout(() => { el.remove(); resolve(result); }, 180);
      };

      el.querySelector(`#${id}-cancel`).addEventListener('click', () => cleanup(false));
      el.querySelector(`#${id}-confirm`).addEventListener('click', () => cleanup(true));
      el.querySelector(`#${id}-overlay`).addEventListener('click', (e) => {
        if (e.target === e.currentTarget) cleanup(false);
      });
      // Focus confirm for keyboard accessibility
      setTimeout(() => el.querySelector(`#${id}-confirm`)?.focus(), 50);
    });
  }

  async function runRule(ruleId, action) {
    if (state.ruleBusy.has(ruleId)) return;
    const rule = RULES_L.find((r) => r.id === ruleId);
    const stats = state.ruleStats.get(ruleId);
    if (!rule || !stats || stats.total === 0) return;

    if (action === 'delete') {
      const ok = await confirmDelete(stats.total, rule.label);
      if (!ok) return;
    }

    state.ruleBusy.add(ruleId);
    const detail = $('#cln-rules-detail');
    if (detail) detail.querySelectorAll('button').forEach((b) => (b.disabled = true));

    let res;
    try {
      res = await api.runCleanupRule(rule.filter, action);
    } catch (err) {
      window.toast(t('cleanup.toast.fail', { msg: err.message }));
      state.ruleBusy.delete(ruleId);
      if (detail) detail.querySelectorAll('button').forEach((b) => (b.disabled = false));
      return;
    }

    const total = res?.total ?? 0;
    const jobId = res?.job_id;
    if (!jobId || total === 0) {
      window.toast(t('cleanup.toast.nothing_required', { n: res?.affected ?? 0 }));
      finishRule(ruleId, action);
      return;
    }

    const job = {
      id: jobId,
      ruleId,
      action,
      total,
      done: 0,
      failed: 0,
      finished: false,
    };
    state.ruleJobs.set(ruleId, job);
    if (detail && state.selectedRule === ruleId) renderRuleProgress(detail, job);
    pollRuleJob(job);
  }

  function renderRuleProgress(host, job) {
    const wrap = host.querySelector('[data-progress]');
    const actions = host.querySelector('.cln-detail-actions');
    if (!wrap) return;
    wrap.hidden = false;
    if (actions) actions.style.visibility = 'hidden';
    const fill = wrap.querySelector('.cln-progress-fill');
    const label = wrap.querySelector('.cln-progress-label');
    const count = wrap.querySelector('.cln-progress-count');
    const ratio = job.total ? ((job.done + job.failed) / job.total) : 0;
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    const verb = job.action === 'delete' ? t('cleanup.progress.deleting') : t('cleanup.progress.marking');
    label.textContent = job.finished
      ? (job.failed ? t('cleanup.progress.done_errors', { n: job.failed }) : t('cleanup.progress.done'))
      : verb;
    count.textContent = `${job.done + job.failed} / ${job.total}`;
  }

  async function pollRuleJob(job) {
    const tick = async () => {
      let snap;
      try { snap = await api.getCleanupJob(job.id); }
      catch (_) {
        state.ruleJobs.delete(job.ruleId);
        finishRule(job.ruleId, job.action);
        return;
      }
      job.done = snap.done;
      job.failed = snap.failed;
      job.finished = snap.finished;
      const detail = $('#cln-rules-detail');
      if (detail && state.selectedRule === job.ruleId) renderRuleProgress(detail, job);
      if (snap.finished) {
        window.toast(snap.failed
          ? t('cleanup.toast.job_errors', { done: snap.done, failed: snap.failed })
          : t('cleanup.toast.job_done', { done: snap.done, total: snap.total }));
        state.ruleJobs.delete(job.ruleId);
        finishRule(job.ruleId, job.action);
        return;
      }
      const delay = (snap.done + snap.failed) > 0 ? 600 : 1200;
      setTimeout(tick, delay);
    };
    tick();
  }

  function finishRule(ruleId, _action) {
    state.ruleBusy.delete(ruleId);
    // Invalidate the cached counts — every rule's selection may have
    // shifted (deleting low-score also empties "Other unread", etc.),
    // and the senders tab is also stale.
    for (const r of RULES_L) state.ruleStats.delete(r.id);
    state.sendersStale = true;
    // Refetch counts in the background; rail badges go to "…" then update.
    for (const r of RULES_L) loadRuleStats(r.id);
    // Repaint detail immediately to lift the disabled state and progress.
    if (state.selectedRule) renderRuleDetail(state.selectedRule);
  }

  // ── Custom rules ──────────────────────────────────────────────────────────

  // Template names/descriptions resolved at runtime.
  const CUSTOM_TEMPLATES = [
    {
      id: 'job-search',
      nameKey: 'cleanup.tpl.job_search.name',
      descKey: 'cleanup.tpl.job_search.desc',
      icon: 'briefcase',
      accent: '#34D399',
      filter: {
        subject_keywords: ['candidature', 'entretien', 'recrutement', 'CV', 'offre d\'emploi', 'poste'],
        sender_keywords: ['linkedin', 'indeed', 'welcometothejungle', 'hellowork', 'glassdoor'],
      },
      actions: ['mark_read'],
    },
    {
      id: 'security-codes',
      nameKey: 'cleanup.tpl.security_codes.name',
      descKey: 'cleanup.tpl.security_codes.desc',
      icon: 'shield-check',
      accent: '#F59E0B',
      filter: {
        subject_keywords: ['code', 'OTP', 'vérification', '2FA', 'authentification', 'sécurité', 'connexion'],
      },
      actions: ['mark_read'],
    },
    {
      id: 'social-networks',
      nameKey: 'cleanup.tpl.social.name',
      descKey: 'cleanup.tpl.social.desc',
      icon: 'share-2',
      accent: '#818CF8',
      filter: {
        sender_keywords: ['twitter', 'instagram', 'facebook', 'tiktok', 'snapchat', 'linkedin'],
      },
      actions: ['mark_read', 'delete'],
    },
    {
      id: 'app-notifications',
      nameKey: 'cleanup.tpl.app_notifs.name',
      descKey: 'cleanup.tpl.app_notifs.desc',
      icon: 'bell',
      accent: '#94A3B8',
      filter: {
        sender_keywords: ['noreply', 'no-reply', 'donotreply', 'notifications'],
      },
      actions: ['mark_read'],
    },
    {
      id: 'promotions',
      nameKey: 'cleanup.tpl.promotions.name',
      descKey: 'cleanup.tpl.promotions.desc',
      icon: 'tag',
      accent: '#F472B6',
      filter: {
        subject_keywords: ['promo', 'soldes', 'réduction', '% de réduction', 'offre spéciale', 'bon plan'],
      },
      actions: ['delete', 'mark_read'],
    },
  ].map((tpl) => ({ ...tpl, name: t(tpl.nameKey), description: t(tpl.descKey) }));

  async function loadCustomRules() {
    try {
      const rules = await api.getCustomRules();
      state.customRules = rules.map((r) => ({
        ...r,
        filter: typeof r.filter_json === 'string' ? JSON.parse(r.filter_json || '{}') : (r.filter_json || {}),
        actions: typeof r.actions_json === 'string' ? JSON.parse(r.actions_json || '["mark_read"]') : (r.actions_json || ['mark_read']),
      }));
      paintCustomRailList();
      // Load stats for newly loaded rules
      for (const r of state.customRules) {
        const key = `c-${r.id}`;
        if (!state.customStats.has(key)) loadCustomRuleStats(r.id);
      }
    } catch (err) {
      console.warn('Custom rules load failed:', err);
    }
  }

  async function loadCustomRuleStats(customId) {
    const r = state.customRules.find((x) => x.id === customId);
    if (!r) return;
    const key = `c-${customId}`;
    state.customStats.set(key, { loading: true, total: 0, unread: 0, sample: [] });
    paintCustomRailList();
    try {
      const res = await api.previewCleanupRule(r.filter);
      state.customStats.set(key, {
        loading: false, error: null,
        total: res.total, unread: res.unread,
        by_account: res.by_account, sample: res.sample,
        top_senders: res.top_senders, date_oldest: res.date_oldest, date_newest: res.date_newest,
      });
    } catch (err) {
      state.customStats.set(key, { loading: false, error: err.message, total: 0, unread: 0, sample: [] });
    }
    paintCustomRailList();
    if (state.selectedCustomRule === customId) renderCustomRuleDetail(customId);
  }

  function customRailItemHtml(r) {
    const key = `c-${r.id}`;
    const stats = state.customStats.get(key);
    const isActive = state.selectedCustomRule === r.id;
    const isEnabled = r.enabled !== 0;
    const total = stats && !stats.loading ? stats.total : null;
    const isEmpty = total === 0;
    const accent = r.accent || 'var(--accent)';

    // Build a compact filter summary (keywords preview, not raw counts)
    const filter = r.filter || {};
    const kwPreview = [
      ...(filter.subject_keywords || []),
      ...(filter.sender_keywords  || []),
    ].slice(0, 3).join(', ');
    const subtitle = r.description || kwPreview || '';

    const countStr = stats == null || stats.loading ? '…' : (stats.error ? '!' : String(stats.total));

    return `
      <button class="cln-rail-item cln-custom-item ${isActive ? 'is-active' : ''} ${isEmpty ? 'is-empty' : ''} ${!isEnabled ? 'is-disabled-rule' : ''}"
              data-custom-id="${r.id}" type="button" role="tab" aria-selected="${isActive}">
        <span class="cln-rail-icn" style="background:color-mix(in oklab,${accent} 18%,transparent);color:${accent}">
          <i data-lucide="${r.icon || 'filter'}" class="w-4 h-4"></i>
        </span>
        <span class="cln-rail-text">
          <span class="cln-rail-name">
            ${escapeHtml(r.name)}
            ${!isEnabled ? `<span class="cln-custom-off-badge">off</span>` : ''}
          </span>
          ${subtitle ? `<span class="cln-rail-desc">${escapeHtml(subtitle)}</span>` : ''}
        </span>
        <span class="cln-rail-count">${countStr}</span>
      </button>
    `;
  }

  function renderCustomRuleDetail(customId) {
    const detail = $('#cln-rules-detail');
    if (!detail) return;
    const r = state.customRules.find((x) => x.id === customId);
    if (!r) {
      detail.innerHTML = `<div class="cln-empty"><div class="cln-empty-title">${t('cleanup.custom.not_found')}</div></div>`;
      return;
    }
    const key = `c-${customId}`;
    const stats = state.customStats.get(key);
    const isBusy = state.customBusy.has(customId);
    const isEnabled = r.enabled !== 0;
    const job = state.customJobs.get(customId);
    const filter = r.filter || {};

    const actionsBtns = (r.actions || ['mark_read']).map((a, i) => {
      const isPrimary = i === 0;
      const danger = a === 'delete';
      const actLabel = a === 'delete' ? t('cleanup.act.delete') : t('cleanup.act.mark_all_read');
      const icon  = a === 'delete' ? 'trash-2' : 'mail-open';
      const empty = !isEnabled || !stats || stats.total === 0 || stats.loading;
      return `<button class="cln-rule-act ${isPrimary ? 'cln-rule-act-primary' : ''} ${danger ? 'cln-rule-act-danger' : ''}"
                      data-custom-act="${a}" ${(isBusy || empty) ? 'disabled' : ''}>
                <i data-lucide="${icon}" class="w-3.5 h-3.5"></i>${actLabel}
              </button>`;
    }).join('');

    let body = '';
    if (!isEnabled) {
      body = `<div class="cln-detail-empty cln-custom-disabled-msg">
        <i data-lucide="power-off" class="w-7 h-7"></i>
        <div>${t('cleanup.custom.disabled_msg')}</div>
        <button class="cln-rule-act cln-rule-act-primary" id="btn-custom-enable">${t('cleanup.custom.enable')}</button>
      </div>`;
    } else if (!stats || stats.loading) {
      body = `<div class="cln-detail-empty">${t('cleanup.detail.loading')}</div>`;
    } else if (stats.error) {
      body = `<div class="cln-detail-empty cln-error">${t('cleanup.detail.error', { msg: escapeHtml(stats.error) })}</div>`;
    } else if (stats.total === 0) {
      body = `<div class="cln-detail-empty">
        <div class="cln-empty-ico"><i data-lucide="check" class="w-7 h-7"></i></div>
        <div class="cln-empty-title">${t('cleanup.detail.empty_title')}</div>
        <div class="cln-empty-sub">${t('cleanup.detail.empty_sub')}</div>
      </div>`;
    } else {
      body = renderRuleDetailBody(stats);
    }

    detail.innerHTML = `
      <header class="cln-detail-head">
        <span class="cln-rule-icn cln-detail-icn"
              style="background:color-mix(in oklab, ${r.accent || 'var(--accent)'} 18%, transparent); color: ${r.accent || 'var(--accent)'}">
          <i data-lucide="${r.icon || 'filter'}" class="w-5 h-5"></i>
        </span>
        <div class="cln-detail-title">
          <div class="cln-detail-title-left">
            <h2 class="cln-detail-name">${escapeHtml(r.name)}</h2>
            ${r.description ? `<p class="cln-detail-desc">${escapeHtml(r.description)}</p>` : ''}
          </div>
        </div>
        <div class="cln-detail-actions">
          <button class="cln-rule-act" id="btn-custom-edit-detail" title="${t('cleanup.custom.edit_title')}">
            <i data-lucide="pencil" class="w-3.5 h-3.5"></i>${t('cleanup.custom.edit')}
          </button>
          <button class="cln-rule-act cln-custom-toggle-btn ${isEnabled ? 'is-enabled' : ''}"
                  id="btn-custom-toggle-detail"
                  title="${isEnabled ? t('cleanup.custom.disable_title') : t('cleanup.custom.enable_title')}">
            <i data-lucide="${isEnabled ? 'power' : 'power-off'}" class="w-3.5 h-3.5"></i>
            ${isEnabled ? t('cleanup.custom.enabled') : t('cleanup.custom.disabled')}
          </button>
          <button class="cln-rule-act cln-rule-act-danger" id="btn-custom-delete-detail" title="${t('cleanup.custom.delete_rule_title')}">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>${t('cleanup.custom.delete_rule')}
          </button>
          ${actionsBtns}
        </div>
      </header>
      <div class="cln-detail-progress" data-progress hidden>
        <div class="cln-progress-track"><div class="cln-progress-fill" style="width:0%"></div></div>
        <div class="cln-progress-meta">
          <span class="cln-progress-label">—</span>
          <span class="cln-progress-count">0 / 0</span>
        </div>
      </div>
      <div class="cln-detail-body">${body}</div>
    `;

    detail.querySelector('#btn-custom-edit-detail')?.addEventListener('click', () => openCustomPanel(r));
    detail.querySelector('#btn-custom-toggle-detail')?.addEventListener('click', () => toggleCustomRule(r.id));
    detail.querySelector('#btn-custom-delete-detail')?.addEventListener('click', () => deleteCustomRulePrompt(r.id));
    detail.querySelector('#btn-custom-enable')?.addEventListener('click', () => toggleCustomRule(r.id));
    detail.querySelectorAll('[data-custom-act]').forEach((b) => {
      b.addEventListener('click', () => runCustomRule(customId, b.dataset.customAct));
    });
    detail.querySelectorAll('.cln-prv-sender').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); viewInInbox(btn.dataset.sender); });
    });
    detail.querySelectorAll('.cln-prv-row[data-int-id]').forEach((row) => {
      const open = () => { location.hash = `#/inbox?focus=${encodeURIComponent(row.dataset.intId)}`; };
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
    if (job) renderRuleProgress(detail, job);
    window.lucide?.createIcons();
  }

  async function toggleCustomRule(customId) {
    const r = state.customRules.find((x) => x.id === customId);
    if (!r) return;
    const newEnabled = r.enabled === 0;
    try {
      await api.updateCustomRule(customId, { enabled: newEnabled });
      r.enabled = newEnabled ? 1 : 0;
      if (newEnabled) loadCustomRuleStats(customId);
      paintCustomRailList();
      if (state.selectedCustomRule === customId) renderCustomRuleDetail(customId);
    } catch (err) {
      window.toast(t('cleanup.toast.error', { msg: err.message }));
    }
  }

  async function deleteCustomRulePrompt(customId) {
    const r = state.customRules.find((x) => x.id === customId);
    if (!r) return;
    const okRule = await confirmAsync({
      title: t('cleanup.custom.delete_rule_confirm_title'),
      message: t('cleanup.custom.delete_rule_confirm_msg', { name: r.name }),
      confirmLabel: t('cleanup.custom.delete_rule'),
      danger: true,
    });
    if (!okRule) return;
    try {
      await api.deleteCustomRule(customId);
      state.customRules = state.customRules.filter((x) => x.id !== customId);
      state.customStats.delete(`c-${customId}`);
      if (state.selectedCustomRule === customId) {
        state.selectedCustomRule = null;
        const detail = $('#cln-rules-detail');
        if (detail) detail.innerHTML = '';
      }
      paintCustomRailList();
    } catch (err) {
      window.toast(t('cleanup.toast.error', { msg: err.message }));
    }
  }

  async function runCustomRule(customId, action) {
    if (state.customBusy.has(customId)) return;
    const r = state.customRules.find((x) => x.id === customId);
    const key = `c-${customId}`;
    const stats = state.customStats.get(key);
    if (!r || !stats || stats.total === 0) return;
    if (action === 'delete') {
      const ok = await confirmDelete(stats.total, r.name);
      if (!ok) return;
    }
    state.customBusy.add(customId);
    const detail = $('#cln-rules-detail');
    if (detail) detail.querySelectorAll('button').forEach((b) => (b.disabled = true));
    let res;
    try {
      res = await api.runCleanupRule(r.filter, action);
    } catch (err) {
      window.toast(t('cleanup.toast.fail', { msg: err.message }));
      state.customBusy.delete(customId);
      if (detail) detail.querySelectorAll('button').forEach((b) => (b.disabled = false));
      return;
    }
    const total = res?.total ?? 0;
    const jobId = res?.job_id;
    if (!jobId || total === 0) {
      window.toast(t('cleanup.toast.nothing_required', { n: res?.affected ?? 0 }));
      finishCustomRule(customId, action);
      return;
    }
    const job = { id: jobId, customId, action, total, done: 0, failed: 0, finished: false };
    state.customJobs.set(customId, job);
    if (detail && state.selectedCustomRule === customId) renderRuleProgress(detail, job);
    pollCustomJob(job);
  }

  async function pollCustomJob(job) {
    const tick = async () => {
      let snap;
      try { snap = await api.getCleanupJob(job.id); }
      catch (_) { state.customJobs.delete(job.customId); finishCustomRule(job.customId, job.action); return; }
      job.done = snap.done; job.failed = snap.failed; job.finished = snap.finished;
      const detail = $('#cln-rules-detail');
      if (detail && state.selectedCustomRule === job.customId) renderRuleProgress(detail, job);
      if (snap.finished) {
        window.toast(snap.failed
          ? t('cleanup.toast.job_errors', { done: snap.done, failed: snap.failed })
          : t('cleanup.toast.job_done', { done: snap.done, total: snap.total }));
        state.customJobs.delete(job.customId);
        finishCustomRule(job.customId, job.action);
        return;
      }
      setTimeout(tick, (snap.done + snap.failed) > 0 ? 600 : 1200);
    };
    tick();
  }

  function finishCustomRule(customId, _action) {
    state.customBusy.delete(customId);
    state.customStats.delete(`c-${customId}`);
    state.sendersStale = true;
    loadCustomRuleStats(customId);
    if (state.selectedCustomRule === customId) renderCustomRuleDetail(customId);
  }

  // ── Custom rule panel (template picker / create-edit form) ────────────────

  const ACCENT_PRESETS = [
    '#34D399', '#F59E0B', '#818CF8', '#F472B6', '#94A3B8',
    '#60A5FA', '#FB923C', '#4ADE80', '#E879F9', '#38BDF8',
  ];
  const ICON_PRESETS = [
    'filter', 'briefcase', 'shield-check', 'share-2', 'bell',
    'tag', 'mail', 'inbox', 'archive', 'trash-2',
    'star', 'heart', 'bookmark', 'zap', 'calendar',
    'user', 'users', 'globe', 'cpu', 'lock',
  ];

  function openCustomPanel(existingRule) {
    state.customPanel = true;
    state.customEditing = existingRule;
    const panelEl = $('#cln-custom-panel');
    const overlay = $('#cln-custom-overlay');
    if (!panelEl) return;
    if (existingRule) {
      renderCustomForm(panelEl, existingRule);
    } else {
      renderTemplateList(panelEl);
    }
    panelEl.removeAttribute('hidden');
    requestAnimationFrame(() => {
      panelEl.classList.add('is-open');
      overlay?.classList.add('is-visible');
    });
    // Clicking the overlay closes the panel
    overlay?.addEventListener('click', closeCustomPanel, { once: true });
  }

  function closeCustomPanel() {
    state.customPanel = false;
    state.customEditing = null;
    const panelEl = $('#cln-custom-panel');
    const overlay = $('#cln-custom-overlay');
    if (!panelEl) return;
    panelEl.classList.remove('is-open');
    overlay?.classList.remove('is-visible');
    // Wait for transition before hiding
    panelEl.addEventListener('transitionend', () => {
      if (!state.customPanel) panelEl.setAttribute('hidden', '');
    }, { once: true });
  }

  function renderTemplateList(panelEl) {
    panelEl.innerHTML = `
      <div class="cln-panel-head">
        <strong>${t('cleanup.tpl.choose')}</strong>
        <button class="cln-panel-close" id="btn-panel-close" title="${t('cleanup.close')}">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
      </div>
      <div class="cln-panel-body" style="padding:18px;gap:14px">
        <div class="cln-template-list">
          ${CUSTOM_TEMPLATES.map((tpl) => `
            <button class="cln-template-card" data-tpl="${escapeHtml(tpl.id)}" type="button">
              <span class="cln-template-icon" style="background:color-mix(in oklab, ${tpl.accent} 18%, transparent); color: ${tpl.accent}">
                <i data-lucide="${tpl.icon}" class="w-5 h-5"></i>
              </span>
              <span class="cln-template-info">
                <span class="cln-template-name">${escapeHtml(tpl.name)}</span>
                <span class="cln-template-desc">${escapeHtml(tpl.description)}</span>
              </span>
              <i data-lucide="chevron-right" class="w-4 h-4 cln-template-arr"></i>
            </button>
          `).join('')}
        </div>
        <div class="cln-panel-divider">${t('cleanup.tpl.or')}</div>
        <button class="cln-rule-act cln-rule-act-primary" id="btn-tpl-scratch" style="width:100%;justify-content:center">
          <i data-lucide="plus" class="w-4 h-4"></i>${t('cleanup.tpl.from_scratch')}
        </button>
      </div>
    `;
    panelEl.querySelector('#btn-panel-close')?.addEventListener('click', closeCustomPanel);
    panelEl.querySelector('#btn-tpl-scratch')?.addEventListener('click', () => renderCustomForm(panelEl, null));
    panelEl.querySelectorAll('.cln-template-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tpl = CUSTOM_TEMPLATES.find((tpl) => tpl.id === btn.dataset.tpl);
        if (tpl) renderCustomForm(panelEl, null, tpl);
      });
    });
    window.lucide?.createIcons();
  }

  function renderCustomForm(panelEl, existingRule, template = null) {
    const isEdit = !!existingRule;
    const base = existingRule || template || {};
    const filter = base.filter || {};

    const subjectKw = (filter.subject_keywords || []).join(', ');
    const senderKw  = (filter.sender_keywords  || []).join(', ');
    const maxScore  = filter.max_score   != null ? filter.max_score : '';
    const olderDays = filter.older_than_days != null ? filter.older_than_days : '';
    const cats      = filter.categories || [];

    const CAT_META = {
      important:     { label: t('cat.important'),     color: '#FCA5A5' },
      newsletter:    { label: t('cat.newsletter'),    color: '#93C5FD' },
      transactional: { label: t('cat.transactional'), color: '#86EFAC' },
      spam:          { label: t('cat.spam'),          color: '#CBD5E1' },
      other:         { label: t('cat.other'),         color: '#C4B5FD' },
    };
    const catPills = Object.entries(CAT_META).map(([c, m]) => `
      <label class="cln-cat-pill ${cats.includes(c) ? 'is-on' : ''}" style="--pill-c:${m.color}">
        <input type="checkbox" name="cat" value="${c}" ${cats.includes(c) ? 'checked' : ''} hidden>
        <span>${m.label}</span>
      </label>
    `).join('');

    const currentIcon   = base.icon   || 'filter';
    const currentAccent = base.accent  || '#818CF8';

    const iconOptions = ICON_PRESETS.map((ic) => `
      <button type="button" class="cln-icon-opt ${ic === currentIcon ? 'is-sel' : ''}" data-icon="${ic}" title="${ic}">
        <i data-lucide="${ic}" class="w-4 h-4"></i>
      </button>
    `).join('');

    const accentOptions = ACCENT_PRESETS.map((col) => `
      <button type="button" class="cln-accent-opt ${col === currentAccent ? 'is-sel' : ''}"
              data-accent="${col}" style="background:${col}" title="${col}"></button>
    `).join('');

    const defaultAction = (base.actions || ['mark_read'])[0];
    const actionButtons = [
      { v: 'mark_read', label: t('cleanup.form.action.mark_read'), icon: 'mail-open' },
      { v: 'delete',    label: t('cleanup.form.action.delete'),    icon: 'trash-2'  },
    ].map((o) => `
      <button type="button" class="cln-action-seg ${defaultAction === o.v ? 'is-on' : ''}"
              data-action="${o.v}">
        <i data-lucide="${o.icon}" class="w-3.5 h-3.5"></i>${o.label}
      </button>
    `).join('');

    panelEl.innerHTML = `
      <div class="cln-panel-head">
        <button class="cln-panel-back" id="btn-panel-back" title="${t('cleanup.back')}" style="${isEdit ? 'display:none' : ''}">
          <i data-lucide="arrow-left" class="w-4 h-4"></i>
        </button>
        <strong>${isEdit ? t('cleanup.custom.edit_title') : (template ? escapeHtml(template.name) : t('cleanup.rules.new_rule'))}</strong>
        <button class="cln-panel-close" id="btn-panel-close" title="${t('cleanup.close')}">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
      </div>

      <!-- Live preview strip -->
      <div class="cln-form-preview" id="cln-form-preview">
        <span class="cln-form-preview-icon" id="preview-icon"
              style="background:color-mix(in oklab, ${currentAccent} 18%, transparent); color:${currentAccent}">
          <i data-lucide="${currentIcon}" class="w-5 h-5"></i>
        </span>
        <span class="cln-form-preview-name" id="preview-name">${escapeHtml(base.name || t('cleanup.custom.preview_name'))}</span>
      </div>

      <div class="cln-panel-body">
        <form id="cln-custom-form" autocomplete="off">

          <!-- Identité -->
          <div class="cln-form-group">
            <div class="cln-form-group-title">${t('cleanup.form.identity')}</div>

            <label class="cln-form-label">
              <span>${t('cleanup.form.name')}</span>
              <input type="text" name="name" class="cln-form-input" maxlength="60" id="input-rule-name"
                     value="${escapeHtml(base.name || '')}" placeholder="${t('cleanup.form.name_ph')}" required>
            </label>

            <label class="cln-form-label">
              <span>${t('cleanup.form.description')} <span class="cln-form-opt">· ${t('cleanup.form.optional')}</span></span>
              <input type="text" name="description" class="cln-form-input" maxlength="120"
                     value="${escapeHtml(base.description || '')}" placeholder="${t('cleanup.form.description_ph')}">
            </label>

            <div class="cln-form-label"><span>${t('cleanup.form.icon')}</span>
              <div class="cln-icon-grid" id="cln-icon-grid">${iconOptions}</div>
              <input type="hidden" name="icon" value="${escapeHtml(currentIcon)}">
            </div>

            <div class="cln-form-label"><span>${t('cleanup.form.color')}</span>
              <div class="cln-accent-grid" id="cln-accent-grid">${accentOptions}</div>
              <input type="hidden" name="accent" value="${escapeHtml(currentAccent)}">
            </div>
          </div>

          <!-- Filtres -->
          <div class="cln-form-group">
            <div class="cln-form-group-title">${t('cleanup.form.filters')} <span class="cln-form-opt">· ${t('cleanup.form.filters_hint')}</span></div>

            <label class="cln-form-label">
              <span>${t('cleanup.form.subject_kw')} <span class="cln-form-opt">· ${t('cleanup.form.kw_hint')}</span></span>
              <div class="cln-kw-wrap">
                <i data-lucide="type" class="w-3.5 h-3.5 cln-kw-icon"></i>
                <input type="text" name="subject_keywords" class="cln-form-input cln-kw-input"
                       value="${escapeHtml(subjectKw)}"
                       placeholder="${t('cleanup.form.subject_kw_ph')}">
              </div>
            </label>

            <label class="cln-form-label">
              <span>${t('cleanup.form.sender_kw')} <span class="cln-form-opt">· ${t('cleanup.form.sender_kw_hint')}</span></span>
              <div class="cln-kw-wrap">
                <i data-lucide="at-sign" class="w-3.5 h-3.5 cln-kw-icon"></i>
                <input type="text" name="sender_keywords" class="cln-form-input cln-kw-input"
                       value="${escapeHtml(senderKw)}"
                       placeholder="${t('cleanup.form.sender_kw_ph')}">
              </div>
            </label>

            <div class="cln-form-label">
              <span>${t('cleanup.form.categories')}</span>
              <div class="cln-cat-pills">${catPills}</div>
            </div>

            <div class="cln-form-row-2">
              <label class="cln-form-label">
                <span>${t('cleanup.form.max_score')} <span class="cln-form-opt">/ 10</span></span>
                <input type="number" name="max_score" class="cln-form-input" min="1" max="10"
                       value="${maxScore}" placeholder="—">
              </label>
              <label class="cln-form-label">
                <span>${t('cleanup.form.older_than')} <span class="cln-form-opt">· ${t('cleanup.form.days')}</span></span>
                <input type="number" name="older_than_days" class="cln-form-input" min="1"
                       value="${olderDays}" placeholder="—">
              </label>
            </div>

            <label class="cln-form-toggle-row">
              <span>${t('cleanup.form.unread_only')}</span>
              <span class="cln-form-toggle ${filter.is_read === false ? 'is-on' : ''}" id="toggle-unread-only">
                <span class="cln-toggle-knob"></span>
              </span>
              <input type="hidden" name="is_unread_only" id="input-unread-only"
                     value="${filter.is_read === false ? 'on' : 'off'}">
            </label>
          </div>

          <!-- Action -->
          <div class="cln-form-group">
            <div class="cln-form-group-title">${t('cleanup.form.default_action')}</div>
            <div class="cln-action-seg-wrap" id="cln-action-seg">
              ${actionButtons}
            </div>
            <input type="hidden" name="default_action" id="input-default-action" value="${defaultAction}">
          </div>

          <!-- Footer -->
          <div class="cln-form-footer">
            ${isEdit ? `<button type="button" class="cln-form-btn-del" id="btn-form-delete">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>${t('cleanup.custom.delete_rule')}
            </button>` : ''}
            <button type="submit" class="cln-rule-act cln-rule-act-primary cln-form-submit">
              <i data-lucide="${isEdit ? 'check' : 'plus'}" class="w-3.5 h-3.5"></i>
              ${isEdit ? t('set.save') : t('cleanup.form.create')}
            </button>
          </div>
        </form>
      </div>
    `;

    panelEl.querySelector('#btn-panel-close')?.addEventListener('click', closeCustomPanel);
    panelEl.querySelector('#btn-panel-back')?.addEventListener('click', () => renderTemplateList(panelEl));

    // Live preview: name
    const nameInput = panelEl.querySelector('#input-rule-name');
    const previewName = panelEl.querySelector('#preview-name');
    nameInput?.addEventListener('input', () => {
      if (previewName) previewName.textContent = nameInput.value.trim() || t('cleanup.form.name_ph');
    });

    // Icon picker + live preview
    const iconGrid = panelEl.querySelector('#cln-icon-grid');
    const iconInput = panelEl.querySelector('input[name="icon"]');
    const previewIconEl = panelEl.querySelector('#preview-icon');
    iconGrid?.querySelectorAll('.cln-icon-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        iconGrid.querySelectorAll('.cln-icon-opt').forEach((b) => b.classList.remove('is-sel'));
        btn.classList.add('is-sel');
        if (iconInput) iconInput.value = btn.dataset.icon;
        if (previewIconEl) {
          previewIconEl.innerHTML = `<i data-lucide="${btn.dataset.icon}" class="w-5 h-5"></i>`;
          window.lucide?.createIcons({ el: previewIconEl });
        }
      });
    });

    // Accent picker + live preview
    const accentGrid = panelEl.querySelector('#cln-accent-grid');
    const accentInput = panelEl.querySelector('input[name="accent"]');
    accentGrid?.querySelectorAll('.cln-accent-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        accentGrid.querySelectorAll('.cln-accent-opt').forEach((b) => b.classList.remove('is-sel'));
        btn.classList.add('is-sel');
        if (accentInput) accentInput.value = btn.dataset.accent;
        if (previewIconEl) {
          previewIconEl.style.background = `color-mix(in oklab, ${btn.dataset.accent} 18%, transparent)`;
          previewIconEl.style.color = btn.dataset.accent;
        }
      });
    });

    // Category pills
    panelEl.querySelectorAll('.cln-cat-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        const cb = pill.querySelector('input[type=checkbox]');
        if (!cb) return;
        cb.checked = !cb.checked;
        pill.classList.toggle('is-on', cb.checked);
      });
    });

    // Toggle "Non lus uniquement"
    const toggleEl = panelEl.querySelector('#toggle-unread-only');
    const toggleInput = panelEl.querySelector('#input-unread-only');
    toggleEl?.addEventListener('click', () => {
      const isOn = toggleEl.classList.toggle('is-on');
      if (toggleInput) toggleInput.value = isOn ? 'on' : 'off';
    });

    // Action segmented buttons
    const actionSeg = panelEl.querySelector('#cln-action-seg');
    const actionInput = panelEl.querySelector('#input-default-action');
    actionSeg?.querySelectorAll('.cln-action-seg').forEach((btn) => {
      btn.addEventListener('click', () => {
        actionSeg.querySelectorAll('.cln-action-seg').forEach((b) => b.classList.remove('is-on'));
        btn.classList.add('is-on');
        if (actionInput) actionInput.value = btn.dataset.action;
      });
    });

    // Delete (edit mode)
    panelEl.querySelector('#btn-form-delete')?.addEventListener('click', () => {
      if (!existingRule) return;
      closeCustomPanel();
      deleteCustomRulePrompt(existingRule.id);
    });

    // Form submit
    panelEl.querySelector('#cln-custom-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const name = fd.get('name')?.toString().trim() || t('cleanup.form.no_title');
      const description = fd.get('description')?.toString().trim() || '';
      const icon   = fd.get('icon')?.toString()   || 'filter';
      const accent = fd.get('accent')?.toString() || 'var(--accent)';
      const defaultAction = fd.get('default_action')?.toString() || 'mark_read';

      const builtFilter = {};
      const subjectKwVal = fd.get('subject_keywords')?.toString().trim() || '';
      const senderKwVal  = fd.get('sender_keywords')?.toString().trim() || '';
      const maxScoreVal  = fd.get('max_score')?.toString().trim() || '';
      const olderDaysVal = fd.get('older_than_days')?.toString().trim() || '';
      const isUnreadOnly = fd.get('is_unread_only') === 'on';

      const catsSelected = [...e.target.querySelectorAll('input[name="cat"]:checked')].map((el) => el.value);
      if (catsSelected.length) builtFilter.categories = catsSelected;
      if (subjectKwVal) builtFilter.subject_keywords = subjectKwVal.split(',').map((s) => s.trim()).filter(Boolean);
      if (senderKwVal)  builtFilter.sender_keywords  = senderKwVal.split(',').map((s) => s.trim()).filter(Boolean);
      if (maxScoreVal)  builtFilter.max_score = parseInt(maxScoreVal, 10);
      if (olderDaysVal) builtFilter.older_than_days = parseInt(olderDaysVal, 10);
      if (isUnreadOnly) builtFilter.is_read = false;

      const body = { name, description, icon, accent, filter: builtFilter, actions: [defaultAction] };

      const submitBtn = e.target.querySelector('[type=submit]');
      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = isEdit ? t('set.busy.saving') : t('cleanup.form.creating'); }
      try {
        if (isEdit) {
          await api.updateCustomRule(existingRule.id, body);
          const idx = state.customRules.findIndex((r) => r.id === existingRule.id);
          if (idx >= 0) {
            state.customRules[idx] = { ...state.customRules[idx], ...body, enabled: state.customRules[idx].enabled };
            state.customStats.delete(`c-${existingRule.id}`);
            loadCustomRuleStats(existingRule.id);
          }
        } else {
          const created = await api.createCustomRule(body);
          const newRule = {
            ...created,
            filter: typeof created.filter_json === 'string' ? JSON.parse(created.filter_json || '{}') : (created.filter_json || builtFilter),
            actions: typeof created.actions_json === 'string' ? JSON.parse(created.actions_json || '["mark_read"]') : (created.actions_json || [defaultAction]),
          };
          state.customRules.push(newRule);
          loadCustomRuleStats(newRule.id);
          state.selectedCustomRule = newRule.id;
        }
        paintCustomRailList();
        closeCustomPanel();
        if (state.selectedCustomRule != null) renderCustomRuleDetail(state.selectedCustomRule);
        window.toast(isEdit ? t('cleanup.toast.rule_updated') : t('cleanup.toast.rule_created'));
      } catch (err) {
        window.toast(t('cleanup.toast.error', { msg: err.message }));
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = `<i data-lucide="${isEdit ? 'check' : 'plus'}" class="w-3.5 h-3.5"></i>${isEdit ? t('set.save') : t('cleanup.form.create')}`; window.lucide?.createIcons({ el: submitBtn }); }
      }
    });

    window.lucide?.createIcons();
  }

  // ── Unsubscribe tab (master-detail layout, mirrors Rules) ───
  function renderUnsubscribePane() {
    const pane = $('#cln-pane');
    pane.innerHTML = `
      <div class="cln-unsub-status" id="cln-unsub-status">${t('cleanup.loading')}</div>
      <div class="cln-rules-layout">
        <aside class="cln-rules-rail" aria-label="${t('cleanup.unsub.rail_aria')}">
          <div class="cln-rules-rail-head">${t('cleanup.unsub.rail_head')}</div>
          <div class="cln-rules-rail-list" id="cln-unsub-rail"></div>
        </aside>
        <section class="cln-rules-detail" id="cln-unsub-detail" aria-live="polite"></section>
      </div>
    `;
    paintUnsubStatus();
    renderUnsubRail();
    if (state.selectedUnsub) renderUnsubDetail(state.selectedUnsub);
    // Lazy load on first visit
    if (state.unsubStats == null) loadUnsubStats();
    if (state.unsubSenders.length === 0) loadUnsubSenders();
  }

  function paintUnsubStatus() {
    const el = $('#cln-unsub-status');
    if (!el) return;
    const s = state.unsubStats;
    const job = state.backfillJob;

    if (job && !job.finished) {
      const pct = job.total ? ((job.done + job.failed) / job.total * 100).toFixed(1) : 0;
      el.innerHTML = `
        <div class="cln-unsub-status-row">
          <i data-lucide="refresh-cw" class="w-4 h-4" style="animation: spin 1s linear infinite"></i>
          <span><strong>${t('cleanup.unsub.reanalyzing')}</strong> ${job.done + job.failed} / ${job.total} ${t('cleanup.unsub.headers')}</span>
        </div>
        <div class="cln-progress-track" style="height:4px;margin-top:6px">
          <div class="cln-progress-fill" style="width:${pct}%"></div>
        </div>
      `;
      window.lucide?.createIcons();
      return;
    }

    if (!s) { el.textContent = t('cleanup.loading'); return; }

    const linkN = s.senders_with_link || 0;
    const haveN = s.with_header || 0;
    const missN = s.without_header || 0;
    const lastBackfill = s.last_backfill_at;

    // Bulk-eligible = senders with one-click that aren't already unsubscribed.
    const bulkEligible = state.unsubSenders.filter(
      (x) => x.has_one_click && !x.unsubscribed_at,
    );

    let banner = '';
    if (!lastBackfill && missN > 0 && haveN === 0 && linkN === 0) {
      banner = `
        <div class="cln-unsub-banner">
          <i data-lucide="info" class="w-4 h-4"></i>
          <span>${t('cleanup.unsub.no_links_yet')}</span>
        </div>`;
    }

    const btnLabel =
      missN === 0   ? t('cleanup.unsub.btn_up_to_date') :
      !lastBackfill ? t('cleanup.unsub.btn_analyze') :
                      t('cleanup.unsub.btn_refresh');

    el.innerHTML = `
      ${banner}
      <div class="cln-unsub-status-row">
        <span class="cln-unsub-stat"><strong>${linkN}</strong> ${t('cleanup.unsub.senders_with_link', { n: linkN })}</span>
        <span class="cln-unsub-stat-muted">·</span>
        <span class="cln-unsub-stat"><strong>${haveN}</strong> ${t('cleanup.unsub.inspected', { n: haveN })}</span>
        ${missN > 0 ? `<span class="cln-unsub-stat-muted">·</span><span class="cln-unsub-stat cln-unsub-stat-warn"><strong>${missN}</strong> ${t('cleanup.unsub.not_analyzed', { n: missN })}</span>` : ''}
        <button class="cln-unsub-backfill" id="btn-backfill" ${missN === 0 ? 'disabled' : ''} style="margin-left:auto">
          <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i>
          ${btnLabel}
        </button>
      </div>
    `;
    $('#btn-backfill')?.addEventListener('click', () => runBackfill());
    window.lucide?.createIcons();
  }

  async function runBulkUnsubscribe() {
    const eligible = state.unsubSenders.filter(
      (x) => x.has_one_click && !x.unsubscribed_at,
    );
    if (eligible.length === 0) return;
    const ok = await confirmAsync({
      title: t('cleanup.unsub.bulk_confirm_title'),
      message: t('cleanup.unsub.bulk_confirm_msg', { n: eligible.length }),
      confirmLabel: t('cleanup.unsub.unsubscribe'),
      danger: false,
    });
    if (!ok) return;

    let res;
    try {
      res = await api.unsubscribeBulk({
        senders: eligible.map((s) => s.email),
        purge: false,
      });
    } catch (err) {
      window.toast(t('cleanup.toast.fail', { msg: err.message }));
      return;
    }
    if (!res.job_id || res.total === 0) {
      window.toast(t('cleanup.unsub.nothing'));
      return;
    }

    // Reuse the backfill progress slot for the bulk job — same status row.
    state.backfillJob = {
      id: res.job_id,
      total: res.total,
      done: 0,
      failed: 0,
      finished: false,
      bulk: true,
    };
    paintUnsubStatus();
    pollBulkUnsubJob();
  }

  async function pollBulkUnsubJob() {
    const tick = async () => {
      let snap;
      try { snap = await api.getCleanupJob(state.backfillJob.id); }
      catch (_) {
        state.backfillJob = null;
        await loadUnsubSenders();
        await loadUnsubStats();
        paintUnsubStatus();
        return;
      }
      Object.assign(state.backfillJob, {
        done: snap.done, failed: snap.failed, finished: snap.finished, total: snap.total,
      });
      paintUnsubStatus();
      if (snap.finished) {
        window.toast(snap.failed
          ? t('cleanup.unsub.bulk_done_errors', { done: snap.done, failed: snap.failed })
          : t('cleanup.unsub.bulk_done', { done: snap.done, total: snap.total }));
        state.backfillJob = null;
        await loadUnsubSenders();
        await loadUnsubStats();
        paintUnsubStatus();
        return;
      }
      const delay = (snap.done + snap.failed) > 0 ? 800 : 1500;
      setTimeout(tick, delay);
    };
    tick();
  }

  function renderUnsubRail() {
    const rail = $('#cln-unsub-rail');
    if (!rail) return;

    if (state.unsubSenders.length === 0) {
      rail.innerHTML = `
        <div class="cln-empty" style="padding:24px 12px;text-align:center;font-size:12.5px;color:var(--muted)">
          ${state.unsubStats == null ? t('cleanup.loading') : t('cleanup.unsub.no_senders')}
        </div>`;
      return;
    }

    rail.innerHTML = state.unsubSenders.map((s) => unsubRailItemHtml(s)).join('');
    rail.querySelectorAll('.cln-rail-item').forEach((el) => {
      el.addEventListener('click', () => selectUnsub(el.dataset.email));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectUnsub(el.dataset.email);
        }
      });
    });
    window.lucide?.createIcons();
  }

  function unsubModeIcon(s) {
    if (s.has_one_click) return { icon: 'zap', label: t('cleanup.unsub.mode.oneclick'), className: 'mode-oneclick' };
    if (s.http_url)      return { icon: 'globe', label: t('cleanup.unsub.mode.web'), className: 'mode-http' };
    if (s.mailto)        return { icon: 'mail', label: t('cleanup.unsub.mode.email'), className: 'mode-mailto' };
    return { icon: 'help-circle', label: '?', className: '' };
  }

  function unsubRailItemHtml(s) {
    const isActive = state.selectedUnsub === s.email;
    const isBusy = state.unsubBusy.has(s.email);
    const mode = unsubModeIcon(s);
    const ini = initials(s.name || s.email);
    const col = avatarColor(s.email);
    const img = avatarImgHtml(s.email, 22);
    const done = !!s.unsubscribed_at;
    return `
      <button class="cln-rail-item cln-unsub-item ${isActive ? 'is-active' : ''} ${done ? 'is-done' : ''} ${isBusy ? 'is-busy' : ''}"
              data-email="${escapeHtml(s.email)}" type="button" role="tab" aria-selected="${isActive}">
        <span class="cln-unsub-av" style="background:${col}">
          <span class="av-text">${escapeHtml(ini)}</span>
          ${img}
        </span>
        <span class="cln-rail-text">
          <span class="cln-rail-name">${escapeHtml(s.name || s.email)}</span>
          <span class="cln-rail-desc">${escapeHtml(s.email)}</span>
        </span>
        <span class="cln-unsub-mode ${mode.className}" title="${escapeHtml(mode.label)}">
          ${done
            ? `<i data-lucide="check" class="w-3.5 h-3.5"></i>`
            : `<i data-lucide="${mode.icon}" class="w-3.5 h-3.5"></i>`}
        </span>
        <span class="cln-rail-count">${s.total}</span>
      </button>
    `;
  }

  function selectUnsub(email) {
    if (!state.unsubSenders.some((s) => s.email === email)) return;
    if (state.selectedUnsub === email) return;
    state.selectedUnsub = email;
    $('#cln-unsub-rail')?.querySelectorAll('.cln-rail-item').forEach((el) => {
      const on = el.dataset.email === email;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderUnsubDetail(email);
  }

  function renderUnsubDetail(email) {
    const detail = $('#cln-unsub-detail');
    if (!detail) return;
    const s = state.unsubSenders.find((x) => x.email === email);
    if (!s) {
      detail.innerHTML = `<div class="cln-empty"><div class="cln-empty-title">${t('cleanup.unsub.none_selected')}</div></div>`;
      return;
    }

    const isBusy = state.unsubBusy.has(email);
    const job = state.unsubJobs.get(email);
    const done = !!s.unsubscribed_at;
    const mode = unsubModeIcon(s);
    const ini = initials(s.name || s.email);
    const col = avatarColor(s.email);
    const img = avatarImgHtml(s.email, 44);

    // Primary button label depends on capability + already-done state
    let primaryLabel, primaryIcon, primaryAction;
    if (done) {
      primaryLabel = t('cleanup.unsub.re_unsub'); primaryIcon = 'refresh-cw'; primaryAction = 'auto-force';
    } else if (s.has_one_click) {
      primaryLabel = t('cleanup.unsub.unsubscribe'); primaryIcon = 'zap'; primaryAction = 'auto';
    } else if (s.http_url) {
      primaryLabel = t('cleanup.unsub.open_page'); primaryIcon = 'external-link'; primaryAction = 'http_only';
    } else if (s.mailto) {
      primaryLabel = t('cleanup.unsub.send_email'); primaryIcon = 'mail'; primaryAction = 'mailto_only';
    } else {
      primaryLabel = t('cleanup.unsub.no_link'); primaryIcon = 'x'; primaryAction = null;
    }

    const purgeChecked = state.unsubPurge ? 'checked' : '';

    const header = `
      <header class="cln-detail-head">
        <span class="cln-unsub-av" style="background:${col};width:44px;height:44px;font-size:14px">
          <span class="av-text">${escapeHtml(ini)}</span>
          ${img}
        </span>
        <div class="cln-detail-titles">
          <h2 class="cln-detail-name">${escapeHtml(s.name || s.email)}</h2>
          <p class="cln-detail-desc cln-unsub-recip-row">
            <i data-lucide="at-sign" class="w-3 h-3"></i>
            ${escapeHtml(s.email)}
            <span class="cln-unsub-chip ${mode.className}">
              <i data-lucide="${mode.icon}" class="w-3 h-3"></i>${escapeHtml(mode.label)}
            </span>
            ${done ? `<span class="cln-unsub-chip-done"><i data-lucide="check" class="w-3 h-3"></i>${t('cleanup.unsub.done_date', { date: escapeHtml(shortDate(s.unsubscribed_at)) })}</span>` : ''}
          </p>
          ${(s.accounts || []).length > 0 ? `
          <p class="cln-detail-desc cln-unsub-recip-row">
            <i data-lucide="inbox" class="w-3 h-3"></i>
            ${s.accounts.join(', ')}
          </p>` : ''}
        </div>
        <div class="cln-detail-actions">
          ${primaryAction ? `
            <button class="cln-rule-act cln-rule-act-primary" data-unsub-act="${primaryAction}" ${(isBusy || (done && primaryAction !== 'auto-force')) ? 'disabled' : ''}>
              <i data-lucide="${primaryIcon}" class="w-3.5 h-3.5"></i>${primaryLabel}
            </button>` : ''}
          ${s.http_url && primaryAction !== 'http_only' ? `
            <button class="cln-rule-act" data-unsub-act="http_only" ${isBusy ? 'disabled' : ''}>
              <i data-lucide="globe" class="w-3.5 h-3.5"></i>${t('cleanup.unsub.web_page')}
            </button>` : ''}
          ${s.mailto && primaryAction !== 'mailto_only' ? `
            <button class="cln-rule-act" data-unsub-act="mailto_only" ${isBusy ? 'disabled' : ''}>
              <i data-lucide="mail" class="w-3.5 h-3.5"></i>${t('cleanup.unsub.email_btn')}
            </button>` : ''}
        </div>
      </header>
    `;

    // Friendly explainer per mode — show just the domain/address, never
    // the raw URL. Tracking links can be 200+ chars and they're noise
    // for non-technical users.
    const httpDomain = (() => {
      if (!s.http_url) return null;
      try { return new URL(s.http_url).host.replace(/^www\./, ''); }
      catch (_) { return s.http_url; }
    })();
    let explainer = '';
    if (s.has_one_click && httpDomain) {
      explainer = t('cleanup.unsub.explainer.oneclick', { domain: escapeHtml(httpDomain) });
    } else if (httpDomain) {
      explainer = t('cleanup.unsub.explainer.http', { domain: escapeHtml(httpDomain) });
    } else if (s.mailto) {
      explainer = t('cleanup.unsub.explainer.mailto', { address: escapeHtml(s.mailto.split('?')[0]) });
    }

    const accountsLine = (s.accounts || []).length > 1
      ? `<span class="cln-detail-desc" style="display:block;margin-top:4px">
          ${t('cleanup.unsub.received_on', { n: s.accounts.length })} ${
            s.accounts.map((a) => `<span class="cln-prv-chip">${escapeHtml(a.split('@')[0])}</span>`).join(' ')
          }
        </span>`
      : '';

    const body = `
      <div class="cln-unsub-kpis">
        <div class="cln-unsub-kpi">
          <span class="cln-unsub-kpi-val">${s.total}</span>
          <span class="cln-unsub-kpi-lbl">${t('cleanup.unsub.kpi.emails')}</span>
        </div>
        <div class="cln-unsub-kpi">
          <span class="cln-unsub-kpi-val">${s.unread}</span>
          <span class="cln-unsub-kpi-lbl">${t('cleanup.unsub.kpi.unread')}</span>
        </div>
        <div class="cln-unsub-kpi">
          <span class="cln-unsub-kpi-val">${escapeHtml(shortDate(s.last_seen))}</span>
          <span class="cln-unsub-kpi-lbl">${t('cleanup.unsub.kpi.last_received')}</span>
        </div>
        ${(s.accounts || []).length > 1 ? `
        <div class="cln-unsub-kpi">
          <span class="cln-unsub-kpi-val">${s.accounts.length}</span>
          <span class="cln-unsub-kpi-lbl">${t('cleanup.unsub.kpi.accounts')}</span>
        </div>` : ''}
      </div>

      <div class="cln-unsub-mails-section">
        <div class="cln-unsub-mails-head">
          <i data-lucide="mails" class="w-3.5 h-3.5"></i>
          <span>${t('cleanup.unsub.mails_head')}</span>
        </div>
        <div class="cln-unsub-mails-list" id="cln-unsub-mails-list">
          <div class="cln-unsub-mails-loading">
            <i data-lucide="loader" class="w-3.5 h-3.5" style="animation:spin 1s linear infinite"></i>
            ${t('cleanup.loading')}
          </div>
        </div>
      </div>
    `;

    detail.innerHTML = `
      ${header}
      <div class="cln-detail-progress" data-progress hidden>
        <div class="cln-progress-track"><div class="cln-progress-fill" style="width:0%"></div></div>
        <div class="cln-progress-meta">
          <span class="cln-progress-label">—</span>
          <span class="cln-progress-count">0 / 0</span>
        </div>
      </div>
      <div class="cln-detail-body">${body}</div>
    `;

    detail.querySelectorAll('[data-unsub-act]').forEach((b) => {
      b.addEventListener('click', () => showUnsubModal(email, b.dataset.unsubAct));
    });

    if (job) renderUnsubProgress(detail, job);
    window.lucide?.createIcons();

    // Load email samples asynchronously
    loadUnsubMailList(email);
  }

  async function loadUnsubMailList(email) {
    const listEl = document.getElementById('cln-unsub-mails-list');
    if (!listEl) return;
    let emails = [];
    try {
      emails = await api.getEmails({ sender: email, limit: 50 });
    } catch (_) { /* ignore */ }

    if (!listEl.isConnected) return;

    if (emails.length === 0) {
      listEl.innerHTML = `<div class="cln-unsub-mails-empty">${(window.t||((k)=>k))('cleanup.unsub.no_mails')}</div>`;
      return;
    }

    listEl.innerHTML = emails.map((em) => {
      const subj = escapeHtml(em.subject || (window.t||((k)=>k))('cleanup.no_subject'));
      const dt   = escapeHtml(shortDate(em.date_received));
      const read = em.is_read ? '' : 'is-unread';
      const score = em.importance_score != null ? em.importance_score : '—';
      const scoreClass = em.importance_score >= 7 ? 'score-hi' : em.importance_score >= 4 ? 'score-mid' : 'score-lo';
      return `
        <div class="cln-unsub-mail-row ${read}" data-id="${em.id}" role="button" tabindex="0">
          <span class="cln-unsub-mail-score ${scoreClass}">${score}</span>
          <span class="cln-unsub-mail-subj">${subj}</span>
          <span class="cln-unsub-mail-date">${dt}</span>
        </div>`;
    }).join('');

    listEl.querySelectorAll('.cln-unsub-mail-row').forEach((row) => {
      const open = () => opts.onRouteChange(`#/inbox?id=${row.dataset.id}`);
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  // ── Unsubscribe data loading ────────────────────────────
  async function loadUnsubStats() {
    try {
      state.unsubStats = await api.getUnsubscribeStats();
    } catch (err) {
      state.unsubStats = { with_header: 0, without_header: 0, senders_with_link: 0, last_backfill_at: null, error: err.message };
    }
    if (state.tab === 'unsubscribe') paintUnsubStatus();
  }

  async function loadUnsubSenders() {
    try {
      state.unsubSenders = await api.getUnsubscribeSenders();
    } catch (_) {
      state.unsubSenders = [];
    }
    // Honour a pending deep-link selection (e.g. dashboard's "Désabonnement
    // express" card sends ?tab=unsubscribe&sender=email). Done here, after
    // the rail data is in, because selectUnsub() refuses unknown emails.
    if (state.pendingUnsub) {
      const want = state.pendingUnsub.toLowerCase();
      const match = state.unsubSenders.find((s) => (s.email || '').toLowerCase() === want);
      state.pendingUnsub = null;
      if (match) state.selectedUnsub = match.email;
    }
    if (state.tab === 'unsubscribe') {
      renderUnsubRail();
      if (state.selectedUnsub) {
        renderUnsubDetail(state.selectedUnsub);
        // Scroll the freshly-selected sender into view (deep-link case).
        const item = $(`.cln-rail-item[data-email="${state.selectedUnsub.replace(/"/g, '\\"')}"]`);
        item?.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  // ── Backfill flow ───────────────────────────────────────
  async function runBackfill() {
    if (state.backfillJob) return;
    let res;
    try {
      res = await api.runHeaderBackfill();
    } catch (err) {
      window.toast(t('cleanup.toast.fail', { msg: err.message }));
      return;
    }
    if (!res.job_id) {
      window.toast(t('cleanup.backfill.toast.uptodate'));
      await loadUnsubStats();
      paintUnsubStatus();
      return;
    }
    state.backfillJob = { id: res.job_id, total: res.total, done: 0, failed: 0, finished: false };
    paintUnsubStatus();
    pollBackfillJob();
  }

  async function pollBackfillJob() {
    const tick = async () => {
      let snap;
      try { snap = await api.getCleanupJob(state.backfillJob.id); }
      catch (_) {
        state.backfillJob = null;
        await loadUnsubStats();
        await loadUnsubSenders();
        paintUnsubStatus();
        return;
      }
      Object.assign(state.backfillJob, {
        done: snap.done, failed: snap.failed, finished: snap.finished, total: snap.total,
      });
      paintUnsubStatus();
      if (snap.finished) {
        const verb = snap.failed
          ? t('cleanup.backfill.toast.partial', { done: snap.done, fail: snap.failed })
          : t('cleanup.backfill.toast.done', { done: snap.done, total: snap.total });
        window.toast(verb);
        state.backfillJob = null;
        await loadUnsubStats();
        await loadUnsubSenders();
        paintUnsubStatus();
        return;
      }
      const delay = (snap.done + snap.failed) > 0 ? 600 : 1200;
      setTimeout(tick, delay);
    };
    tick();
  }

  // ── Unsubscribe confirm modal ───────────────────────────
  function showUnsubModal(email, mode) {
    const s = state.unsubSenders.find((x) => x.email === email);
    if (!s) return;

    const modal    = document.getElementById('unsub-modal');
    const avEl     = document.getElementById('unsub-modal-av');
    const titleEl  = document.getElementById('unsub-modal-title');
    const emailEl  = document.getElementById('unsub-modal-email');
    const descEl   = document.getElementById('unsub-modal-desc');
    const purgeLbl = document.getElementById('unsub-modal-purge-label');
    const purgeCb  = document.getElementById('unsub-modal-purge-cb');
    const purgeText= document.getElementById('unsub-modal-purge-text');
    const cancelBtn= document.getElementById('unsub-modal-cancel');
    const confirmBtn = document.getElementById('unsub-modal-confirm');
    const confirmLbl = document.getElementById('unsub-modal-confirm-label');
    const iconEl   = document.getElementById('unsub-modal-icon');
    if (!modal) return;

    // Avatar
    const col = avatarColor(s.email);
    const ini = initials(s.name || s.email);
    const img = avatarImgHtml(s.email, 40);
    avEl.style.background = col;
    avEl.innerHTML = `<span class="av-text">${escapeHtml(ini)}</span>${img}`;

    titleEl.textContent  = s.name || s.email;
    emailEl.textContent  = s.email;

    // Explainer
    const httpDomain = (() => {
      if (!s.http_url) return null;
      try { return new URL(s.http_url).host.replace(/^www\./, ''); }
      catch (_) { return s.http_url; }
    })();
    if (mode === 'auto' || mode === 'auto-force') {
      descEl.textContent = s.has_one_click && httpDomain
        ? t('cleanup.unsub.modal.desc_oneclick', { domain: httpDomain })
        : httpDomain
          ? t('cleanup.unsub.modal.desc_http', { domain: httpDomain })
          : s.mailto ? t('cleanup.unsub.modal.desc_mailto') : '';
    } else if (mode === 'http_only') {
      descEl.textContent = t('cleanup.unsub.modal.desc_http_only');
    } else {
      descEl.textContent = t('cleanup.unsub.modal.desc_mailto_only');
    }

    // Purge option
    purgeText.innerHTML = t('cleanup.unsub.modal.purge_html', { n: s.total });
    purgeCb.checked = state.unsubPurge;
    purgeLbl.style.display = '';

    // Confirm button label/icon
    const modeIcon = mode === 'http_only' ? 'globe' : mode === 'mailto_only' ? 'mail' : 'zap';
    iconEl.setAttribute('data-lucide', modeIcon);
    confirmLbl.textContent = t('cleanup.unsub.unsubscribe');

    // Show
    modal.hidden = false;
    window.lucide?.createIcons({ nodes: [avEl, iconEl] });

    // Trap focus
    confirmBtn.focus();

    const close = () => { modal.hidden = true; cleanup(); };

    const onConfirm = () => {
      state.unsubPurge = purgeCb.checked;
      close();
      runUnsubscribe(email, mode);
    };
    const onCancel  = () => close();
    const onBackdrop = (e) => { if (e.target === modal) close(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };

    confirmBtn.addEventListener('click', onConfirm, { once: true });
    cancelBtn.addEventListener('click', onCancel, { once: true });
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);

    function cleanup() {
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
    }
  }

  // ── Single-sender unsubscribe ───────────────────────────
  async function runUnsubscribe(email, mode) {
    if (state.unsubBusy.has(email)) return;
    const sender = state.unsubSenders.find((s) => s.email === email);
    if (!sender) return;

    state.unsubBusy.add(email);
    const detail = $('#cln-unsub-detail');
    if (detail) detail.querySelectorAll('button').forEach((b) => (b.disabled = true));

    let res;
    try {
      const force = mode === 'auto-force';
      const realMode = force ? 'auto' : mode;
      res = await api.unsubscribeSender({
        sender: email,
        mode: realMode,
        purge: state.unsubPurge,
        force,
      });
    } catch (err) {
      window.toast(t('cleanup.toast.fail', { msg: err.message }));
      state.unsubBusy.delete(email);
      if (detail) detail.querySelectorAll('button').forEach((b) => (b.disabled = false));
      return;
    }

    // Server says "open this URL/mailto in a tab".
    if (res.action_required === 'open_url') {
      window.open(res.target, '_blank', 'noopener,noreferrer');
      window.toast(t('cleanup.unsub.toast.page_opened'));
      // We can't know if the user really clicked unsubscribe — flag visually
      // but don't stamp `unsubscribed_at` server-side (the user may abort).
      finishUnsub(email, false);
      return;
    }
    if (res.action_required === 'open_mailto') {
      window.open(`mailto:${res.target}`, '_blank');
      window.toast(t('cleanup.unsub.toast.mail_opened'));
      finishUnsub(email, false);
      return;
    }

    if (res.already && !res.job_id) {
      window.toast(t('cleanup.unsub.toast.already'));
      finishUnsub(email, true);
      return;
    }

    if (!res.job_id || res.total === 0) {
      window.toast(t('cleanup.unsub.toast.done'));
      finishUnsub(email, true);
      return;
    }

    const job = {
      id: res.job_id,
      sender: email,
      total: res.total,
      done: 0,
      failed: 0,
      finished: false,
    };
    state.unsubJobs.set(email, job);
    if (detail && state.selectedUnsub === email) renderUnsubProgress(detail, job);
    pollUnsubJob(job);
  }

  function renderUnsubProgress(host, job) {
    const wrap = host.querySelector('[data-progress]');
    const actions = host.querySelector('.cln-detail-actions');
    if (!wrap) return;
    wrap.hidden = false;
    if (actions) actions.style.visibility = 'hidden';
    const fill = wrap.querySelector('.cln-progress-fill');
    const label = wrap.querySelector('.cln-progress-label');
    const count = wrap.querySelector('.cln-progress-count');
    const ratio = job.total ? ((job.done + job.failed) / job.total) : 0;
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    label.textContent = job.finished
      ? (job.failed ? t('cleanup.unsub.progress.done_partial', { fail: job.failed }) : t('cleanup.unsub.progress.done'))
      : t('cleanup.unsub.progress.label');
    count.textContent = `${job.done + job.failed} / ${job.total}`;
  }

  async function pollUnsubJob(job) {
    const tick = async () => {
      let snap;
      try { snap = await api.getCleanupJob(job.id); }
      catch (_) {
        state.unsubJobs.delete(job.sender);
        finishUnsub(job.sender, true);
        return;
      }
      Object.assign(job, { done: snap.done, failed: snap.failed, finished: snap.finished });
      const detail = $('#cln-unsub-detail');
      if (detail && state.selectedUnsub === job.sender) renderUnsubProgress(detail, job);
      if (snap.finished) {
        window.toast(snap.failed
          ? t('cleanup.unsub.toast.partial', { done: snap.done, fail: snap.failed })
          : t('cleanup.unsub.toast.success'));
        state.unsubJobs.delete(job.sender);
        finishUnsub(job.sender, snap.done > 0);
        return;
      }
      const delay = (snap.done + snap.failed) > 0 ? 600 : 1200;
      setTimeout(tick, delay);
    };
    tick();
  }

  function finishUnsub(email, persisted) {
    state.unsubBusy.delete(email);
    // If the server marked the sender unsubscribed, update local state so
    // the rail repaints immediately (no reload roundtrip).
    if (persisted) {
      const s = state.unsubSenders.find((x) => x.email === email);
      if (s) s.unsubscribed_at = new Date().toISOString();
    }
    // If purge was requested, the senders/rules tabs are stale.
    if (state.unsubPurge) {
      state.sendersStale = true;
      for (const r of RULES) state.ruleStats.delete(r.id);
    }
    state.unsubPurge = false;
    renderUnsubRail();
    if (state.selectedUnsub === email) renderUnsubDetail(email);
    // Refresh stats (purge changed totals).
    loadUnsubStats();
  }

  // ── Data loading ─────────────────────────────────────────
  async function loadAccounts() {
    try { state.accounts = await api.getAccounts(); }
    catch (_) { state.accounts = []; }
  }

  async function loadSenders() {
    try {
      const params = { limit: 200 };
      if (state.accountFilter) params.account = state.accountFilter;
      state.senders = await api.getTopSenders(params);
      $('#cln-sub').textContent =
        state.senders.length
          ? t('cleanup.senders.count', { n: state.senders.length })
          : t('cleanup.senders.empty');
      renderSenderList();
    } catch (err) {
      $('#cln-pane').innerHTML = `<div class="cln-empty cln-error">${escapeHtml(t('cleanup.toast.fail', { msg: err.message }))}</div>`;
    }
  }

  // ── Wire-up ──────────────────────────────────────────────
  // Honour ?tab= deep-link (e.g. #/cleanup?tab=unsubscribe from the dashboard)
  const hashParams = new URLSearchParams(location.hash.includes('?') ? location.hash.split('?')[1] : '');
  const deepTab = hashParams.get('tab');
  if (deepTab && deepTab !== state.tab && TABS_L.find((tab) => tab.id === deepTab && tab.enabled)) {
    state.tab = deepTab;
    host.querySelectorAll('.cln-tab').forEach((b) => {
      const on = b.dataset.tab === deepTab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  // Pre-select an unsubscribe sender if the dashboard linked us to one.
  // The actual selection is applied inside loadUnsubSenders() once the
  // rail data is back from the API.
  const deepSender = hashParams.get('sender');
  if (deepSender && state.tab === 'unsubscribe') {
    state.pendingUnsub = deepSender;
  }

  renderPane();
  await loadAccounts();
  await loadSenders();
  window.lucide?.createIcons();

  return () => {
    // The document-level dropdown closer used to be left running here, on
    // the theory that it "auto-collapses the next time it fires" — it does
    // not unregister itself, it just pokes a detached node forever.
    _docTeardown.forEach((off) => off());
    _docTeardown.length = 0;
  };
}
