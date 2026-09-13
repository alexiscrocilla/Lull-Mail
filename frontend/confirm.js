// SPDX-License-Identifier: GPL-3.0-or-later
//
// Branded confirm dialog, shared. Lived inside cleanup.js until the mailbox
// needed it too for bulk delete — copying it would have meant two dialogs
// drifting apart, and window.confirm() looks nothing like the rest of the app.

// Reuse the canonical escaper rather than shipping a third copy that could
// drift from the one cleanup.js and mailbox.js already import.
import { escapeHtml } from '/static/api.js';

/**
 * Show a branded confirm dialog. Returns a Promise<boolean>.
 * opts: { title, message, confirmLabel, danger, details }
 * `details` is an optional array of plain strings rendered as a read-only
 * list — used by the unsubscribe sheet to name the senders. Read-only on
 * purpose: checkboxes here would be configuration in a costume.
 */
export function confirmAsync({
  title = '', message = '', confirmLabel = '', danger = false, details = null,
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
    const list = Array.isArray(details) && details.length
      ? `<ul class="confirm-details">${details
          .map((d) => `<li>${escapeHtml(String(d))}</li>`).join('')}</ul>`
      : '';
    backdrop.innerHTML = `
      <div class="confirm-card" role="alertdialog" aria-modal="true"
           aria-labelledby="confirm-title" aria-describedby="confirm-msg"
           tabindex="-1">
        <div class="confirm-head">
          <span class="confirm-icon ${danger ? 'confirm-icon-danger' : ''}">
            <i data-lucide="${danger ? 'triangle-alert' : 'help-circle'}"></i>
          </span>
          <strong id="confirm-title">${escapeHtml(_title)}</strong>
        </div>
        <p class="confirm-msg" id="confirm-msg">${escapeHtml(message)}</p>
        ${list}
        <div class="confirm-actions">
          <button class="confirm-btn-cancel">${_t('confirm.cancel')}</button>
          <button class="confirm-btn-ok ${danger ? 'is-danger' : ''}">${escapeHtml(_label)}</button>
        </div>
      </div>`;

    const card = backdrop.querySelector('.confirm-card');
    const focusables = () => [...card.querySelectorAll('button')]
      .filter((el) => !el.disabled);

    // The previous version only removed the Escape handler when Escape was
    // the thing that closed the dialog — clicking Cancel or OK left a live
    // document-level listener behind, one per dialog ever opened.
    const onKey = (e) => {
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
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      try { opener?.focus?.(); } catch (_) { /* the trigger may be gone */ }
      resolve(result);
    };

    backdrop.querySelector('.confirm-btn-cancel').addEventListener('click', () => close(false));
    backdrop.querySelector('.confirm-btn-ok').addEventListener('click', () => close(true));
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
