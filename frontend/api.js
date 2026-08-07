// SPDX-License-Identifier: GPL-3.0-or-later
// Thin fetch wrappers around the FastAPI backend.

// Default per-request timeout. Callers hitting the LLM (reanalyze / draft /
// assistant) pass a larger `timeoutMs` since local generation can take
// 10-30s. Without any bound a hung backend would spin the UI forever.
const DEFAULT_TIMEOUT_MS = 30000;

async function j(url, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: extSignal, ...rest } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // Honour a caller-provided AbortSignal alongside the timeout.
  if (extSignal) {
    if (extSignal.aborted) ctrl.abort();
    else extSignal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  let r;
  try {
    r = await fetch(url, { ...rest, signal: ctrl.signal });
  } catch (e) {
    // Normalise abort/network failures so callers always get `.status`.
    // Three distinct outcomes: the caller aborted on purpose (extSignal
    // fired), our own timeout fired, or the fetch genuinely failed. Only
    // the last is a network error — a deliberate cancellation must not
    // masquerade as "server unreachable".
    const isAbort = !!(e && e.name === 'AbortError');
    const cancelled = isAbort && !!extSignal?.aborted;
    const timedOut = isAbort && !cancelled;
    const err = new Error(
      cancelled ? 'Requête annulée.'
      : timedOut ? 'La requête a expiré. Vérifiez votre connexion et réessayez.'
                 : 'Impossible de joindre le serveur.'
    );
    err.status = 0;
    err.timeout = !!timedOut;
    err.cancelled = !!cancelled;
    err.network = !isAbort;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    // The backend speaks French in its `detail` field for FastAPI
    // HTTPException, in `body.detail` for the rate-limit handler, and
    // sometimes nests `{error, message, stage}` under `detail` (the
    // /api/emails/send endpoint). Walk those shapes so callers get a
    // human-readable message instead of "429 Too Many Requests on …".
    let body = null;
    try {
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('application/json')) body = await r.json();
    } catch (_) { /* ignore parse errors */ }
    const d = body && body.detail !== undefined ? body.detail : body;
    let msg;
    if (typeof d === 'string')              msg = d;
    else if (d && typeof d.message === 'string') msg = d.message;
    else if (d && typeof d.error   === 'string') msg = d.error;
    else if (body && typeof body.message === 'string') msg = body.message;
    else msg = `${r.status} ${r.statusText}`;
    const err = new Error(msg);
    err.status = r.status;
    err.detail = d;
    err.retryAfter = parseInt(r.headers.get('Retry-After') || '0', 10) || 0;
    throw err;
  }
  // 204/empty bodies (some DELETEs) would make r.json() throw a misleading
  // SyntaxError — return null instead.
  if (r.status === 204) return null;
  return r.json();
}

