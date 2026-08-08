// SPDX-License-Identifier: GPL-3.0-or-later
// AI page — a task launcher, laid out as a full page.
//
// A page header, a prominent ask/filter bar, and a stage that swaps between
// two views: the AI task list, and a result page showing the answer plus a
// trace of the tools the agent used. No floating palette card — the page
// owns its layout like Dashboard and Cleanup do. Emails never appear here —
// reading and processing mail belongs to the inbox; this page only runs
// one-shot tasks over the mailbox (summarise, find, check).
//
// Interaction model is still the Cmd-K palette's: type to filter or ask,
// ↑↓/Enter, Escape (or Backspace on an empty input) to go back. The hints
// are not displayed — the behaviours simply work.
//
// View swaps animate: the stage height FLIPs to its new size, the result
// page slides in from the right, the list slides back in from the left.
import {
  api, escapeHtml, linkify,
  avatarColor, initials, avatarImgHtml, senderName, senderEmail,
  shortDate, scoreClass,
} from '/static/api.js';
import { rewriteRemoteImages } from '/static/image-blocker.js';

const t = (k, v) => (window.t ? window.t(k, v) : k);

// The AI tasks. Each carries a colour for its icon chip and a one-line
// description of what it will actually do; prompts are i18n'd so the model
// is addressed in the user's language.
const SUGGESTIONS = [
  { icon: 'sun',            color: '#F59E0B', labelKey: 'aiw.task.today',    descKey: 'aiw.task.today_desc',    promptKey: 'aiw.task.today_prompt' },
  { icon: 'calendar-days',  color: '#8B5CF6', labelKey: 'aiw.task.week',     descKey: 'aiw.task.week_desc',     promptKey: 'aiw.task.week_prompt' },
  { icon: 'reply',          color: '#10B981', labelKey: 'aiw.task.pending',  descKey: 'aiw.task.pending_desc',  promptKey: 'aiw.task.pending_prompt' },
  { icon: 'history',        color: '#F97316', labelKey: 'aiw.task.stale',    descKey: 'aiw.task.stale_desc',    promptKey: 'aiw.task.stale_prompt' },
  { icon: 'calendar-clock', color: '#06B6D4', labelKey: 'aiw.task.dates',    descKey: 'aiw.task.dates_desc',    promptKey: 'aiw.task.dates_prompt' },
  { icon: 'shield-alert',   color: '#EF4444', labelKey: 'aiw.task.risky',    descKey: 'aiw.task.risky_desc',    promptKey: 'aiw.task.risky_prompt' },
  { icon: 'receipt',        color: '#3B82F6', labelKey: 'aiw.task.invoices', descKey: 'aiw.task.invoices_desc', promptKey: 'aiw.task.invoices_prompt' },
  { icon: 'package',        color: '#A16207', labelKey: 'aiw.task.orders',   descKey: 'aiw.task.orders_desc',   promptKey: 'aiw.task.orders_prompt' },
  { icon: 'newspaper',      color: '#EC4899', labelKey: 'aiw.task.news',     descKey: 'aiw.task.news_desc',     promptKey: 'aiw.task.news_prompt' },
];

