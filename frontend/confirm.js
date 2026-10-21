// SPDX-License-Identifier: GPL-3.0-or-later
//
// Branded confirm dialog, shared. Lived inside cleanup.js until the mailbox
// needed it too for bulk delete — copying it would have meant two dialogs
// drifting apart, and window.confirm() looks nothing like the rest of the app.

// Reuse the canonical escaper rather than shipping a third copy that could
// drift from the one cleanup.js and mailbox.js already import.
import { escapeHtml } from '/static/api.js';

// Every dialog currently on screen, so a view being torn down can close one
// properly instead of deleting its node. Deleting the node skips close(),
// which is what removes the document-level capture keydown listener -- and
// that listener's Tab trap then preventDefaults every Tab in the app, for
// the rest of the session, against a card that is no longer in the document.
const _open = new Set();

/** Close every open confirm dialog, resolving each to `false`.
 *
 *  A view's teardown must call this rather than removing `.confirm-backdrop`
 *  itself: the promise has to settle and the listener has to come off. */
export function dismissOpenConfirms() {
  for (const close of [..._open]) {
    try { close(false); } catch (_) { /* one bad dialog must not block the rest */ }
  }
}

/**
 * Show a branded confirm dialog.
 *
 * opts: { title, message, note, confirmLabel, danger, details, checkable,
 *         wide, onChange }
 *
 * `details` is an optional list of what the action will touch. Entries are
 * either plain strings or `{label, sub, value}` objects — `sub` is a second,
 * quieter line (the mailbox, the counts) and `value` is what comes back.
 *
 * With `checkable`, each entry gets a ticked checkbox and the promise
 * resolves to `{ok: true, unchecked: [value, …]}` instead of `true`.
 * `onChange(checkedValues, allValues)` is called on every tick and may
 * return the button's new label -- the caller counts, because a row can
 * stand for one thing or for forty and only it knows which. That is
 * for a preview of an irreversible or wide-reaching action, where "this is
 * what I am about to do, and these two are wrong" has no other expression.
 * Without it the list stays read-only, which is right for everything whose
 * set the user already chose.
 *
 * Returns a Promise<boolean> — or, when `checkable`, a Promise of
 * `false | {ok: true, unchecked: string[]}`.
 */
