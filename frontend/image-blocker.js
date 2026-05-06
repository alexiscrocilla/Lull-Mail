/*
 * Email-body remote-image blocker.
 *
 * Walks the HTML body of an email and replaces every <img src="https://…">
 * (and <picture><source>, and `style="background-image:url(…)"`) with an
 * inert 1x1 placeholder. The original URL is parked on a `data-blocked-*`
 * attribute so a later pass can restore the image when the user opts in
 * for this sender.
 *
 * Why client-side?
 * The HTML body lives in the SQLite DB exactly as it arrived. Re-writing
 * at ingestion would lose the original markup — once the user chooses
 * "always show images for this sender" we want to render the email as
 * the sender intended, with all its tracking pixels included if the
 * user is fine with it. So the rewrite happens at render time, and the
 * trust state is per-domain in `sender_cache.images_trusted`.
 *
 * Schemes preserved
 * -----------------
 *   • data:   inline base64-encoded images
 *   • cid:    Content-ID inline parts (already swapped server-side)
 *   • blob:   anything constructed by the parent JS context
 * Anything starting with `http://` or `https://` is the tracking
 * surface and gets blocked.
 *
 * Runs purely with `DOMParser` + `querySelectorAll` — no innerHTML
 * round-trip. Regex-only would have been smaller but choke on
 * legitimate markup like `<img src="https://…" srcset="…, …">`.
 */

// 1x1 transparent GIF — keeps the placeholder dimensions implicit
// (the <img> width/height attributes still apply) so the email
// layout doesn't shift when images are blocked.
const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';


function isRemoteUrl(url) {
  if (!url) return false;
  const u = String(url).trim().toLowerCase();
  if (u.startsWith('data:')) return false;
  if (u.startsWith('cid:'))  return false;
  if (u.startsWith('blob:')) return false;
  // Accept // (protocol-relative URLs are remote too).
  if (u.startsWith('//'))    return true;
  return /^https?:\/\//i.test(u);
}


// CSS `url(...)` extraction — handles single-quoted, double-quoted,
// and unquoted forms as well as `url("…"), url('…'), url(…)`.
const CSS_URL_RE = /url\(\s*(['"]?)((?:https?:)?\/\/[^'")\s]+)\1\s*\)/gi;


/**
 * Rewrite every remote <img>, <source>, and CSS `url(…)` reference in
 * the given HTML so the iframe srcdoc never fetches them. Returns the
 * modified HTML and the count of distinct URLs blocked.
 *
 * Idempotent on its own output: a second call won't double-block
 * because all remote URLs are gone after the first pass (replaced by
 * `data:` or stripped).
 */
export function rewriteRemoteImages(html) {
  if (!html) return { html: html || '', blockedCount: 0 };
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch (_) {
    return { html, blockedCount: 0 };
  }
  let blocked = 0;

  // <img src="https://…">
  doc.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!isRemoteUrl(src)) return;
    img.setAttribute('data-blocked-src', src);
    img.setAttribute('src', TRANSPARENT_PIXEL);
    // `srcset` would also be fetched by the browser even when src is
    // a data URL — strip it.
    if (img.hasAttribute('srcset')) {
      const ss = img.getAttribute('srcset') || '';
      if (/https?:\/\//i.test(ss) || /^\/\//i.test(ss.trim())) {
        img.setAttribute('data-blocked-srcset', ss);
        img.removeAttribute('srcset');
      }
    }
    blocked += 1;
  });

  // <picture><source srcset="https://…">
  doc.querySelectorAll('source[srcset]').forEach((s) => {
    const ss = s.getAttribute('srcset') || '';
    if (!/https?:\/\//i.test(ss) && !/^\/\//i.test(ss.trim())) return;
    s.setAttribute('data-blocked-srcset', ss);
    s.removeAttribute('srcset');
    blocked += 1;
  });

  // style="background-image: url(https://…)" / "background:…url(…)…"
  doc.querySelectorAll('[style]').forEach((el) => {
    const original = el.getAttribute('style') || '';
    if (!/url\(/i.test(original)) return;
    let modified = false;
    const replaced = original.replace(CSS_URL_RE, () => {
      modified = true;
      blocked += 1;
      return `url(${TRANSPARENT_PIXEL})`;
    });
    if (modified) {
      el.setAttribute('data-blocked-style', original);
      el.setAttribute('style', replaced);
    }
  });

  // Strip any `<link rel="…stylesheet" href="https://…">` — external
  // CSS in an email is exotic but if present it can pull tracking
  // pixels of its own. Cheap defence.
  doc.querySelectorAll('link[href]').forEach((link) => {
    const href = link.getAttribute('href') || '';
    if (isRemoteUrl(href)) {
      link.setAttribute('data-blocked-href', href);
      link.removeAttribute('href');
      blocked += 1;
    }
  });

  return { html: doc.documentElement.outerHTML, blockedCount: blocked };
}


/**
 * Extract the "@domain" part of a From-header value such as
 * `"Display Name" <user@example.com>`. Lower-cased. Returns "" when
 * nothing parses out.
 */
export function senderDomain(rawSender) {
  if (!rawSender) return '';
  const m = /<?\s*([^@<>\s]+@[^@>\s]+)\s*>?/.exec(String(rawSender));
  if (!m) return '';
  const at = m[1].lastIndexOf('@');
  return at >= 0 ? m[1].slice(at + 1).toLowerCase() : '';
}
