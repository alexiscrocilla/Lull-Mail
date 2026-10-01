// SPDX-License-Identifier: GPL-3.0-or-later
//
// In-app preview for one attachment — the eye button next to Télécharger.
//
// Why a modal and not a navigation: the read pane used to answer Télécharger
// with `window.location.href = /api/attachments/<id>/download`, and on macOS
// WKWebView answers `canShowMIMEType()` with True for a PDF or an image. It
// allowed the navigation, drew the file in the main frame, and the app was
// gone — pywebview disables reload and blocks the Delete-key back navigation,
// so the only way out was quitting. Here the bytes land in a frame the user
// can close, and the window itself never navigates anywhere.
//
// What can be shown is decided by the backend: each attachment summary
// carries `previewable`, computed from the same MIME whitelist the /preview
// route enforces (src/attachment_security.py). The UI can never offer a
// preview the server would refuse, and nothing outside `safe` is drawable.

import { api, escapeHtml } from '/static/api.js';

// Text is not handed to a frame: it is fetched and escaped into a <pre>, so a
// file that lies about being text (HTML in a .txt) is drawn as the characters
// it contains. This is the cap on how much of it we read.
const TEXT_PREVIEW_MAX = 200_000;

// One at a time. Keeping the closer (and not the node) is what guarantees the
// document-level key listener comes off: removing the node by hand would leave
// a Tab trap behind, pointed at a card no longer in the document.
let _close = null;

/** Close the open preview, if any. A view's teardown must call this — the
 *  backdrop is appended to document.body, which the router's #view wipe does
 *  not touch, so it would otherwise stay pinned over whatever mounts next. */
export function dismissAttachmentPreview() {
  try { _close?.(); } catch (_) { /* a broken card must not block teardown */ }
}

/** 'image' | 'pdf' | 'text' — how to draw this attachment.
 *
 *  The content type comes from the backend, which prefers the sniffed value
 *  over the one the email declared. The extension is only a fallback for rows
 *  scanned before sniffing stored a type. */
function kindOf(att) {
  const type = String(att.content_type || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('text/')) return 'text';
  const ext = String(att.filename || '').toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
  return 'text';
}

/**
 * Show one attachment inside a modal.
 *
 * `att` is a row from the email detail payload: {id, filename, size,
 * content_type}. `onDownload` is called when the card's Télécharger button is
 * pressed — the save-to-disk flow lives with the row that owns it, so there is
 * one place where a download is started and one toast that reports it.
 */
