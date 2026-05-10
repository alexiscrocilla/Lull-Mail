// Thin fetch wrappers around the FastAPI backend.

async function j(url, opts) {
  const r = await fetch(url, opts);
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

  patchEmail(intId, patch) {
    return j(`/api/emails/${intId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  },

  reanalyzeEmail(intId) {
    return j(`/api/emails/${intId}/reanalyze`, { method: 'POST' });
  },

  generateDraft(intId) {
    return j(`/api/emails/${intId}/draft`, { method: 'POST' });
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
    const r = await fetch('/api/uploads', { method: 'POST', body: fd });
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
    const r = await fetch('/api/emails/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let body = null;
    try { body = await r.json(); } catch (_) { /* non-JSON body */ }
    if (!r.ok) {
      const detail = (body && body.detail) || body || {};
      const msg = detail.message || detail.error || `${r.status} ${r.statusText}`;
      const err = new Error(msg);
      err.stage = detail.stage || '';
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

const PALETTE = [
  '#0D9488', '#3B82F6', '#A855F7', '#F59E0B', '#EF4444',
  '#10B981', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316',
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

export function avatarImgHtml(email, size = 40) {
  const domain = senderDomain(email);
  if (!domain) return '';
  // Use root domain so subdomains (notify.proton.me → proton.me) resolve correctly.
  const root = rootDomain(domain);
  const src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(root)}&sz=64`;
  // Hide if Google returns the generic globe icon (naturalWidth <= 16px).
  const onload  = `if(this.naturalWidth<=16)this.style.display='none'`;
  const onerror = `this.style.display='none'`;
  return `<img class="av-img" src="${src}" alt="" loading="lazy" onload="${onload}" onerror="${onerror}">`;
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
