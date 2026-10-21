// SPDX-License-Identifier: GPL-3.0-or-later
//
// Nettoyage — one ranked list of at most three things worth doing.
//
// What this replaced: three tabs, sixteen regions, twenty distinct actions and
// four different confirmation designs, landing on a red "Supprimer" with no
// orientation. Nobody used it. Everything here is computed by the server from
// columns already in SQLite, so the page is correct the moment it paints and
// there is nothing to configure.
//
// Three rules hold the shape:
//   * one request on mount (GET /api/cleanup/suggestions), and every mutation
//     returns the recomputed payload, so a card can never still claim a pile
//     the user just emptied;
//   * a card is a sentence, a number, one button and a quiet link — the
//     inspection list lives in the inbox, which already has search, selection
//     and its own undo. The one button does it all; « Choisir… » beside it
//     opens the same set as a checklist, because "all of it or nothing" was
//     the page's most-reported failing: nobody wants to leave every list or
//     empty every pile at once;
//   * the undo lives in the card, not in the rail toast: railToast is
//     single-slot and a background sync pass destroys the live toast within
//     seconds.

import { api, escapeHtml } from '/static/api.js';
import { confirmAsync, dismissOpenConfirms } from '/static/confirm.js';

// Matches _CLEANUP_UNDO_DELAY_SECONDS in src/api.py: the queued IMAP move is
// held for this long, so an undo inside the window cancels it outright and
// the mail server never sees the deletion at all. Past it there is no untrash
// operation, which is why the button is replaced rather than left enabled.
const UNDO_SECONDS = 20;
// A card's set is computed, described and previewable rather than
// hand-selected, so the gate sits ten times higher than the inbox's 20.
const CONFIRM_ABOVE = 200;
const TRASH_CARDS = new Set(['spam', 'old_news', 'after_unsub']);
// Every card that stands for several things a user may want to split.
// unsub_one is a single sender, so there is nothing to choose between.
const PICKABLE = new Set([...TRASH_CARDS, 'old_unread', 'unsub_bulk']);