export function openAttachmentPreview(att, { onDownload = null } = {}) {
  const t = window.t || ((k) => k);
  dismissAttachmentPreview();

  const opener = document.activeElement;
  const url = api.attachmentPreviewUrl(att.id);
  const kind = kindOf(att);

  const backdrop = document.createElement('div');
  backdrop.className = 'attprev-backdrop';
  backdrop.innerHTML = `
    <div class="attprev-card" role="dialog" aria-modal="true"
         aria-labelledby="attprev-name" tabindex="-1">
      <header class="attprev-head">
        <span class="attprev-head-icon"><i data-lucide="eye"></i></span>
        <span class="attprev-head-text">
          <strong id="attprev-name">${escapeHtml(att.filename || '')}</strong>
          <span class="attprev-head-sub">${escapeHtml(att.content_type || '')}</span>
        </span>
        ${onDownload ? `<button type="button" class="attprev-dl">
          <i data-lucide="download"></i><span>${t('mb.att.download')}</span>
        </button>` : ''}
        <button type="button" class="attprev-close"
                aria-label="${t('mb.att.preview_close')}"><i data-lucide="x"></i></button>
      </header>
      <div class="attprev-body" data-kind="${kind}">
        <p class="attprev-state">${t('mb.att.preview_loading')}</p>
      </div>
    </div>`;

  const card = backdrop.querySelector('.attprev-card');
  const body = backdrop.querySelector('.attprev-body');
  // Cleared on close: a card dismissed in the first seconds would otherwise
  // have its timeout fire against a detached node.
  let guard = null;

  const onKey = (e) => {
    // The node was removed by something other than close(). Unhook rather
    // than trapping Tab against a detached card for the rest of the session.
    if (!backdrop.isConnected) { close(); return; }
    if (e.key === 'Escape') {
      // Stop here: the mailbox's own Escape handler clears the selection and
      // closes popovers, and the user meant this card.
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...card.querySelectorAll('button:not([disabled])')];
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

  const close = () => {
    if (_close !== close) return;   // already closed
    _close = null;
    clearTimeout(guard);
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    try { opener?.focus?.(); } catch (_) { /* the trigger may be gone */ }
  };
  _close = close;

  const fail = (msg) => {
    body.innerHTML = `<p class="attprev-state attprev-failed">${escapeHtml(msg)}</p>`;
  };

  if (kind === 'image') {
    const img = document.createElement('img');
    img.className = 'attprev-img';
    img.alt = att.filename || '';
    img.addEventListener('load', () => {
      body.querySelector('.attprev-state')?.remove();
    });
    img.addEventListener('error', () => fail(t('mb.att.preview_failed')));
    img.src = url;
    body.appendChild(img);
  } else if (kind === 'pdf') {
    const frame = document.createElement('iframe');
    frame.className = 'attprev-frame';
    frame.title = att.filename || '';
    // Whether a PDF draws inside a frame is the engine's call, and the three
    // we ship on do not answer the same way (WebView2 and WKWebView carry a
    // viewer; a stripped build may carry none and never load the document at
    // all). If nothing has loaded by now, say so and point at the download
    // rather than leaving a white rectangle with no explanation.
    guard = setTimeout(() => {
      if (backdrop.isConnected) fail(t('mb.att.preview_failed'));
    }, 6000);
    // Same flags as the message-body iframe. No allow-scripts, and crucially
    // no allow-top-navigation: whatever the document does, it cannot replace
    // the app — which is the entire bug this feature exists to fix. Popups
    // are allowed and escape the sandbox so a link inside a PDF reaches the
    // OS browser (pywebview's OPEN_EXTERNAL_LINKS_IN_BROWSER) instead of
    // loading a web page into this frame.
    frame.setAttribute(
      'sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    );
    frame.addEventListener('load', () => {
      clearTimeout(guard);
      body.querySelector('.attprev-state')?.remove();
    });
    frame.addEventListener('error', () => {
      clearTimeout(guard);
      fail(t('mb.att.preview_failed'));
    });
    frame.src = url;
    body.appendChild(frame);
  } else {
    // Fetched and escaped rather than framed: `nosniff` plus a text/plain
    // Content-Type already stops the engine treating markup as markup, and a
    // <pre> we fill ourselves cannot be anything but characters.
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then((text) => {
        if (!backdrop.isConnected) return;
        const clipped = text.length > TEXT_PREVIEW_MAX;
        const pre = document.createElement('pre');
        pre.className = 'attprev-text';
        pre.textContent = clipped ? text.slice(0, TEXT_PREVIEW_MAX) : text;
        body.innerHTML = '';
        body.appendChild(pre);
        if (clipped) {
          const note = document.createElement('p');
          note.className = 'attprev-state';
          note.textContent = t('mb.att.preview_clipped');
          body.appendChild(note);
        }
      })
      .catch(() => { if (backdrop.isConnected) fail(t('mb.att.preview_failed')); });
  }

  backdrop.querySelector('.attprev-close').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  if (onDownload) {
    const dl = backdrop.querySelector('.attprev-dl');
    dl.addEventListener('click', () => {
      // The row's handler owns the save, the toast and the "Afficher dans le
      // dossier" follow-up — one place starts a download, one toast reports
      // it. The card stays open so the user can keep reading.
      dl.disabled = true;
      Promise.resolve(onDownload()).finally(() => {
        if (dl.isConnected) dl.disabled = false;
      });
    });
  }
  document.addEventListener('keydown', onKey, true);

  document.body.appendChild(backdrop);
  window.lucide?.createIcons({ nodes: [backdrop] });
  card.focus();
  return close;
}
