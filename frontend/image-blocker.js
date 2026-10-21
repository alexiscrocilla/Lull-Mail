// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * Email-body remote-image blocker.
 *
 * Two layers, and only the second one is a guarantee.
 *
 * 1. `rewriteRemoteImages` walks the HTML body and replaces every
 *    <img src="https://…"> (and the other attributes that fetch on their
 *    own) with an inert placeholder, parking the original URL on a
 *    `data-blocked-*` attribute. That is presentation: the grey slots and
 *    the count on the "N images blocked" banner.
 * 2. `withRemoteContentPolicy` puts a Content-Security-Policy at the top of
 *    the frame document. That is enforcement: the browser refuses the
 *    request itself, whatever markup, CSS or URL spelling asked for it.
 *    A rewriter can only enumerate the vectors it knows about; <style>
 *    url() and @import, `background=`, SVG <image>, `image-set()`, a
 *    srcset with no src, or `ht&#9;tps://` all went around this one.
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
 * Anything else is the tracking surface: the rewriter recognises the
 * `http://`, `https://` and `//` spellings, the policy refuses all of it.
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


function hasRemoteCandidate(srcset) {
  return /https?:\/\//i.test(srcset) || /^\/\//i.test(srcset.trim());
}


// CSS `url(...)` extraction — handles single-quoted, double-quoted,
// and unquoted forms as well as `url("…"), url('…'), url(…)`.
const CSS_URL_RE = /url\(\s*(['"]?)((?:https?:)?\/\/[^'")\s]+)\1\s*\)/gi;
// `@import "https://…"`, the string form, which CSS_URL_RE does not see.
const CSS_IMPORT_STRING_RE = /@import\s+(['"])(?:https?:)?\/\//gi;

// Attributes outside img[src] that fetch on their own. The frame's policy
// refuses them all anyway; parking them here is what lets the banner count
// them, so a message whose only pictures are table backgrounds or a video
// poster still offers the "load images" buttons.
const FETCHING_ATTRS = [
  ['[background]', 'background'],
  ['video[poster]', 'poster'],
  ['input[type="image" i][src]', 'src'],
  ['video[src], audio[src], source[src], track[src]', 'src'],
];

const XLINK_NS = 'http://www.w3.org/1999/xlink';


/**
 * The Content-Security-Policy an email frame is rendered under.
 *
 * `default-src 'none'` covers everything not listed: nested frames,
 * <object>/<embed>, connections (including <a ping>), workers. Inline
 * styles stay allowed, they are how email is laid out. `data:`, `blob:` and
 * `cid:` are local by construction (the fetcher inlines cid parts as data:
 * URIs). `allowRemote` is the user's "show images" choice, for this message
 * or for the sender; it lets in what the sender's design is made of
 * (images, stylesheets, fonts, media) and still no frames, objects or
 * connections.
 */
export function remoteContentPolicy(allowRemote = false) {
  const remote = allowRemote ? ' http: https:' : '';
  return [
    "default-src 'none'",
    `img-src data: blob: cid:${remote}`,
    `media-src data: blob:${remote}`,
    `font-src data:${remote}`,
    `style-src 'unsafe-inline'${remote}`,
  ].join('; ');
}


/**
 * Prefix `html` with the policy's <meta>, so it is the first thing the
 * frame's parser sees. A policy only governs what is parsed after it, and a
 * <meta> policy outside <head> is ignored: leading the document lands it in
 * the implied <head> ahead of any email markup, which the first `<head`
 * the email itself contains cannot promise. A leading doctype stays first
 * so the email keeps the rendering mode it asked for.
 */
export function withRemoteContentPolicy(html, allowRemote = false) {
  const meta = '<meta http-equiv="Content-Security-Policy" content="'
    + remoteContentPolicy(allowRemote) + '">';
  const source = html || '';
  const doctype = /^\s*<!doctype[^>]*>/i.exec(source);
  if (!doctype) return meta + source;
  return doctype[0] + meta + source.slice(doctype[0].length);
}


/**
 * Swap every remote <img>, <source>, fetching attribute and inline-style
 * `url(…)` in the given HTML for a placeholder, and count the remote
 * references in <style> blocks. Returns the modified HTML and the count
 * of URLs blocked, for the banner. Not a guarantee on its own: the frame
 * must also carry `withRemoteContentPolicy`.
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
  // Three size buckets so the placeholder isn't visually disruptive:
  //   • Tracking pixel (any dim ≤ 4)  → mark + CSS hides entirely.
  //     1×1 GIFs and "spacer" images are 99% of these.
  //   • Hero / banner (width ≥ 300 or height ≥ 200) → cap to 200×80
  //     so a single email with a giant 600×400 banner doesn't fill
  //     the whole reading pane with empty grey.
  //   • Everything else → keep declared dimensions. Brand logos
  //     (typically 32-150 px) stay at their natural slot, so the
  //     surrounding layout doesn't shift.
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    const srcset = img.getAttribute('srcset') || '';
    const remoteSrc = isRemoteUrl(src);
    if (!remoteSrc && !hasRemoteCandidate(srcset)) return;
    blocked += 1;
    // `srcset` is fetched even when src is a data URL, and on its own
    // when there is no src at all — strip it.
    if (hasRemoteCandidate(srcset)) {
      img.setAttribute('data-blocked-srcset', srcset);
      img.removeAttribute('srcset');
    }
    // A local src (an inlined cid: part) still has its picture to show.
    if (src && !remoteSrc) return;
    img.setAttribute('data-blocked-src', src);

    const wNum = parseInt(img.getAttribute('width') || '0', 10);
    const hNum = parseInt(img.getAttribute('height') || '0', 10);

    if ((wNum > 0 && wNum <= 4) || (hNum > 0 && hNum <= 4)) {
      // Tracking pixel — hide. The CSS rule on data-blocked-tracker
      // does the work, but we set inline style too as a belt-and-
      // braces because some email-side CSS overrides display.
      img.setAttribute('data-blocked-tracker', '1');
      img.setAttribute('style',
        (img.getAttribute('style') || '') + ';display:none!important;'
      );
    } else if (wNum >= 300 || hNum >= 200) {
      // Hero — cap to a banner-sized box that's still recognisable
      // as a placeholder but doesn't dominate the reading pane.
      img.setAttribute('width', '200');
      img.setAttribute('height', '80');
      img.setAttribute('style',
        (img.getAttribute('style') || '')
        + ';width:200px!important;height:80px!important;max-width:200px!important;'
      );
    }
    // else: small / medium image → keep original dimensions.

    img.setAttribute('src', TRANSPARENT_PIXEL);
  });

  // <picture><source srcset="https://…">
  doc.querySelectorAll('source[srcset]').forEach((s) => {
    const ss = s.getAttribute('srcset') || '';
    if (!hasRemoteCandidate(ss)) return;
    s.setAttribute('data-blocked-srcset', ss);
    s.removeAttribute('srcset');
    blocked += 1;
  });

  // background="…" on body/table/td, video posters, <input type=image>,
  // media sources.
  FETCHING_ATTRS.forEach(([selector, attr]) => {
    doc.querySelectorAll(selector).forEach((el) => {
      const url = el.getAttribute(attr) || '';
      if (!isRemoteUrl(url)) return;
      el.setAttribute(`data-blocked-${attr}`, url);
      el.removeAttribute(attr);
      blocked += 1;
    });
  });

  // SVG <image href> and its older xlink:href spelling.
  doc.querySelectorAll('image').forEach((el) => {
    const url = el.getAttribute('href') || el.getAttributeNS(XLINK_NS, 'href') || '';
    if (!isRemoteUrl(url)) return;
    el.setAttribute('data-blocked-href', url);
    el.removeAttribute('href');
    el.removeAttributeNS(XLINK_NS, 'href');
    blocked += 1;
  });

  // <style> blocks: url() and @import. Left as they are, the policy
  // refuses them; counted so the banner says something was held back.
  doc.querySelectorAll('style').forEach((el) => {
    const css = el.textContent || '';
    blocked += (css.match(CSS_URL_RE) || []).length
      + (css.match(CSS_IMPORT_STRING_RE) || []).length;
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