export const api = {
  getEmails(params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      q.set(k, v);
    }
    const qs = q.toString();
    return j(`/api/emails${qs ? '?' + qs : ''}`);
  },

  getEmail(intId) {
    return j(`/api/emails/${intId}`);
  },

  // Server-side search with Gmail-style operators. Returns {parsed, results}.
  searchEmails(q, params = {}) {
    const sp = new URLSearchParams({ q });
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      sp.set(k, v);
    }
    return j(`/api/emails/search?${sp.toString()}`);
  },

  // All messages of the conversation an email belongs to. {thread_id, messages[]}.
  getThread(intId) {
    return j(`/api/emails/${intId}/thread`);
  },

  // Bounded AI agent over the local mailbox. {text, trace[]}. 409 when AI off.
  assistantAsk(message) {
    return j('/api/assistant/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      timeoutMs: 120000,  // agent loop can chain several LLM calls
    });
  },

  patchEmail(intId, patch) {
    return j(`/api/emails/${intId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  reanalyzeEmail(intId) {
    // Wraps the AI call so the rail indicator (coin-flip loader) spins
    // for the duration of the request. setAiBusy is a no-op if rail-toast
    // hasn't loaded yet (rare — it's bundled early in index.html).
    window.railToast?.setAiBusy?.(true);
    return j(`/api/emails/${intId}/reanalyze`, { method: 'POST', timeoutMs: 90000 })
      .finally(() => window.railToast?.setAiBusy?.(false));
  },

  generateDraft(intId) {
    // Drafter is the heaviest local LLM call (~5-15 s cold start). The
    // rail spinner is the only feedback for users not watching the
    // composer pane.
    window.railToast?.setAiBusy?.(true);
    return j(`/api/emails/${intId}/draft`, { method: 'POST', timeoutMs: 90000 })
      .finally(() => window.railToast?.setAiBusy?.(false));
  },

  // ── Labels (Phase 3) ─────────────────────────────────────
  // Personal multi-label assignment, separate from the AI category
  // enum. The /api/emails responses now include a labels[] array on
  // every row; setEmailLabels does a replace-all PUT.
  getLabels() {
    return j('/api/labels');
  },
  createLabel(payload) {
    return j('/api/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  updateLabel(id, patch) {
    return j(`/api/labels/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },
  deleteLabel(id) {
    return j(`/api/labels/${id}`, { method: 'DELETE' });
  },
  setEmailLabels(intId, labelIds) {
    return j(`/api/emails/${intId}/labels`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label_ids: labelIds }),
    });
  },

  // ── Custom folders (Phase 4) ──────────────────────────────
  // App-only sidebar folders. Built-ins (inbox/sent/draft/deleted)
  // stay hardcoded in mailbox.js's FOLDERS const; these are merged
  // into the sidebar list at runtime.
  getFolders() {
    return j('/api/folders');
  },
  createFolder(name) {
    return j('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  },
  updateFolder(id, patch) {
    return j(`/api/folders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },
  deleteFolder(id) {
    return j(`/api/folders/${id}`, { method: 'DELETE' });
  },

  // ── Outbound uploads (Phase 4) ────────────────────────────
  // Stage a file in `OUTBOX_ATTACHMENTS_DIR/<uuid>/<file>` so it can
  // later be referenced from a SendRequest's `attachments` /
  // `inline_images` array. Returns `{upload_id, filename, size,
  // content_type}`. The send call deletes the staged file on
  // success; cancelled drafts can be cleaned via deleteUpload.
  async uploadAttachment(file) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);  // up to 25 MB
    let r;
    try {
      r = await fetch('/api/uploads', { method: 'POST', body: fd, signal: ctrl.signal });
    } catch (e) {
      const err = new Error(e?.name === 'AbortError'
        ? "L'envoi de la pièce jointe a expiré."
        : 'Impossible de joindre le serveur.');
      err.status = 0;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try { body = await r.json(); } catch (_) {}
    if (!r.ok) {
      const detail = (body && body.detail) || body || {};
      const msg = (typeof detail === 'string' ? detail : detail.message || detail.error)
        || `${r.status} ${r.statusText}`;
      const err = new Error(msg);
      err.status = r.status;
      err.detail = detail;
      throw err;
    }
    return body;
  },
  deleteUpload(uploadId) {
    return j(`/api/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' });
  },

  // ── Drafts (Phase 2) ─────────────────────────────────────
  // User-typed compose drafts persisted server-side. Distinct from
  // generateDraft() above which produces an AI suggestion tied to an
  // inbound email's int_id (stored in emails.draft_response).
  getDrafts(account, opts = {}) {
    const q = new URLSearchParams();
    if (account) q.set('account', account);
    if (opts.inReplyToInt != null) q.set('in_reply_to_int', String(opts.inReplyToInt));
    const qs = q.toString();
    return j(`/api/drafts${qs ? '?' + qs : ''}`);
  },
  createDraft(payload) {
    return j('/api/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },
  updateDraft(id, patch) {
    return j(`/api/drafts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },
  deleteDraft(id) {
    return j(`/api/drafts/${id}`, { method: 'DELETE' });
  },

  // Outbound send. Synchronous — resolves once the SMTP server accepted
  // (or rejected) the message. The backend persists an outbox row before
  // attempting delivery, so a network failure mid-call still leaves a
  // diagnostic trace in the DB. On error we throw an Error whose
  // `message` carries the French sentence built server-side, suitable
  // for direct display via window.toast.
  async sendEmail(payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);  // synchronous SMTP roundtrip
    let r;
    try {
      r = await fetch('/api/emails/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (e) {
      const err = new Error(e?.name === 'AbortError'
        ? "L'envoi a expiré. Le message n'a peut-être pas été envoyé."
        : 'Impossible de joindre le serveur.');
      err.status = 0;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    let body = null;
    try { body = await r.json(); } catch (_) { /* non-JSON body */ }
    if (!r.ok) {
      const detail = (body && body.detail !== undefined) ? body.detail : (body || {});
      // FastAPI's standard `HTTPException(detail="…")` ships a STRING here;
      // the structured send errors ship `{message,error,stage}`. Handle both
      // (the old `detail.message` path returned undefined on a string detail,
      // so the user saw "500 Internal Server Error" instead of the message).
      const msg = (typeof detail === 'string'
                    ? detail
                    : (detail && (detail.message || detail.error)))
                  || `${r.status} ${r.statusText}`;
      const err = new Error(msg);
      err.stage = (detail && typeof detail === 'object' && detail.stage) || '';
      err.status = r.status;
      throw err;
    }
    return body || { ok: true };
  },

  getAttachments(intId) {
    return j(`/api/emails/${intId}/attachments`);
  },

  // The download URL is exposed (instead of fetched as JSON) so the browser
  // can stream the file directly via an <a download> click. `confirm=1` is
  // required server-side for `dangerous` files; the UI adds it after the
  // user accepts the warning modal.
  attachmentDownloadUrl(attId, { confirm = false } = {}) {
    const qs = confirm ? '?confirm=1' : '';
    return `/api/attachments/${attId}/download${qs}`;
  },

  attachmentBackfillStats(account) {
    const qs = account ? `?account=${encodeURIComponent(account)}` : '';
    return j(`/api/attachments/backfill/stats${qs}`);
  },

  triggerAttachmentBackfill({ account, limit } = {}) {
    const q = new URLSearchParams();
    if (account) q.set('account', account);
    if (limit) q.set('limit', String(limit));
    const qs = q.toString();
    return j(`/api/attachments/backfill${qs ? '?' + qs : ''}`, { method: 'POST' });
  },

  getStats()    { return j('/api/stats'); },
  getAccounts() { return j('/api/accounts'); },

  getTopSenders(params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      q.set(k, v);
    }
    const qs = q.toString();
    return j(`/api/cleanup/senders${qs ? '?' + qs : ''}`);
  },

  cleanupSender(sender, action, account) {
    return j('/api/cleanup/sender', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender, action, account }),
    });
  },

  getCleanupJob(jobId) {
    return j(`/api/cleanup/jobs/${encodeURIComponent(jobId)}`);
  },

  previewCleanupRule(filter, limit = 200) {
    const qs = limit ? `?limit=${encodeURIComponent(limit)}` : '';
    return j(`/api/cleanup/rules/preview${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(filter),
    });
  },

  runCleanupRule(filter, action) {
    return j('/api/cleanup/rules/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter, action }),
    });
  },

  getUnsubscribeSenders(account) {
    const qs = account ? `?account=${encodeURIComponent(account)}` : '';
    return j(`/api/cleanup/unsubscribe/senders${qs}`);
  },

  getUnsubscribeStats(account) {
    const qs = account ? `?account=${encodeURIComponent(account)}` : '';
    return j(`/api/cleanup/unsubscribe/stats${qs}`);
  },

  runHeaderBackfill(account) {
    const qs = account ? `?account=${encodeURIComponent(account)}` : '';
    return j(`/api/cleanup/unsubscribe/backfill${qs}`, { method: 'POST' });
  },

  unsubscribeSender({ sender, account, mode = 'auto', purge = false, force = false }) {
    return j('/api/cleanup/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender, account, mode, purge, force }),
    });
  },

  unsubscribeBulk({ senders, account, purge = false }) {
    return j('/api/cleanup/unsubscribe/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senders, account, purge }),
    });
  },

  getCustomRules() {
    return j('/api/cleanup/custom-rules');
  },

  createCustomRule(body) {
    return j('/api/cleanup/custom-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },

  updateCustomRule(id, patch) {
    return j(`/api/cleanup/custom-rules/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  deleteCustomRule(id) {
    return j(`/api/cleanup/custom-rules/${id}`, { method: 'DELETE' });
  },

  triggerSync() {
    return j('/api/sync', { method: 'POST' });
  },

  getSyncStatus()   { return j('/api/sync/status'); },

  getDashboard()    { return j('/api/dashboard/status'); },
  skipQueue()       { return j('/api/queue/skip-all', { method: 'POST' }); },
  getLogsTail(since, lines = 50) {
    const q = new URLSearchParams();
    if (since) q.set('since', since);
    q.set('lines', String(lines));
    return j(`/api/logs/tail?${q.toString()}`);
  },
};

// ── Shared utilities ────────────────────────────────────────

// Avatar backgrounds. Always paired with white initials (style.css sets
// `color:#fff` on .mb-avatar and eight sibling selectors), so every entry has
// to clear 4.5:1 against white on its own — the value is injected inline, so
// it is identical in both themes and no dark-mode rule can rescue it.
//
// The previous set was the Tailwind -500 ramp and failed all ten, from 2.15:1
// (amber) to 4.23:1 (violet). These are the -700/-800 equivalents of the same
// hue families: same character, 5.02:1 at worst. The teal slot moved to cyan
// so it stays distinguishable from the first entry once both are darkened.
const PALETTE = [
  '#0F766E', '#1D4ED8', '#7E22CE', '#B45309', '#B91C1C',
  '#047857', '#6D28D9', '#BE185D', '#155E75', '#C2410C',
];

export function avatarColor(seed) {
  if (!seed) return PALETTE[0];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export function initials(input) {
  if (!input) return '?';
  const m = input.match(/([^\s<@]+)/g) || [];
  if (m.length === 0) return input.slice(0, 2).toUpperCase();
  if (m.length === 1) return m[0].slice(0, 2).toUpperCase();
  return (m[0][0] + m[1][0]).toUpperCase();
}

export function senderName(raw) {
  if (!raw) return 'Inconnu';
  // "Foo Bar <foo@bar.com>" → "Foo Bar"
  const m = raw.match(/^"?([^"<]+?)"?\s*<.+>$/);
  if (m) return m[1].trim();
  return raw;
}

export function senderEmail(raw) {
  if (!raw) return '';
  const m = raw.match(/<([^>]+)>/);
  return m ? m[1] : raw;
}

export function senderDomain(email) {
  if (!email) return '';
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase() : '';
}

// Extract the registrable root domain (strip subdomains).
// e.g. notify.proton.me → proton.me, info.optic2000.com → optic2000.com
function rootDomain(domain) {
  if (!domain) return '';
  const parts = domain.split('.');
  if (parts.length <= 2) return domain;
  // Handle common two-part TLDs: co.uk, com.br, org.uk, etc.
  const twoPartTLDs = new Set(['co.uk','com.br','org.uk','gov.uk','net.au','com.au','co.jp','co.nz']);
  const last2 = parts.slice(-2).join('.');
  if (twoPartTLDs.has(last2)) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

export function avatarImgHtml(_email, _size = 40) {
  // Privacy: this used to fetch each sender's domain favicon from
  // google.com/s2/favicons, leaking the identity of every correspondent to
  // Google (and relying on CSP-hostile inline onload/onerror handlers) — at
  // odds with an app that blocks remote images by default. Avatars now fall
  // back to the initials + colour bubble already rendered underneath.
  return '';
}

export function relativeTime(iso) {
  if (!iso) return '—';
  let d;
  try { d = new Date(iso.replace(' ', 'T')); } catch { return iso; }
  if (isNaN(d.getTime())) return iso;
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return `il y a ${Math.floor(diff)}s`;
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  if (diff < 7 * 86400) return `il y a ${Math.floor(diff / 86400)} j`;
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
}

export function shortDate(iso) {
  if (!iso) return '';
  let d;
  try {
    d = new Date(iso);
    if (isNaN(d.getTime())) d = new Date(iso.replace(' ', 'T'));
  } catch { return ''; }
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today - msgDay) / 86400000);
  if (diffDays === 0) return `Aujourd'hui ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  if (diffDays === 1) return `Hier ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('fr-FR', sameYear
    ? { day: '2-digit', month: 'short' }
    : { day: '2-digit', month: 'short', year: 'numeric' });
}

export function longDate(iso) {
  if (!iso) return '';
  let d;
  try {
    d = new Date(iso);
    if (isNaN(d.getTime())) d = new Date(iso.replace(' ', 'T'));
  } catch { return ''; }
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('fr-FR', {
    weekday: 'long',
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Cyrillic (U+0400-U+04FF) and Greek (U+0370-U+03FF) ranges. A Latin-looking
// hostname containing characters from these ranges is almost always a
// homograph spoof: `раypal.com` (with a Cyrillic «р») is not paypal.com.
// Same heuristic is applied to attachment filenames in
// src/attachment_security.py:425-429.
const HOMOGLYPH_RE = /[Ѐ-ӿͰ-Ͽ]/;

// SOURCE OF TRUTH: src/brands.py BRANDS frozenset. Keep the two in sync
// when adding/removing a brand. The list is intentionally small (~80
// entries) and curated for FR + EU users — see brands.py for the
// rationale and update cadence.
const BRANDS = new Set([
  // Tech / global SaaS
  'paypal.com', 'google.com', 'microsoft.com', 'amazon.com',
  'apple.com', 'icloud.com',
  'facebook.com', 'instagram.com', 'linkedin.com', 'whatsapp.com',
  'twitter.com', 'x.com', 'tiktok.com',
  'netflix.com', 'spotify.com', 'dropbox.com', 'adobe.com',
  'github.com', 'openai.com', 'chatgpt.com', 'anthropic.com',
  // E-commerce / classifieds
  'ebay.com', 'amazon.fr', 'leboncoin.fr', 'vinted.fr',
  'fnac.com', 'darty.com', 'cdiscount.com', 'zalando.fr',
  'aliexpress.com', 'shein.com',
  // FR — banques
  'bnpparibas.fr', 'credit-agricole.fr', 'societegenerale.fr',
  'lcl.fr', 'banquepostale.fr', 'boursorama.com', 'fortuneo.fr',
  'creditmutuel.fr', 'caisse-epargne.fr', 'labanquepostale.fr',
  'hellobank.fr', 'n26.com', 'revolut.com', 'monabanq.com',
  'nickel.eu', 'qonto.com',
  // FR — services publics
  'ameli.fr', 'impots.gouv.fr', 'caf.fr', 'pole-emploi.fr',
  'francetravail.fr', 'service-public.fr', 'ants.gouv.fr',
  'secu-independants.fr', 'info-coronavirus.gouv.fr',
  'demarches-simplifiees.fr', 'msa.fr',
  // FR — telco / utilities
  'orange.fr', 'free.fr', 'sfr.fr', 'bouyguestelecom.fr',
  'edf.fr', 'engie.fr', 'totalenergies.fr',
  // Logistique
  'laposte.fr', 'colissimo.fr', 'chronopost.fr', 'mondialrelay.fr',
  'ups.com', 'dhl.com', 'fedex.com', 'tnt.com', 'dpd.fr',
  'gls-france.com', 'amazonlogistics.fr',
  // Crypto
  'binance.com', 'coinbase.com', 'kraken.com', 'ledger.com',
  'metamask.io', 'bitstamp.net',
]);
const BRAND_ROOTS = new Set(
  [...BRANDS].map(d => d.split('.', 1)[0])
);
const MULTI_PART_TLDS = new Set([
  'co.uk', 'co.jp', 'co.kr', 'co.nz', 'co.za', 'co.in', 'co.id',
  'com.au', 'com.br', 'com.cn', 'com.fr', 'com.mx', 'com.tr',
  'ac.uk', 'gov.uk', 'org.uk', 'ne.jp', 'or.jp',
  'gouv.fr', 'asso.fr', 'tm.fr',
]);

function _registrable(host) {
  if (!host) return '';
  const parts = host.toLowerCase().replace(/\.+$/, '').split('.');
  if (parts.length < 2) return host.toLowerCase();
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

function _subdomain(host) {
  const h = (host || '').toLowerCase().replace(/\.+$/, '');
  const reg = _registrable(h);
  if (h === reg || !reg) return '';
  if (!h.endsWith('.' + reg)) return '';
  return h.slice(0, -(reg.length + 1));
}

// Damerau-Levenshtein with early termination. See safe_link.py for
// rationale (transposition catches "googel.com" at distance 1).
function _editDist(a, b, maxD = 1) {
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > maxD) return maxD + 1;
  if (!n) return m;
  if (!m) return n;
  const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1
          && a[i - 1] === b[j - 2]
          && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[n][m];
}

// Important: we read the host directly from the raw string instead of
// `new URL(url).hostname`. The URL constructor normalises IDN domains to
// their punycode form (`xn--…`), which strips the very characters we want
// to flag. Working on the raw bytes preserves them.
function _rawHostFromUrl(url) {
  const m = /^https?:\/\/([^/?#\s]+)/i.exec(url);
  return m ? m[1] : '';
}

// Returns true when the URL should be wrapped through `/safe-link?url=…`
// at click time so the user gets a server-rendered warning page. Keep
// the heuristic in sync with src/safe_link.py `analyze()` — both lists
// of patterns must match or links may be rewritten without the page
// having anything to say (the server then 302s through silently, but
// the round-trip still costs latency).
export function isSuspiciousUrl(url) {
  const rawHost = _rawHostFromUrl(url);
  if (!rawHost) return false;
  const host = rawHost.toLowerCase();
  const hostNoUser = host.includes('@') ? host.split('@').pop() : host;

  // 1. Mixed-script (Cyrillic / Greek)
  if (HOMOGLYPH_RE.test(rawHost)) return true;
  // 2. Sender-encoded IDN punycode
  if (/(^|\.)xn--/i.test(hostNoUser)) return true;
  // 3. Userinfo trick: paypal.com@evil.com
  if (host.includes('@')) return true;
  // 4. Raw IPv4 / IPv6 host
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostNoUser)) return true;
  if (/^\[[0-9a-f:]+\]$/i.test(hostNoUser)) return true;
  // 5. Known shorteners
  if (SHORTENERS.has(hostNoUser)) return true;
  // 6. Suspicious TLD
  const tld = hostNoUser.split('.').pop();
  if (SUSPICIOUS_TLDS.has(tld)) return true;
  // 7. Typosquatting against curated brand list (Damerau distance ≤ 1)
  const reg = _registrable(hostNoUser);
  if (reg && !BRANDS.has(reg)) {
    for (const brand of BRANDS) {
      if (_editDist(reg, brand, 1) <= 1) return true;
    }
    // 8. Subdomain spoofing: brand-root appears as a subdomain label
    const sub = _subdomain(hostNoUser);
    if (sub) {
      for (const label of sub.split('.')) {
        if (BRAND_ROOTS.has(label)) return true;
      }
    }
  }
  return false;
}

// Backwards-compatible alias — kept so existing imports don't break.
// The frontend code uses both names interchangeably; once everything
// is migrated, remove this line and the alias from the export list.
export const isHomographUrl = isSuspiciousUrl;

// Mirrors of `_SHORTENERS` and `_SUSPICIOUS_TLDS` in src/safe_link.py.
// Keep in sync.
const SHORTENERS = new Set([
  'bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd',
  'buff.ly', 'rebrand.ly', 'shorturl.at', 'cutt.ly', 'lnkd.in',
  'rb.gy', 'soo.gd', 'x.co', 'v.gd', 'tiny.cc', 'tr.im',
  'shorte.st', 'adf.ly',
]);
const SUSPICIOUS_TLDS = new Set([
  'xyz', 'top', 'click', 'loan', 'work', 'tk', 'ml', 'ga', 'cf',
  'gq', 'country', 'cricket', 'win', 'stream', 'download', 'men',
  'review', 'racing', 'party', 'trade', 'date', 'faith', 'science',
]);

// Wrap a suspicious URL so a click goes through the server-rendered
// interstitial (`/safe-link?url=…`) instead of opening directly. The
// interstitial highlights the homoglyph chars and asks for explicit
// confirmation. Server-side: src/safe_link.py.
export function safeLinkUrl(rawUrl) {
  return `/safe-link?url=${encodeURIComponent(rawUrl)}`;
}

export function linkify(text) {
  const escaped = escapeHtml(text || '');
  return escaped.replace(
    /(https?:\/\/[^\s<>"]+)/g,
    (match) => {
      const warn = isHomographUrl(match);
      const cls = warn ? ' class="lnk-warn"' : '';
      const title = warn
        ? ' title="Domaine suspect — un avertissement s\'affichera avant l\'ouverture"'
        : '';
      // For suspicious links, the click target is the interstitial page, not
      // the original URL. The visible text stays the original so the user
      // sees what was in the email.
      const href = warn ? safeLinkUrl(match) : match;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer"${cls}${title}>${match}</a>`;
    }
  );
}

// Populated from i18n at module load. i18n.js runs as a classic script
// before this module evaluates, so `window.t` is guaranteed available.
// Locale is fixed for the session, so a single read is enough.
const _t = window.t || ((k) => k);
export const CATEGORY_LABEL = {
  important:     _t('cat.important'),
  newsletter:    _t('cat.newsletter'),
  transactional: _t('cat.transactional'),
  spam:          _t('cat.spam'),
  other:         _t('cat.other'),
  pending:       _t('cat.pending'),
};

export const CATEGORY_COLOR = {
  important:     '#FCA5A5',
  newsletter:    '#93C5FD',
  transactional: '#86EFAC',
  spam:          '#CBD5E1',
  other:         '#C4B5FD',
  pending:       '#FCD34D',
};

export const CATEGORY_ICON = {
  important:     'star',
  newsletter:    'newspaper',
  transactional: 'receipt',
  spam:          'shield-x',
  other:         'tag',
  pending:       'clock',
};

export function scoreClass(s) {
  if (s >= 7) return 's-hi';
  if (s >= 4) return 's-md';
  return 's-lo';
}