export async function mountAI(host, opts = {}) {
  const navigate = opts.onRouteChange || ((h) => { location.hash = h; });

  const state = {
    view: 'list',          // 'list' | 'result'
    query: '',
    active: 0,             // highlighted entry index
    taskRunning: false,
    pendingPrompt: '',     // the question currently being answered
    thread: [],            // conversation: [{prompt, text, trace, error}]
    threadId: null,        // id of the persisted history entry for this thread
    readerId: null,        // int_id shown in the side reading panel
    _animEnter: false,     // slide the page in only on entry, not per turn
  };

  // ── Request history — answers already paid for should be re-readable for
  // free. Every completed thread is persisted (localStorage, same profile
  // the app keeps its UI prefs in) and listed under « Récentes »: reopening
  // one repaints the conversation with ZERO model calls, and it can still
  // be continued with follow-ups. Capped to the most recent entries.
  const HIST_KEY = 'aiw-history';
  const HIST_MAX = 20;

  function loadHist() {
    try {
      const a = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
      return Array.isArray(a) ? a : [];
    } catch (_) { return []; }
  }

  function saveHist(list) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX))); } catch (_) {}
  }

  function persistThread() {
    // Nothing worth keeping if every turn errored out.
    if (!state.thread.some((x) => !x.error)) return;
    if (!state.threadId) {
      state.threadId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    }
    const list = loadHist().filter((h) => h.id !== state.threadId);
    list.unshift({
      id: state.threadId,
      ts: new Date().toISOString(),
      title: state.thread[0].prompt,
      thread: state.thread,
    });
    saveHist(list);
  }

  function deleteHist(id) {
    saveHist(loadHist().filter((h) => h.id !== id));
  }

  // Cited emails, fetched once and reused by both the citation cards and
  // the side reader. Values are promises so concurrent hydrations of the
  // same id share one request.
  const _mailCache = new Map();
  function getMail(id) {
    const key = String(id);
    if (!_mailCache.has(key)) {
      _mailCache.set(key, api.getEmail(parseInt(key, 10)).catch((e) => {
        _mailCache.delete(key);   // transient failure → allow a retry later
        throw e;
      }));
    }
    return _mailCache.get(key);
  }

  const $ = (sel) => host.querySelector(sel);
  const teardown = [];

  host.innerHTML = `
    <div class="aiw" id="aiw-root">
      <div class="aiw-main">
        <header class="aiw-head">
          <h1>${t('aiw.title')}</h1>
          <p class="aiw-sub">${t('aiw.subtitle')}</p>
        </header>
        <div class="aiw-hero">
          <i data-lucide="wand-sparkles" class="w-4 h-4"></i>
          <input id="aiw-input" type="text" autocomplete="off" spellcheck="false"
                 placeholder="${t('aiw.input_ph')}" aria-label="${t('aiw.input_ph')}" />
        </div>
        <div class="aiw-stage" id="aiw-body"></div>
      </div>
      <aside class="aiw-reader" id="aiw-reader" hidden
             aria-label="${t('aiw.reader.aria')}"></aside>
    </div>
  `;

  const input = $('#aiw-input');
  const body = $('#aiw-body');

  // ── AI off → one message, one button. ───────────────────────────
  if (!window.aiEnabled) {
    input.disabled = true;
    body.innerHTML = `
      <div class="aiw-empty">
        <div class="aiw-empty-title">${t('aiw.disabled_title')}</div>
        <div class="aiw-empty-sub">${t('aiw.disabled_sub')}</div>
        <button class="mb-cta aiw-cta" id="aiw-go-settings">
          <i data-lucide="settings" class="w-4 h-4"></i><span>${t('aiw.disabled_cta')}</span>
        </button>
      </div>`;
    $('#aiw-go-settings')?.addEventListener('click', () => navigate('#/settings'));
    window.lucide?.createIcons();
    return () => { teardown.forEach((fn) => fn()); };
  }

  // ── Entries (tasks + history + free-text ask) ───────────────────
  function entries() {
    const q = state.query.trim().toLowerCase();
    const out = SUGGESTIONS
      .filter((s) => !q || (t(s.labelKey) + ' ' + t(s.descKey)).toLowerCase().includes(q))
      .map((s) => ({ kind: 'task', s }));
    for (const h of loadHist()) {
      if (!q || (h.title || '').toLowerCase().includes(q)) out.push({ kind: 'hist', h });
    }
    if (state.query.trim()) out.push({ kind: 'ask' });
    return out;
  }

  // ── View swap with a height FLIP ────────────────────────────────
  // innerHTML swaps snap the card to its new size; measuring before/after
  // and transitioning the height makes the card breathe instead.
  function swap(renderFn) {
    const h0 = body.offsetHeight;
    renderFn();
    const h1 = body.scrollHeight;
    if (!h0 || Math.abs(h1 - h0) < 2) return;
    body.style.height = h0 + 'px';
    body.style.overflow = 'hidden';
    void body.offsetHeight;   // commit the start height before transitioning
    body.style.transition = 'height 240ms cubic-bezier(.4,0,.2,1)';
    body.style.height = h1 + 'px';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      body.style.height = '';
      body.style.transition = '';
      body.style.overflow = '';
      body.removeEventListener('transitionend', finish);
    };
    body.addEventListener('transitionend', finish);
    setTimeout(finish, 300);  // safety: transitionend can be swallowed
  }

  // ── Render ──────────────────────────────────────────────────────
  function render(dir) {
    if (state.view === 'result') swap(() => renderResult());
    else swap(() => renderList(dir));
  }

  function renderList(dir) {
    const list = entries();
    if (state.active >= list.length) state.active = Math.max(0, list.length - 1);

    let i = -1;
    const taskRows = list.filter((e) => e.kind === 'task').map((e) => {
      i += 1;
      return `
        <div class="aiw-row aiw-row-task ${i === state.active ? 'active' : ''}" data-i="${i}"
             role="option" aria-selected="${i === state.active}"
             style="animation-delay:${Math.min(i * 40, 200)}ms">
          <span class="aiw-task-ic" style="--tc:${e.s.color}">
            <i data-lucide="${e.s.icon}" class="w-4 h-4"></i>
          </span>
          <span class="aiw-row-col">
            <span class="aiw-row-label">${t(e.s.labelKey)}</span>
            <span class="aiw-row-desc">${t(e.s.descKey)}</span>
          </span>
        </div>`;
    }).join('');

    const histRows = list.filter((e) => e.kind === 'hist').map((e) => {
      i += 1;
      const n = (e.h.thread || []).length;
      return `
        <div class="aiw-row aiw-row-task aiw-row-hist ${i === state.active ? 'active' : ''}" data-i="${i}"
             role="option" aria-selected="${i === state.active}"
             style="animation-delay:${Math.min(i * 40, 200)}ms">
          <span class="aiw-task-ic" style="--tc:#64748B">
            <i data-lucide="history" class="w-4 h-4"></i>
          </span>
          <span class="aiw-row-col">
            <span class="aiw-row-label">${escapeHtml(e.h.title || '')}</span>
            <span class="aiw-row-desc">${escapeHtml(shortDate(e.h.ts))} · ${t('aiw.hist.exchanges', { n })}</span>
          </span>
          <button type="button" class="aiw-hist-del" data-del="${escapeHtml(e.h.id)}"
                  title="${t('aiw.hist.delete')}" aria-label="${t('aiw.hist.delete')}">
            <i data-lucide="x" class="w-3.5 h-3.5"></i>
          </button>
        </div>`;
    }).join('');

    const hasAsk = list.some((e) => e.kind === 'ask');
    const askHtml = hasAsk ? (() => {
      i += 1;
      return `
        ${taskRows || histRows ? '<div class="aiw-sep"></div>' : ''}
        <div class="aiw-row ${i === state.active ? 'active' : ''}" data-i="${i}"
             role="option" aria-selected="${i === state.active}"
             style="animation-delay:${Math.min(i * 40, 200)}ms">
          <i data-lucide="wand-sparkles" class="w-4 h-4"></i>
          <span class="aiw-row-label">${t('aiw.ask', { q: escapeHtml(state.query.trim()) })}</span>
          <span class="cmdk-tag">IA</span>
        </div>`;
    })() : '';

    body.innerHTML = `
      <div class="aiw-list ${dir === 'back' ? 'is-back' : ''}" role="listbox" aria-label="${t('aiw.title')}">
        ${taskRows}
        ${histRows ? `<div class="aiw-group">${t('aiw.group.recent')}</div>${histRows}` : ''}
        ${askHtml}
      </div>`;

    body.querySelectorAll('[data-i]').forEach((el) => {
      el.addEventListener('click', (e) => {
        // The little × on history rows deletes the entry instead of opening it.
        const del = e.target.closest('.aiw-hist-del');
        if (del) {
          e.stopPropagation();
          deleteHist(del.dataset.del);
          renderList();
          return;
        }
        open(parseInt(el.dataset.i, 10));
      });
      el.addEventListener('mousemove', () => {
        const idx = parseInt(el.dataset.i, 10);
        if (idx !== state.active) { state.active = idx; paintActive(); }
      });
    });
    window.lucide?.createIcons({ el: body });
  }

  function paintActive() {
    body.querySelectorAll('[data-i]').forEach((el) => {
      const on = parseInt(el.dataset.i, 10) === state.active;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  // ── Result page (conversation thread) ───────────────────────────
  const TOOL_ICON = {
    search_emails: 'search', list_emails: 'list', get_email: 'mail-open',
    get_thread: 'messages-square', draft_reply: 'pen-line',
    mark_email_read: 'check', move_email: 'move',
    top_senders: 'users', mailbox_stats: 'pie-chart',
    unsubscribe_candidates: 'mail-x', list_labels: 'tag',
    list_folders: 'folder', list_accounts: 'at-sign',
    set_favourite: 'star', label_email: 'tag',
  };

  // Strip any tool-call XML the backend failed to scrub — small local
  // models leak these. Same families src/agent_local_parser.py recognises.
  function stripToolArtifacts(s) {
    return String(s || '')
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .replace(/<function_call>[\s\S]*?<\/function_call>/g, '')
      .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, '')
      .replace(/\[TOOL_CALLS\]\s*(?:\[[\s\S]*?\]|\{[\s\S]*?\})/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Minimal, safe Markdown renderer for assistant answers. Everything is
  // HTML-escaped FIRST, then a handful of patterns are re-expanded — so
  // nothing an email (or the model) emits can inject markup.
  //
  // [mail:<id>] source markers get two treatments:
  //   • A LIST ITEM (or standalone line) carrying a marker becomes a proper
  //     email CARD — canonical data (avatar, subject, sender, date, score)
  //     fetched from the DB replaces whatever the model typed on that line.
  //     That's what makes cited mails readable instead of a wall of text.
  //   • A marker inside a real sentence becomes a subject pill, so prose
  //     like "le mail de Marie [mail:2] parle de…" keeps flowing.
  // Both open the mail in the side reader panel.
  const _MARKER = /\[mail:(\d+)\]/g;

  function mdToHtml(raw) {
    const inline = (s) => s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(_MARKER, (_, id) =>
        `<button type="button" class="aiw-src" data-mail-id="${id}" data-mail-hydrate="pill"` +
        ` title="${t('aiw.src_open')}">` +
        `<i data-lucide="mail-open" class="w-3 h-3"></i><span>…</span></button>`);
    const card = (id) =>
      `<div class="aiw-mailcard" role="button" tabindex="0" data-mail-id="${id}"` +
      ` data-mail-hydrate="card" title="${t('aiw.src_open')}">` +
      `<span class="aiw-mc-skel"></span></div>`;

    const lines = escapeHtml(String(raw || '')).split('\n');
    const out = [];
    let inUl = false, inOl = false;
    const closeLists = () => {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
    };
    for (const line of lines) {
      const ids = [...line.matchAll(_MARKER)].map((m) => m[1]);
      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const h = line.match(/^\s*#{1,4}\s+(.*)$/);
      // Cited-mail line → card(s). Covers "- **Objet** — X [mail:2]" (list
      // item) and a bare "[mail:2]" on its own line.
      if (ids.length && (ul || ol || !line.replace(_MARKER, '').trim())) {
        closeLists();
        ids.forEach((id) => out.push(card(id)));
        continue;
      }
      if (ul) {
        if (!inUl) { closeLists(); out.push('<ul>'); inUl = true; }
        out.push(`<li>${inline(ul[1])}</li>`);
      } else if (ol) {
        if (!inOl) { closeLists(); out.push('<ol>'); inOl = true; }
        out.push(`<li>${inline(ol[1])}</li>`);
      } else if (h) {
        closeLists();
        out.push(`<p class="aiw-md-h">${inline(h[1])}</p>`);
      } else if (!line.trim()) {
        closeLists();
      } else {
        closeLists();
        out.push(`<p>${inline(line)}</p>`);
      }
    }
    closeLists();
    return out.join('');
  }

  // Fill the async parts of the answer: cards get avatar/subject/sender/date,
  // pills get the subject. Runs after each innerHTML swap; the cache makes
  // re-renders (follow-ups) instant.
  function hydrateMailRefs(container) {
    container.querySelectorAll('[data-mail-hydrate]').forEach(async (el) => {
      const kind = el.dataset.mailHydrate;
      el.removeAttribute('data-mail-hydrate');
      try {
        const em = await getMail(el.dataset.mailId);
        const sName = senderName(em.sender);
        const sEmail = senderEmail(em.sender);
        if (kind === 'card') {
          const score = em.importance_score || 0;
          el.innerHTML = `
            <span class="mb-avatar aiw-mc-av" style="background:${avatarColor(sEmail || sName)}">
              <span class="av-text">${escapeHtml(initials(sName || sEmail))}</span>${avatarImgHtml(sEmail, 30)}
            </span>
            <span class="aiw-mc-main">
              <span class="aiw-mc-subj">${escapeHtml(em.subject || t('aiw.no_subject'))}</span>
              <span class="aiw-mc-from">${escapeHtml(sName || sEmail)}</span>
            </span>
            ${score > 0 ? `<span class="score-pill ${scoreClass(score)}">${score}</span>` : ''}
            <span class="aiw-mc-date">${escapeHtml(shortDate(em.date_received))}</span>
            <i data-lucide="chevron-right" class="w-4 h-4 aiw-mc-chev"></i>`;
        } else {
          const span = el.querySelector('span');
          if (span) span.textContent = em.subject || t('aiw.no_subject');
        }
        window.lucide?.createIcons({ el });
      } catch (_) {
        el.classList.add('is-broken');
        if (kind === 'card') {
          el.innerHTML = `<span class="aiw-mc-from">${t('aiw.card_error')}</span>`;
        }
      }
    });
  }

  function exchangeHtml(x, isFirst) {
    const userTurn = isFirst ? '' :
      `<div class="aiw-turn-user">${escapeHtml(x.prompt)}</div>`;
    const trace = (x.trace || []).length ? `
      <div class="cmdk-trace" aria-label="${t('aiw.task.trace')}">
        ${x.trace.map((s, j) => `
          <span class="cmdk-trace-step" style="animation-delay:${40 + j * 40}ms">
            <i data-lucide="${TOOL_ICON[s.tool] || 'sparkles'}" class="w-3 h-3"></i>
            <span class="cmdk-trace-name">${escapeHtml(s.tool)}</span>
          </span>`).join('')}
      </div>` : '';
    const clean = stripToolArtifacts(x.text);
    const bodyHtml = x.error
      ? `<div class="cmdk-result-error">${escapeHtml(clean || x.error)}</div>`
      : (clean
          ? `<div class="aiw-md">${mdToHtml(clean)}</div>`
          : `<div class="cmdk-result-empty">${t('aiw.task.empty')}</div>`);
    return userTurn + trace + bodyHtml;
  }

  function renderResult() {
    const first = state.thread[0];
    const title = first ? first.prompt : state.pendingPrompt;
    const turns = state.thread.map((x, i) => exchangeHtml(x, i === 0)).join('');
    const pending = state.taskRunning ? `
      ${state.thread.length ? `<div class="aiw-turn-user">${escapeHtml(state.pendingPrompt)}</div>` : ''}
      <div class="aiw-thinking"><span class="cmdk-spinner"></span>${t('aiw.task.thinking')}</div>` : '';
    // The follow-up bar is what makes this a conversation: the backend
    // replays the thread as history, so « et le deuxième ? » just works.
    const followup = !state.taskRunning ? `
      <div class="aiw-followup">
        <input type="text" id="aiw-followup-input" autocomplete="off" spellcheck="false"
               placeholder="${t('aiw.followup_ph')}" aria-label="${t('aiw.followup_ph')}" />
        <button class="aiw-followup-send" id="aiw-followup-send"
                title="${t('aiw.followup_send')}" aria-label="${t('aiw.followup_send')}">
          <i data-lucide="corner-down-left" class="w-4 h-4"></i>
        </button>
      </div>` : '';

    body.innerHTML = `
      <div class="aiw-page ${state._animEnter ? '' : 'aiw-page-still'}">
        <div class="aiw-page-head">
          <button class="aiw-back" id="aiw-back" title="${t('aiw.back')}" aria-label="${t('aiw.back')}">
            <i data-lucide="arrow-left" class="w-4 h-4"></i>
          </button>
          <div class="aiw-page-subj">${escapeHtml(title || '')}</div>
        </div>
        <div class="aiw-convo">${turns}${pending}</div>
        ${followup}
      </div>`;
    state._animEnter = false;

    $('#aiw-back')?.addEventListener('click', back);
    const fu = $('#aiw-followup-input');
    fu?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runTask(fu.value); }
    });
    $('#aiw-followup-send')?.addEventListener('click', () => runTask(fu?.value));
    if (fu) fu.focus();
    body.scrollTop = body.scrollHeight;
    window.lucide?.createIcons({ el: body });
    hydrateMailRefs(body);
  }

  async function runTask(message) {
    const msg = (message || '').trim();
    if (!msg || state.taskRunning) return;
    // Replay the visible thread as history so follow-ups keep context.
    // Failed turns are skipped — an error message is not conversation.
    const history = state.thread.flatMap((x) => x.error ? [] : [
      { role: 'user', content: x.prompt },
      { role: 'assistant', content: x.text || '' },
    ]);
    if (state.view !== 'result') state._animEnter = true;
    state.view = 'result';
    state.taskRunning = true;
    state.pendingPrompt = msg;
    render();
    try {
      const r = await api.assistantAsk(msg, history);
      state.thread.push({ prompt: msg, text: r?.text || '', trace: r?.trace || [], error: r?.error || '' });
    } catch (e) {
      state.thread.push({
        prompt: msg, text: '', trace: [],
        error: e.status === 409 ? t('aiw.task.ai_off') : (e.message || String(e)),
      });
    } finally {
      state.taskRunning = false;
      state.pendingPrompt = '';
      // Persist even if the user navigated away mid-run: the answer was
      // paid for, it belongs in « Récentes ».
      persistThread();
      // Only paint the result if the user is still on it — they may have
      // pressed Escape mid-run, and yanking them back would be rude.
      if (state.view === 'result') render();
    }
  }

  // ── Navigation ──────────────────────────────────────────────────
  function open(i) {
    const e = entries()[i];
    if (!e) return;
    if (e.kind === 'task') { runTask(t(e.s.promptKey)); return; }
    if (e.kind === 'hist') {
      // Replay a stored conversation — zero model calls; the citation cards
      // hydrate from the local DB. Follow-ups continue the same entry.
      state.thread = (e.h.thread || []).map((x) => ({ ...x }));
      state.threadId = e.h.id;
      state.query = '';
      input.value = '';
      state._animEnter = true;
      state.view = 'result';
      render();
      return;
    }
    runTask(state.query.trim());
  }

  function back() {
    closeReader();
    state.view = 'list';
    state.query = '';
    input.value = '';
    state.active = 0;
    state.thread = [];
    state.threadId = null;
    state.pendingPrompt = '';
    render('back');
    input.focus();
  }

  // ── Side reader — the cited email opens NEXT TO the conversation, the
  // page never navigates away. "Ouvrir dans la boîte" hands off to the
  // full inbox experience (reply, move, labels…). Read-only preview:
  // remote images always blocked, no scripts, nothing marked read.
  async function openReader(id) {
    const root = $('#aiw-root');
    const aside = $('#aiw-reader');
    if (!root || !aside) return;
    state.readerId = String(id);
    root.classList.add('has-reader');
    aside.hidden = false;
    // Top-align the panel with the CONVERSATION, not the page: without this
    // offset it docked level with the page title, floating high beside the
    // header with dead space under it. The offset = header + hero heights,
    // measured (not hardcoded) so layout changes can't desync it.
    const mainEl = host.querySelector('.aiw-main');
    if (mainEl) {
      const off = Math.max(0, body.getBoundingClientRect().top - mainEl.getBoundingClientRect().top);
      aside.style.marginTop = off + 'px';
    }
    aside.innerHTML = `<div class="aiw-reader-load"><span class="cmdk-spinner"></span></div>`;
    let em;
    try {
      em = await getMail(id);
    } catch (_) {
      if (state.readerId !== String(id)) return;
      aside.innerHTML = `
        <div class="aiw-reader-head">
          <div class="aiw-reader-titles">
            <div class="aiw-reader-subj">${t('aiw.card_error')}</div>
          </div>
          <button class="aiw-back" id="aiw-reader-close" title="${t('aiw.reader.close')}">
            <i data-lucide="x" class="w-4 h-4"></i>
          </button>
        </div>`;
      $('#aiw-reader-close')?.addEventListener('click', closeReader);
      window.lucide?.createIcons({ el: aside });
      return;
    }
    if (state.readerId !== String(id)) return;   // superseded by another click

    const sName = senderName(em.sender);
    const sEmail = senderEmail(em.sender);
    const hasText = em.body_text && em.body_text.trim().length;
    const hasHtml = em.body_html && em.body_html.trim().length;
    let bodyHtml;
    if (hasText) {
      bodyHtml = `<div class="aiw-reader-text">${linkify(em.body_text)}</div>`;
    } else if (hasHtml) {
      // Sandboxed (no scripts), remote images stripped — same blocker the
      // inbox uses, minus the trust/one-shot buttons: this is a preview.
      const blocked = rewriteRemoteImages(em.body_html).html;
      const doc = '<base target="_blank"><style>'
        + 'html,body{margin:0;padding:12px;overflow-x:hidden;word-break:break-word;'
        + 'font-family:system-ui,sans-serif;font-size:14px}'
        + 'img,video{max-width:100%!important;height:auto!important}'
        + 'table{max-width:100%!important;table-layout:fixed!important}'
        + '</style>' + blocked;
      bodyHtml = `<iframe class="aiw-reader-iframe" sandbox="allow-popups allow-popups-to-escape-sandbox"`
        + ` srcdoc="${escapeHtml(doc)}" title="${escapeHtml(em.subject || t('aiw.no_subject'))}"></iframe>`;
    } else {
      bodyHtml = `<div class="aiw-reader-text aiw-reader-empty">${t('aiw.reader.empty')}</div>`;
    }

    aside.innerHTML = `
      <div class="aiw-reader-head">
        <span class="mb-avatar aiw-reader-av" style="background:${avatarColor(sEmail || sName)}">
          <span class="av-text">${escapeHtml(initials(sName || sEmail))}</span>${avatarImgHtml(sEmail, 34)}
        </span>
        <div class="aiw-reader-titles">
          <div class="aiw-reader-subj">${escapeHtml(em.subject || t('aiw.no_subject'))}</div>
          <div class="aiw-reader-meta">${escapeHtml(sName || sEmail)} · ${escapeHtml(shortDate(em.date_received))}</div>
        </div>
        <button class="aiw-back" id="aiw-reader-inbox" title="${t('aiw.reader.open_inbox')}"
                aria-label="${t('aiw.reader.open_inbox')}">
          <i data-lucide="inbox" class="w-4 h-4"></i>
        </button>
        <button class="aiw-back" id="aiw-reader-close" title="${t('aiw.reader.close')}"
                aria-label="${t('aiw.reader.close')}">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
      </div>
      <div class="aiw-reader-body">${bodyHtml}</div>`;
    $('#aiw-reader-close')?.addEventListener('click', closeReader);
    $('#aiw-reader-inbox')?.addEventListener('click', () => navigate(`#/inbox?focus=${id}`));
    window.lucide?.createIcons({ el: aside });
  }

  function closeReader() {
    state.readerId = null;
    const aside = $('#aiw-reader');
    if (aside) { aside.hidden = true; aside.innerHTML = ''; aside.style.marginTop = ''; }
    $('#aiw-root')?.classList.remove('has-reader');
  }

  // Citation cards + subject pills — delegated so every re-render keeps
  // working without re-wiring. Both open the side reader.
  body.addEventListener('click', (e) => {
    const ref = e.target.closest('.aiw-mailcard, .aiw-src');
    if (ref && ref.dataset.mailId) openReader(ref.dataset.mailId);
  });
  body.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ')
        && e.target.classList?.contains('aiw-mailcard') && e.target.dataset.mailId) {
      e.preventDefault();
      openReader(e.target.dataset.mailId);
    }
  });

  input.addEventListener('input', () => {
    state.query = input.value;
    state.active = 0;
    if (state.view !== 'list') state.view = 'list';
    render();
  });

  const onKey = (e) => {
    if (e.key === 'Escape') {
      // Layered dismissal: reader panel → conversation → query.
      if (state.readerId) { e.preventDefault(); closeReader(); return; }
      if (state.view !== 'list') { e.preventDefault(); back(); return; }
      if (state.query) { e.preventDefault(); state.query = ''; input.value = ''; render(); return; }
      return;
    }
    // cmdk convention: Backspace on an empty input pops the pushed page.
    if (e.key === 'Backspace' && state.view !== 'list'
        && e.target === input && !input.value) {
      e.preventDefault(); back(); return;
    }
    if (state.view !== 'list') return;
    const list = entries();
    if (!list.length) return;
    const down = e.key === 'ArrowDown' || (e.key === 'j' && e.target !== input);
    const up = e.key === 'ArrowUp' || (e.key === 'k' && e.target !== input);
    if (down) { e.preventDefault(); state.active = Math.min(state.active + 1, list.length - 1); paintActive(); }
    else if (up) { e.preventDefault(); state.active = Math.max(state.active - 1, 0); paintActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); open(state.active); }
  };
  host.addEventListener('keydown', onKey);
  teardown.push(() => host.removeEventListener('keydown', onKey));

  renderList();
  window.lucide?.createIcons();
  input.focus();

  return () => { teardown.forEach((fn) => fn()); };
}
