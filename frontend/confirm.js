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
 * opts: { title, message, confirmLabel, danger }
 */
export function confirmAsync({ title = '', message = '', confirmLabel = '', danger = false } = {}) {
  const _t = window.t || ((k) => k);
  const _title = title || _t('cleanup.confirm.default_title');
  const _label = confirmLabel || _t('cleanup.confirm.default_ok');
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';
    backdrop.innerHTML = `
      <div class="confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div class="confirm-head">
          <span class="confirm-icon ${danger ? 'confirm-icon-danger' : ''}">
            <i data-lucide="${danger ? 'triangle-alert' : 'help-circle'}"></i>
          </span>
          <strong id="confirm-title">${escapeHtml(_title)}</strong>
        </div>
        <p class="confirm-msg">${escapeHtml(message)}</p>
        <div class="confirm-actions">
          <button class="confirm-btn-cancel">${_t('cleanup.cancel')}</button>
          <button class="confirm-btn-ok ${danger ? 'is-danger' : ''}">${escapeHtml(_label)}</button>
        </div>
      </div>`;

    // The previous version only removed the Escape handler when Escape was
    // the thing that closed the dialog — clicking Cancel or OK left a live
    // document-level listener behind, one per dialog ever opened.
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    const close = (result) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      resolve(result);
    };

    backdrop.querySelector('.confirm-btn-cancel').addEventListener('click', () => close(false));
    backdrop.querySelector('.confirm-btn-ok').addEventListener('click', () => close(true));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(false); });
    document.addEventListener('keydown', onKey);

    document.body.appendChild(backdrop);
    window.lucide?.createIcons({ nodes: [backdrop] });
    backdrop.querySelector('.confirm-btn-ok').focus();
  });
}
