// Thin fetch wrappers around the FastAPI backend.

async function j(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on ${url}`);
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

export function linkify(text) {
  const escaped = escapeHtml(text || '');
  return escaped.replace(
    /(https?:\/\/[^\s<>"]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
}

export const CATEGORY_LABEL = {
  important: 'Important',
  newsletter: 'Newsletter',
  transactional: 'Transactionnel',
  spam: 'Spam',
  other: 'Autre',
  pending: 'En attente',
};

export const CATEGORY_COLOR = {
  important:     '#FCA5A5',
  newsletter:    '#93C5FD',
  transactional: '#86EFAC',
  spam:          '#CBD5E1',
  other:         '#C4B5FD',
  pending:       '#FCD34D',
};

export function scoreClass(s) {
  if (s >= 7) return 's-hi';
  if (s >= 4) return 's-md';
  return 's-lo';
}