export async function mountCleanup(host, opts = {}) {
  const t = window.t || ((k, v) => k);
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(fn, ms); timers.add(id); return id; };
  const every = (fn, ms) => { const id = setInterval(fn, ms); timers.add(id); return id; };

  let state = null;      // last payload
  let destroyed = false;
  // Which mailbox the page is about. Every count, every card and every
  // button is scoped to it. Empty means all of them -- which is a real
  // answer, not a missing one: "1 400 newsletters across everything" is
  // the number most people want first.
  //
  // Deliberately not remembered across mounts. A destructive page that
  // silently reopens filtered is a page that deletes the wrong mailbox's
  // mail the one time the user forgets which filter they left on.
  let account = '';
  let accounts = [];
  // Whether "which mailbox" is a question at all. With one account every
  // row would carry the same address: pure noise.
  const multiAccount = () => accounts.length > 1;

  function navigateTo(hash) {
    if (typeof opts.onRouteChange === 'function') opts.onRouteChange(hash);
    else location.hash = hash;
  }

  host.innerHTML = `
    <section class="cln" role="region" aria-labelledby="cln-title">
      <header class="cln-head">
        <h1 id="cln-title">${escapeHtml(t('cleanup.title'))}</h1>
        <p class="cln-head-sub" id="cln-sub"></p>
        <div class="cln-accounts" id="cln-accounts" role="group"
             aria-label="${escapeHtml(t('cleanup.account.group'))}" hidden></div>
      </header>
      <p class="cln-live sr-only" aria-live="polite" id="cln-live"></p>
      <div class="cln-banner" id="cln-banner" hidden></div>
      <ol class="cln-list" id="cln-list" aria-labelledby="cln-title"></ol>
      <div class="cln-state" id="cln-state" hidden></div>
      <footer class="cln-foot">
        <button type="button" class="cln-more" id="cln-more" hidden></button>
        <button type="button" class="cln-unhide" id="cln-unhide" hidden></button>
        <button type="button" class="cln-unhide" id="cln-unkeep" hidden></button>
        <span class="cln-stamp" id="cln-stamp"></span>
        <span class="cln-guard">${escapeHtml(t('cleanup.guard'))}</span>
      </footer>
    </section>`;

  const $ = (sel) => host.querySelector(sel);
  const accountsEl = $('#cln-accounts');
  const listEl = $('#cln-list');
  const stateEl = $('#cln-state');
  const bannerEl = $('#cln-banner');
  const liveEl = $('#cln-live');

  const announce = (msg) => { if (liveEl) liveEl.textContent = msg; };

  // ── rendering ─────────────────────────────────────────────────────────

  function renderAccounts() {
    // One mailbox needs no picker: every card already means "your mail".
    if (!accountsEl || accounts.length < 2) {
      if (accountsEl) accountsEl.hidden = true;
      return;
    }
    accountsEl.hidden = false;
    const chip = (value, label, title) =>
      `<button type="button" class="cln-acc${value === account ? ' active' : ''}"
               data-account="${escapeHtml(value)}"
               aria-pressed="${value === account ? 'true' : 'false'}"
               title="${escapeHtml(title || label)}">${escapeHtml(label)}</button>`;
    accountsEl.innerHTML =
      chip('', t('cleanup.account.all')) +
      accounts.map((a) => chip(a.email, a.name || a.email, a.email)).join('');
    accountsEl.querySelectorAll('[data-account]').forEach((b) => {
      b.addEventListener('click', () => {
        const next = b.dataset.account;
        if (next === account) return;
        account = next;
        renderAccounts();
        // A full reload, not a client-side filter: the counts, the floors
        // and the ranking are all computed per scope on the server.
        state = null;
        load();
      });
    });
  }

  function cardTitle(card) {
    return t(`cleanup.card.${card.id}.title`, card.vars);
  }

  function cardGain(card) {
    let text = t(`cleanup.card.${card.id}.gain`, card.vars);
    if (card.vars.matched && card.vars.matched > card.vars.n) {
      text += ' ' + t('cleanup.card.capped', card.vars);
    }
    return text;
  }

  function renderCard(card) {
    const li = document.createElement('li');
    li.className = 'cln-card';
    li.dataset.card = card.id;
    li.dataset.state = 'idle';
    const peek = card.peek?.query
      ? `<a class="cln-card-peek" href="#/inbox?q=${encodeURIComponent(card.peek.query)}"
            aria-label="${escapeHtml(t('cleanup.peek_aria'))}">${escapeHtml(t('cleanup.peek'))}</a>`
      : '';
    li.innerHTML = `
      <h2 class="cln-card-title">${escapeHtml(cardTitle(card))}</h2>
      <p class="cln-card-gain">${escapeHtml(cardGain(card))}</p>
      <div class="cln-card-foot">
        <button type="button" class="cln-card-go">${escapeHtml(t(`cleanup.card.${card.id}.btn`, card.vars))}</button>
        ${PICKABLE.has(card.id) && (card.vars.n || 0) > 1
          ? `<button type="button" class="cln-card-pick"
                     aria-label="${escapeHtml(t('cleanup.card.pick_aria'))}">${escapeHtml(t('cleanup.card.pick'))}</button>`
          : ''}
        ${peek}
        <button type="button" class="cln-card-hide"
                aria-label="${escapeHtml(t('cleanup.hide_aria'))}">${escapeHtml(t('cleanup.hide'))}</button>
      </div>
      <div class="cln-card-run" hidden>
        <div class="cln-bar"><div class="cln-bar-fill" style="width:0%"></div></div>
        <p class="cln-card-run-text"></p>
      </div>
      <div class="cln-card-done" hidden></div>
      <p class="cln-card-err" hidden></p>`;

    li.querySelector('.cln-card-go').addEventListener('click', () => runCard(card, li));
    li.querySelector('.cln-card-pick')?.addEventListener('click',
      () => runCard(card, li, { pick: true }));
    li.querySelector('.cln-card-hide').addEventListener('click', () => hideCard(card, li));
    return li;
  }

  function renderState(kind, payload) {
    listEl.hidden = true;
    stateEl.hidden = false;
    if (kind === 'loading') {
      stateEl.innerHTML =
        `<p class="cln-state-title">${escapeHtml(t('cleanup.state.loading'))}</p>` +
        '<div class="cln-skeletons" aria-hidden="true">' +
        '<div class="cln-skel"></div><div class="cln-skel"></div><div class="cln-skel"></div></div>';
      return;
    }
    if (kind === 'firstrun') {
      stateEl.innerHTML =
        `<p class="cln-state-title">${escapeHtml(t('cleanup.state.firstrun.title'))}</p>` +
        `<p class="cln-state-body">${escapeHtml(t('cleanup.state.firstrun.body', { n: payload.analysing }))}</p>`;
      return;
    }
    if (kind === 'clean') {
      const extra = payload.unsubscribed_total > 0
        ? `<p class="cln-state-body">${escapeHtml(t('cleanup.state.clean.unsub', { n: payload.unsubscribed_total }))}</p>`
        : '';
      stateEl.innerHTML =
        `<p class="cln-state-title">${escapeHtml(t('cleanup.state.clean.title'))}</p>` +
        `<p class="cln-state-body">${escapeHtml(t('cleanup.state.clean.body', {
          n: payload.mailbox.live, unread: payload.mailbox.unread }))}</p>` + extra;
      return;
    }
    // error
    stateEl.innerHTML =
      `<p class="cln-state-title">${escapeHtml(t('cleanup.state.error.title'))}</p>` +
      `<p class="cln-state-body">${escapeHtml(t('cleanup.state.error.body'))}</p>` +
      `<button type="button" class="cln-retry">${escapeHtml(t('cleanup.state.retry'))}</button>`;
    stateEl.querySelector('.cln-retry').addEventListener('click', () => load());
  }

  function renderBanner(payload) {
    // At most one line, and never a substitute for the cards: on a big
    // mailbox the queue can sit at thousands while the mail already read
    // produces perfectly good suggestions.
    let html = '';
    if (payload.migrated_rules > 0) {
      html =
        `<span>${escapeHtml(t('cleanup.migrated', { n: payload.migrated_rules }))}</span>` +
        `<button type="button" class="cln-banner-btn" id="cln-migrated-ok">${escapeHtml(t('cleanup.hide'))}</button>`;
    } else if (window.aiEnabled === false) {
      html = escapeHtml(t('cleanup.banner.noai'));
    } else if (payload.analysing > 0 && payload.cards.length) {
      html = escapeHtml(t('cleanup.banner.analysing', { n: payload.analysing }));
    } else if (payload.missing_headers > 0) {
      // No longer hidden as soon as one unsubscribe card exists. With
      // several mailboxes that card can come entirely from one of them
      // while another has not had a single header read -- and the offer to
      // read them was the only way back.
      html =
        `<span>${escapeHtml(t('cleanup.banner.scan.title', { n: payload.missing_headers }))} ` +
        `${escapeHtml(t('cleanup.banner.scan.body'))}</span>` +
        `<button type="button" class="cln-banner-btn" id="cln-scan">${escapeHtml(t('cleanup.banner.scan.btn'))}</button>`;
    }
    bannerEl.innerHTML = html;
    bannerEl.hidden = !html;
    bannerEl.querySelector('#cln-scan')?.addEventListener('click', runHeaderScan);
    bannerEl.querySelector('#cln-migrated-ok')?.addEventListener('click', async () => {
      try { render((await api.hideCleanupCard('migrated_rules', account || undefined)).suggestions); }
      catch (_) { bannerEl.hidden = true; }
    });
  }

  function render(payload) {
    state = payload;
    const cards = payload.cards || [];

    $('#cln-sub').textContent = cards.length ? t('cleanup.sub', { n: cards.length }) : '';
    $('#cln-stamp').textContent = t('cleanup.stamp', {
      time: new Date(payload.generated_at).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit' }),
    });

    const more = $('#cln-more');
    more.hidden = !payload.more;
    if (payload.more) {
      more.textContent = t('cleanup.more', { n: payload.more });
      more.onclick = () => { more.hidden = true; renderAll(payload, true); };
    }
    const unhide = $('#cln-unhide');
    unhide.hidden = !payload.hidden;
    if (payload.hidden) {
      unhide.textContent = t('cleanup.unhide', { n: payload.hidden });
      unhide.onclick = async () => {
        try { render((await api.unhideCleanupCards(account || undefined)).suggestions); }
        catch (_) { /* the next mount will pick it up */ }
      };
    }
    // The lists kept from the unsubscribe sheet never come back on their
    // own, so the way to change one's mind has to stay on the page.
    const unkeep = $('#cln-unkeep');
    unkeep.hidden = !payload.kept_subs;
    if (payload.kept_subs) {
      unkeep.textContent = t('cleanup.unkeep', { n: payload.kept_subs });
      unkeep.onclick = async () => {
        try { render((await api.unkeepSubscriptions(account || undefined)).suggestions); }
        catch (_) { /* the next mount will pick it up */ }
      };
    }

    renderBanner(payload);
    renderAll(payload, false);
  }

  function renderAll(payload, _showAll) {
    const cards = payload.cards || [];
    listEl.innerHTML = '';
    if (!cards.length) {
      renderState(payload.analysing > 0 ? 'firstrun' : 'clean', payload);
      announce(t('cleanup.sr.loaded', { n: 0 }));
      return;
    }
    stateEl.hidden = true;
    listEl.hidden = false;
    for (const card of cards) listEl.appendChild(renderCard(card));
    announce(t('cleanup.sr.loaded', { n: cards.length }));
    resumeRunningJobs();
  }

  // ── preview ───────────────────────────────────────────────────────────
  //
  // What the press will take, before it takes it. Undo answers "I pressed
  // and I was wrong" -- complete, but only inside twenty seconds and only
  // if you already know. This answers "I do not know what this is", which
  // is the reason nobody pressed these buttons.
  //
  // Senders, never messages: the sender is the unit a false positive comes
  // in, and it compresses a thousand-message pile to a few dozen rows. The
  // messages are one click away through the card's peek link.

  function _previewRow(s, showAccount) {
    const bits = [];
    if (showAccount && s.account) bits.push(s.account);
    bits.push(t('cleanup.preview.row', { n: s.n, unread: s.unread }));
    if (s.last) {
      bits.push(t('cleanup.preview.last', {
        d: new Date(s.last).toLocaleDateString([], { day: 'numeric', month: 'short' }),
      }));
    }
    return {
      label: s.name || s.sender,
      sub: bits.join(' · '),
      // JSON, not `sender|account`: an address may legitimately contain a
      // pipe, and splitting on the first one shifted the fields so the
      // exclusion matched nothing -- mail the user explicitly kept was
      // trashed anyway, with no sign on screen.
      value: JSON.stringify([s.sender, s.account || null]),
    };
  }

  async function askWithPreview(card) {
    const isRead = card.verb === 'mark_read';
    let view = null;
    try {
      view = await api.getCleanupPreview(card.id, account || undefined);
    } catch (_) {
      // The preview is the better dialog, not the only one: a page that
      // refuses to act because a read failed is worse than one that asks
      // the old question.
      view = null;
    }
    if (destroyed) return null;

    if (!view || !view.senders?.length) {
      const ok = await confirmAsync({
        title: cardTitle(card),
        message: t(`cleanup.card.${card.id}.gain`, card.vars),
        confirmLabel: t(`cleanup.card.${card.id}.btn`, card.vars),
        danger: TRASH_CARDS.has(card.id),
      });
      return ok ? {} : null;
    }

    const showAccount = accounts.length > 1;
    const total = view.covered;
    // value -> how many messages that row stands for, so the button can
    // count messages rather than senders.
    const weight = new Map(view.senders.map(
      (s) => [JSON.stringify([s.sender, s.account || null]), s.n]));
    const messagesLeft = (checked) =>
      checked.reduce((n, v) => n + (weight.get(v) || 0), 0);
    const res = await confirmAsync({
      // Marking read moves nothing, and the sheet must not say otherwise.
      title: t(isRead ? 'cleanup.preview.title_read' : 'cleanup.preview.title', { n: total }),
      message: t(`cleanup.card.${card.id}.gain`, card.vars),
      // Per press, and said so: a persistent per-sender exclusion is the
      // rules engine this page exists without.
      note: t(isRead ? 'cleanup.preview.note_read' : 'cleanup.preview.note'),
      confirmLabel: t(`cleanup.card.${card.id}.btn`, { ...card.vars, n: total }),
      danger: TRASH_CARDS.has(card.id),
      checkable: true,
      wide: true,
      details: view.senders.map((s) => _previewRow(s, showAccount)),
      onChange: (checked) => t(`cleanup.card.${card.id}.btn`,
                              { ...card.vars, n: messagesLeft(checked) }),
    });
    if (!res || !res.ok || destroyed) return null;

    const keepSenders = (res.unchecked || []).map((v) => {
      try {
        const [sender, acct] = JSON.parse(v);
        return { sender, account: acct || null };
      } catch (_) {
        return null;   // never widen the press because a row failed to decode
      }
    }).filter(Boolean);
    return { window: view.window, keepSenders };
  }

  // ── actions ───────────────────────────────────────────────────────────

  function showError(li, err) {
    const el = li.querySelector('.cln-card-err');
    // runBulkUnsubscribe hides the action row before the request. Without
    // this the card ends up showing an error and nothing to press.
    const foot = li.querySelector('.cln-card-foot');
    if (foot) foot.hidden = false;
    // Nothing is queued client-side: if the fetch to 127.0.0.1 failed, the
    // handler never ran, so saying "we saved your action" would be a lie.
    const key = err?.timeout ? 'cleanup.err.timeout'
      : err?.network ? 'cleanup.err.offline' : 'cleanup.err.generic';
    el.textContent = t(key);
    el.hidden = false;
    li.dataset.state = 'idle';
    li.querySelector('.cln-card-go').disabled = false;
  }

  async function runCard(card, li, { pick = false } = {}) {
    if (li.dataset.state !== 'idle') return;
    if (card.id === 'unsub_bulk') return runBulkUnsubscribe(card, li);
    if (card.id === 'unsub_one') return runManualUnsubscribe(card, li);

    // Below the gate a card stays one click and a twenty-second undo: at
    // three spams a dialog is the friction, not the safety, and a dialog
    // shown every time is the one that gets dismissed without reading.
    // « Choisir… » asks for the checklist at any size.
    let choice = {};
    if (card.confirm || pick) {
      choice = await askWithPreview(card);
      if (!choice || destroyed) return;
    }

    const go = li.querySelector('.cln-card-go');
    go.disabled = true;
    li.dataset.state = 'running';
    li.querySelector('.cln-card-err').hidden = true;

    let res;
    try {
      res = await api.applyCleanupCard(card.id, account || undefined, {
        window: choice.window,
        keepSenders: choice.keepSenders,
      });
    } catch (err) {
      showError(li, err);
      return;
    }
    if (destroyed) return;
    if (!res.affected) {
      li.querySelector('.cln-card-err').textContent = t('cleanup.err.gone');
      li.querySelector('.cln-card-err').hidden = false;
      later(() => { if (res.suggestions) render(res.suggestions); }, 1200);
      return;
    }
    showDone(card, li, res);
  }

  function showDone(card, li, res) {
    li.dataset.state = 'done';
    li.querySelector('.cln-card-foot').hidden = true;
    const isRead = card.verb === 'mark_read';
    const msg = t(isRead ? 'cleanup.card.done.read' : 'cleanup.card.done.trashed',
                  { n: res.affected });
    const done = li.querySelector('.cln-card-done');
    done.hidden = false;
    done.innerHTML =
      `<p class="cln-card-done-msg">${escapeHtml(msg)}</p>` +
      '<button type="button" class="cln-card-undo"></button>';
    const undoBtn = done.querySelector('.cln-card-undo');

    let left = UNDO_SECONDS;
    const paint = () => { undoBtn.textContent = t('cleanup.card.undo', { s: left }); };
    paint();
    undoBtn.focus();
    announce(t('cleanup.sr.done', { msg, s: UNDO_SECONDS }));

    const tick = every(() => {
      left -= 1;
      if (left > 0) { paint(); return; }
      clearInterval(tick);
      timers.delete(tick);
      // Replaced, not disabled: past the window the queued move has fired and
      // there is no untrash, so an enabled-looking button would be a lie.
      done.innerHTML =
        `<p class="cln-card-done-msg">${escapeHtml(msg)}</p>` +
        `<p class="cln-card-after">${escapeHtml(t(isRead ? 'cleanup.card.after_read' : 'cleanup.card.after_trash'))}</p>` +
        (isRead ? '' : `<a class="cln-card-peek" href="#/inbox?folder=deleted">${escapeHtml(t('cleanup.card.open_trash'))}</a>`);
    }, 1000);

    undoBtn.addEventListener('click', async () => {
      clearInterval(tick);
      timers.delete(tick);
      undoBtn.disabled = true;
      try {
        const back = await api.cleanupUndo(res.undo);
        announce(t('cleanup.card.undone'));
        if (back.suggestions) render(back.suggestions);
      } catch (_) {
        done.innerHTML = `<p class="cln-card-done-msg">${escapeHtml(t('cleanup.card.undo_failed'))}</p>`;
      }
    });

    // An echo in the rail, decoration only: railToast is single-slot and a
    // background sync pass destroys the live toast within seconds.
    window.toast?.({ variant: 'success', message: msg, duration: UNDO_SECONDS * 1000 });
    if (res.suggestions) state = res.suggestions;
  }

  async function hideCard(card, li) {
    li.remove();
    try { render((await api.hideCleanupCard(card.id, account || undefined)).suggestions); }
    catch (_) { /* it will be back next mount */ }
  }

  // ── unsubscribe ───────────────────────────────────────────────────────

  const JOB_KEY = (cardId) => `cleanup.job.${cardId}`;

  async function runBulkUnsubscribe(card, li) {
    // Every subscription, by name, with the mailbox it belongs to, and a
    // box to untick each one. "Se désabonner des 9" used to be the only
    // answer the sheet accepted -- all nine or none -- and nobody wants to
    // leave every list they ever joined.
    const detail = card.detail || (card.vars.names || []).map((name) => ({ name }));
    // Without the sender address a row cannot be told apart from the rest,
    // so the sheet stays read-only rather than offering a choice it could
    // not honour.
    const canPick = detail.length > 1 && detail.every((d) => d.sender);
    const keyOf = (d) => JSON.stringify([d.sender || '', d.account || null]);
    const res = await confirmAsync({
      title: t('cleanup.unsub.sheet.title', { n: card.vars.n }),
      message: t('cleanup.unsub.sheet.body'),
      note: canPick ? t('cleanup.unsub.sheet.note') : '',
      confirmLabel: t('cleanup.unsub.sheet.confirm', { n: card.vars.n }),
      danger: false,
      checkable: canPick,
      wide: detail.length > 6,
      details: detail.map((d) => ({
        label: d.name || d.sender || '',
        sub: [
          multiAccount() && d.account ? d.account : '',
          d.total != null ? t('cleanup.unsub.sheet.row', { n: d.total, read: d.read ?? 0 }) : '',
        ].filter(Boolean).join(' · '),
        value: keyOf(d),
      })),
      onChange: (checked) => t('cleanup.unsub.sheet.confirm', { n: checked.length }),
    });
    if (!res || destroyed) return;

    // One entry per (sender, mailbox): the link is a per-subscription
    // token, and the personal account's token does not unsubscribe the
    // work account.
    let entries = card.entries || card.senders.map((sender) => ({ sender, account: account || null }));
    let kept = [];
    if (canPick && res.unchecked?.length) {
      const off = new Set(res.unchecked);
      kept = detail.filter((d) => off.has(keyOf(d)))
        .map((d) => ({ sender: d.sender, account: d.account || null }));
      const on = detail.filter((d) => !off.has(keyOf(d)));
      entries = on.map((d) => ({ sender: d.sender, account: d.account || null }));
    }
    const chosen = detail.filter((d) => entries.some(
      (e) => e.sender === d.sender && (e.account || null) === (d.account || null)));

    li.dataset.state = 'running';
    li.querySelector('.cln-card-foot').hidden = true;
    // The kept lists first, and not fatal: if remembering them fails they
    // simply come back next visit, which is today's behaviour.
    if (kept.length) {
      try { await api.keepSubscriptions(kept, account || undefined); } catch (_) {}
    }
    let out;
    try {
      out = await api.unsubscribeBulk({ entries, account: account || undefined, purge: false });
    } catch (err) { showError(li, err); return; }

    const ctx = { chosen, kept: kept.length };
    if (!out.job_id) {
      finishUnsub(card, li, { done: 0, failed: 0, skipped: out.skipped || [], ...ctx });
      return;
    }
    try { sessionStorage.setItem(JOB_KEY(card.id), out.job_id); } catch (_) {}
    pollUnsubJob(card, li, out.job_id, out.total, out.skipped || [], ctx);
  }

  function pollUnsubJob(card, li, jobId, total, skipped, ctx = {}) {
    const run = li.querySelector('.cln-card-run');
    const bar = li.querySelector('.cln-bar-fill');
    const text = li.querySelector('.cln-card-run-text');
    run.hidden = false;

    const tick = async () => {
      if (destroyed) return;
      let snap;
      try { snap = await api.getCleanupJob(jobId); }
      catch (_) {
        // The registry is in memory and dies with the process; a 404 means
        // "ask the server what the world looks like now" rather than an error.
        try { sessionStorage.removeItem(JOB_KEY(card.id)); } catch (_) {}
        load();
        return;
      }
      const seen = snap.done + snap.failed;
      // A width, not an animation: prefers-reduced-motion zeroes every
      // animation-duration globally, which freezes a spinner mid-frame.
      bar.style.width = `${snap.total ? (seen / snap.total * 100).toFixed(1) : 0}%`;
      text.textContent = t('cleanup.unsub.running', { done: seen, total: snap.total });
      if (!snap.finished) { later(tick, 700); return; }
      try { sessionStorage.removeItem(JOB_KEY(card.id)); } catch (_) {}
      finishUnsub(card, li, {
        done: snap.done, failed: snap.failed, skipped,
        failedItems: snap.failed_items || [], ...ctx,
      });
    };
    tick();
  }

  function finishUnsub(card, li, { done, failed, skipped, failedItems = [], chosen = null, kept = 0 }) {
    li.dataset.state = 'done';
    li.querySelector('.cln-card-run').hidden = true;
    const box = li.querySelector('.cln-card-done');
    box.hidden = false;
    // Names, not addresses, for the lists that refused -- and only those.
    // The sentence used to read out every list on the card, the nine that
    // went through included.
    const pool = chosen || card.detail || [];
    const nameOf = (addr) => pool.find((d) => d.sender === addr)?.name || addr;
    const refused = failedItems.length
      ? [...new Set(failedItems.map(nameOf))]
      : (chosen ? chosen.map((d) => d.name || d.sender) : (card.vars.names || []));
    let html = '';
    if (failed) {
      html += `<p class="cln-card-done-msg">${escapeHtml(t('cleanup.unsub.partial.title', { done, failed }))}</p>`;
      html += `<p class="cln-card-after">${escapeHtml(t('cleanup.unsub.partial.body', { names: refused.join(', ') }))}</p>`;
    } else {
      html += `<p class="cln-card-done-msg">${escapeHtml(t('cleanup.unsub.done', { n: done }))}</p>`;
    }
    if (skipped && skipped.length) {
      html += `<p class="cln-card-after">${escapeHtml(t('cleanup.unsub.skipped', { names: skipped.map(nameOf).join(', ') }))}</p>`;
    }
    if (kept) {
      html += `<p class="cln-card-after">${escapeHtml(t('cleanup.unsub.kept', { n: kept }))}</p>`;
    }
    box.innerHTML = html;
    announce(box.textContent);
    later(() => load(), 1500);
  }

  async function runManualUnsubscribe(card, li) {
    const go = li.querySelector('.cln-card-go');
    go.disabled = true;
    let res;
    try {
      res = await api.unsubscribeSender({
        sender: card.senders[0],
        account: card.entries?.[0]?.account || account || undefined,
        mode: 'auto',
      });
    } catch (err) { showError(li, err); return; }

    if (res.action_required === 'open_url' || res.action_required === 'open_mailto') {
      const isPage = res.action_required === 'open_url';
      window.open(isPage ? res.target : `mailto:${res.target}`, '_blank', 'noopener,noreferrer');
    }
    // We cannot see what happens on their site, so we ask. Without this the
    // sender stays listed as subscribed and the list never gets shorter.
    li.dataset.state = 'done';
    li.querySelector('.cln-card-foot').hidden = true;
    const box = li.querySelector('.cln-card-done');
    box.hidden = false;
    box.innerHTML =
      `<p class="cln-card-done-msg">${escapeHtml(t('cleanup.card.unsub_one.ask', card.vars))}</p>` +
      `<button type="button" class="cln-card-undo" data-yes>${escapeHtml(t('cleanup.card.unsub_one.yes'))}</button>` +
      `<button type="button" class="cln-card-hide" data-no>${escapeHtml(t('cleanup.card.unsub_one.no'))}</button>`;
    box.querySelector('[data-yes]').addEventListener('click', async () => {
      try {
        await api.markUnsubscribed({
          sender: card.senders[0],
          account: card.entries?.[0]?.account || account || undefined,
        });
        announce(t('cleanup.unsub.marked', { name: card.vars.name }));
      } catch (_) { /* the card simply comes back */ }
      load();
    });
    box.querySelector('[data-no]').addEventListener('click', () => hideCard(card, li));
    box.querySelector('[data-yes]').focus();
  }

  function resumeRunningJobs() {
    for (const li of listEl.querySelectorAll('.cln-card')) {
      const cardId = li.dataset.card;
      let jobId = null;
      try { jobId = sessionStorage.getItem(JOB_KEY(cardId)); } catch (_) {}
      if (!jobId) continue;
      const card = (state?.cards || []).find((c) => c.id === cardId);
      if (card) {
        li.querySelector('.cln-card-foot').hidden = true;
        pollUnsubJob(card, li, jobId, card.vars.n, []);
      }
    }
  }

  async function runHeaderScan() {
    const btn = bannerEl.querySelector('#cln-scan');
    if (btn) btn.disabled = true;
    try {
      const res = await api.runHeaderBackfill();
      if (!res.job_id) { load(); return; }
      const poll = async () => {
        if (destroyed) return;
        let snap;
        try { snap = await api.getCleanupJob(res.job_id); } catch (_) { load(); return; }
        bannerEl.textContent = t('cleanup.banner.scan.running', {
          done: snap.done + snap.failed, total: snap.total });
        if (snap.finished) { load(); return; }
        later(poll, 900);
      };
      poll();
    } catch (_) {
      if (btn) btn.disabled = false;
    }
  }

  // ── loading ───────────────────────────────────────────────────────────

  async function load() {
    if (!state) renderState('loading');
    try {
      const payload = await api.getCleanupSuggestions(account || undefined);
      if (destroyed) return;
      render(payload);
    } catch (err) {
      if (destroyed) return;
      renderState('error');
    }
  }

  // The event stream already broadcasts the sync status;
  // ride that instead of opening another poll.
  const onSyncStatus = (e) => {
    const s = e.detail;
    if (!s || !state || !bannerEl) return;
    if (s.pending_ops > 0 && bannerEl.hidden) {
      bannerEl.textContent = t('cleanup.banner.syncing', { n: s.pending_ops });
      bannerEl.hidden = false;
      bannerEl.dataset.transient = '1';
    } else if (!s.pending_ops && bannerEl.dataset.transient === '1') {
      delete bannerEl.dataset.transient;
      renderBanner(state);
    }
  };
  window.addEventListener('sync-status', onSyncStatus);

  // The roster before the suggestions: with two mailboxes the page's first
  // paint is already scoped, and with one it renders exactly as it did.
  try {
    accounts = await api.getAccounts();
  } catch (_) {
    accounts = [];   // no picker; the page still works, unscoped
  }
  if (!destroyed) renderAccounts();

  await load();

  return () => {
    destroyed = true;
    for (const id of timers) { clearTimeout(id); clearInterval(id); }
    timers.clear();
    window.removeEventListener('sync-status', onSyncStatus);
    // confirmAsync appends to document.body, so the router wiping #view
    // leaves a modal pinned over the next page with everything behind it
    // inert. Through close(), not by deleting the node: the node is not the
    // only thing a dialog owns.
    dismissOpenConfirms();
  };
}