export function confirmAsync({
  title = '', message = '', note = '', confirmLabel = '', danger = false,
  details = null, checkable = false, wide = false, onChange = null,
} = {}) {
  const _t = window.t || ((k) => k);
  // confirm.* and not cleanup.*: this dialog is shared with the mailbox, and
  // a sweep of the cleanup namespace would leave every confirm button in the
  // app rendering a raw key string.
  const _title = title || _t('confirm.default_title');
  const _label = confirmLabel || _t('confirm.default_ok');
  // Focus goes back where it came from on close. Without this the trigger is
  // removed from under the user and focus falls to <body>, which for a
  // keyboard or screen-reader user means starting the page again.
  const opener = document.activeElement;

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';
    const rows = Array.isArray(details) ? details : [];
    const asEntry = (d, i) => (typeof d === 'object' && d !== null
      ? { label: String(d.label ?? ''), sub: String(d.sub ?? ''), value: String(d.value ?? i) }
      : { label: String(d), sub: '', value: String(i) });
    const entries = rows.map(asEntry);
    const body = (e) =>
      `<span class="confirm-detail-label">${escapeHtml(e.label)}</span>`
      + (e.sub ? `<span class="confirm-detail-sub">${escapeHtml(e.sub)}</span>` : '');
    const list = entries.length
      ? `<ul class="confirm-details${checkable ? ' is-checkable' : ''}">${entries
          .map((e) => (checkable
            ? `<li><label><input type="checkbox" checked value="${escapeHtml(e.value)}">`
              + `<span class="confirm-detail-text">${body(e)}</span></label></li>`
            : `<li><span class="confirm-detail-text">${body(e)}</span></li>`))
          .join('')}</ul>`
      : '';
    // A checklist of forty is not a choice anyone can make one box at a
    // time: say how many are ticked, offer all-or-none, and past a screenful
    // let the user find the one they mean by typing it.
    const FILTER_FROM = 8;
    const tools = checkable && entries.length > 1
      ? `<div class="confirm-tools">
           ${entries.length > FILTER_FROM
             ? `<input type="search" class="confirm-filter" autocomplete="off"
                       placeholder="${escapeHtml(_t('confirm.filter_ph'))}"
                       aria-label="${escapeHtml(_t('confirm.filter_ph'))}">`
             : ''}
           <span class="confirm-count" aria-hidden="true"></span>
           <button type="button" class="confirm-toggle-all"></button>
         </div>
         <p class="confirm-nomatch" hidden>${escapeHtml(_t('confirm.filter_none'))}</p>`
      : '';
    backdrop.innerHTML = `
      <div class="confirm-card${wide ? ' is-wide' : ''}" role="alertdialog" aria-modal="true"
           aria-labelledby="confirm-title" aria-describedby="confirm-msg"
           tabindex="-1">
        <div class="confirm-head">
          <span class="confirm-icon ${danger ? 'confirm-icon-danger' : ''}">
            <i data-lucide="${danger ? 'triangle-alert' : 'help-circle'}"></i>
          </span>
          <strong id="confirm-title">${escapeHtml(_title)}</strong>
        </div>
        <p class="confirm-msg" id="confirm-msg">${escapeHtml(message)}</p>
        ${note ? `<p class="confirm-note">${escapeHtml(note)}</p>` : ''}
        ${tools}
        ${list}
        <p class="confirm-live" aria-live="polite"></p>
        <div class="confirm-actions">
          <button class="confirm-btn-cancel">${_t('confirm.cancel')}</button>
          <button class="confirm-btn-ok ${danger ? 'is-danger' : ''}">${escapeHtml(_label)}</button>
        </div>
      </div>`;

    const card = backdrop.querySelector('.confirm-card');
    // Not just buttons. With a checkable list the trap would otherwise yank
    // focus off every checkbox the moment the user Tabbed onto one. Rows the
    // filter hid are skipped: focus() on them does nothing, so a trap that
    // wrapped onto one would let Tab walk out of the dialog.
    const focusables = () => [...card.querySelectorAll('button, input:not([disabled])')]
      .filter((el) => !el.disabled && !el.closest('[hidden]'));

    // The previous version only removed the Escape handler when Escape was
    // the thing that closed the dialog — clicking Cancel or OK left a live
    // document-level listener behind, one per dialog ever opened.
    const onKey = (e) => {
      // The node was removed by something other than close(). Settle and
      // unhook rather than trapping Tab against a detached card forever.
      if (!backdrop.isConnected) { close(false); return; }
      // While a filter is typed, the first Escape clears it, wherever focus
      // is (it is usually on a checkbox by then). Closing instead would
      // throw away every box the user had just unticked.
      const filterEl = card.querySelector('.confirm-filter');
      if (e.key === 'Escape' && filterEl?.value) {
        e.preventDefault();
        filterEl.value = '';
        filterEl.dispatchEvent(new Event('input'));
        filterEl.focus();
        return;
      }
      if (e.key === 'Escape') { close(false); return; }
      if (e.key !== 'Tab') return;
      // Trap: without this, Tab walks the page behind the modal.
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      } else if (!card.contains(document.activeElement)) {
        e.preventDefault(); first.focus();
      }
    };
    const close = (result) => {
      _open.delete(close);
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      try { opener?.focus?.(); } catch (_) { /* the trigger may be gone */ }
      resolve(result);
    };
    _open.add(close);

    const unchecked = () => [...card.querySelectorAll('.confirm-details input:not(:checked)')]
      .map((el) => el.value);
    const okBtn = backdrop.querySelector('.confirm-btn-ok');
    if (checkable) {
      const live = card.querySelector('.confirm-live');
      const boxes = () => [...card.querySelectorAll('.confirm-details input')];
      const shown = () => boxes().filter((el) => !el.closest('li').hidden);
      const countEl = card.querySelector('.confirm-count');
      const toggleBtn = card.querySelector('.confirm-toggle-all');
      const sync = () => {
        const checked = boxes().filter((el) => el.checked).map((el) => el.value);
        // The button carries the live count, so the number the user presses
        // is the number they are about to act on and not the one the card
        // showed a moment ago. The caller does the counting: a row can stand
        // for one thing or for forty, and only it knows which.
        if (typeof onChange === 'function') {
          const text = onChange(checked, entries.map((e) => e.value));
          if (text) { okBtn.textContent = text; live.textContent = text; }
        }
        okBtn.disabled = checked.length === 0;
        if (countEl) {
          countEl.textContent = _t('confirm.selected',
            { n: checked.length, total: entries.length });
        }
        if (toggleBtn) {
          // Acts on the rows on screen: with a filter typed, "tout décocher"
          // means the ones that matched, not the ones hidden from view.
          const vis = shown();
          const allOn = vis.length > 0 && vis.every((el) => el.checked);
          toggleBtn.textContent = _t(allOn ? 'confirm.select_none' : 'confirm.select_all');
          toggleBtn.dataset.next = allOn ? 'off' : 'on';
          toggleBtn.disabled = vis.length === 0;
        }
      };
      card.addEventListener('change', (e) => {
        if (e.target.matches('.confirm-details input')) sync();
      });
      toggleBtn?.addEventListener('click', () => {
        const on = toggleBtn.dataset.next === 'on';
        for (const el of shown()) el.checked = on;
        sync();
      });
      const filter = card.querySelector('.confirm-filter');
      const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      filter?.addEventListener('input', () => {
        const needle = fold(filter.value.trim());
        let any = false;
        for (const li of card.querySelectorAll('.confirm-details li')) {
          const hit = !needle || fold(li.textContent || '').includes(needle);
          li.hidden = !hit;
          any = any || hit;
        }
        card.querySelector('.confirm-nomatch').hidden = any;
        sync();
      });
      sync();
    }
    backdrop.querySelector('.confirm-btn-cancel').addEventListener('click', () => close(false));
    okBtn.addEventListener('click',
      () => close(checkable ? { ok: true, unchecked: unchecked() } : true));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(backdrop);
    window.lucide?.createIcons({ nodes: [backdrop] });
    // Focus the dialog itself, not a button: the title and the body are the
    // announcement, and landing on a button reads only its label. Tab from
    // here reaches Cancel first, which is the safe choice on a dangerous
    // action and the reason Enter can no longer delete by momentum.
    card.focus();
  });
}
