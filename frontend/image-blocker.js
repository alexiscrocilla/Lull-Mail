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
 * Anything else is the tracking surface: the rewriter reads URLs the way
 * the browser's parser does (see isRemoteUrl), the policy refuses all of
 * it whatever the spelling.
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


/**
 * Whether the browser would fetch `url` from another machine. Read the way
 * the URL parser reads it, not the way it looks: leading spaces and C0
 * controls are dropped and tabs and newlines vanish wherever they sit (so
 * `ht&#9;tps://` is https), `https:host` needs no slashes, and `\\host` is
 * `//host`. `base` is the email's own remote <base href>, if it has one;
 * every relative reference then lands on that host.
 */
function isRemoteUrl(url, base = '') {
  const u = String(url || '').replace(/^[\u0000-\u0020]+/, '')
    .replace(/[\t\n\r]/g, '').toLowerCase();
  if (!u) return false;
  if (/^[\\/]{2}/.test(u)) return true;
  if (/^https?:/.test(u)) return true;
  // Any other scheme is local (data:, cid:, blob:) or never fetched
  // (mailto:, tel:).
  if (/^[a-z][a-z0-9+.-]*:/.test(u)) return false;
  return !!base;
}


/**
 * The URLs of a srcset, split the way the browser splits it: a URL runs to
 * the next whitespace, and only a comma after it (or after its
 * descriptors) ends the candidate, so a data: URL keeps its own commas.
 * Testing the whole attribute instead read the xmlns of an inline SVG as a
 * remote host.
 */
function srcsetUrls(srcset) {
  const urls = [];
  // Sticky: a failed match ends the scan instead of retrying from every
  // later position, which would be quadratic on a long run of spaces.
  const re = /[\s,]*(\S+)/y;
  let m;
  while ((m = re.exec(srcset))) {
    const url = m[1].replace(/,+$/, '');
    urls.push(url);
    if (url.length === m[1].length) {
      // No trailing comma: skip this candidate's descriptors ("2x").
      const comma = srcset.indexOf(',', re.lastIndex);
      if (comma < 0) break;
      re.lastIndex = comma + 1;
    }
  }
  return urls;
}


// CSS `url(…)`: double-quoted, single-quoted or bare. A quoted value may
// hold parentheses, a bare one may not (CSS wants them escaped). No class
// here can run past the next quote or parenthesis, which keeps a hostile
// `url(//url(//url(//…` linear: the previous pattern let the bare form
// swallow `(` and rescanned the rest of the input from every `url(`.
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'"()\s]*))\s*\)/gi;
// `@import "…"`, the string form, which CSS_URL_RE does not see.
const CSS_IMPORT_RE = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;


/**
 * How many references in `css` the browser would fetch from another
 * machine, `url(…)` and `@import "…"` alike. Exported for its unit test.
 */
export function countRemoteCssUrls(css, base = '') {
  let n = 0;
  for (const m of String(css || '').matchAll(CSS_URL_RE)) {
    if (isRemoteUrl(m[1] ?? m[2] ?? m[3], base)) n += 1;
  }
  for (const m of String(css || '').matchAll(CSS_IMPORT_RE)) {
    if (isRemoteUrl(m[1] ?? m[2], base)) n += 1;
  }
  return n;
}

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

// What the policy cannot hold once images are allowed. A srcdoc frame is
// never fetched, so frame-src does not see it; it inherits the message's
// policy and may load whatever the message may. Chromium checks a resource
// hint against every fetch directive and sends it as soon as one of them
// admits the URL. Neither has any use in an email.
const OUTSIDE_POLICY = 'iframe[srcdoc], link[rel~="prefetch" i], link[rel~="prerender" i], '
  + 'link[rel~="preconnect" i], link[rel~="dns-prefetch" i]';


/**
 * The Content-Security-Policy an email frame is rendered under.
 *
 * `default-src 'none'` covers everything not listed: nested frames,
 * <object>/<embed>, connections (including <a ping>), workers. Inline
 * styles stay allowed, they are how email is laid out. `data:`, `blob:` and
 * `cid:` are local by construction (the fetcher inlines cid parts as data:
 * URIs); a data: stylesheet can only reach further through img-src and
 * font-src. `allowRemote` is the user's "show images" choice, for this
 * message or for the sender; it lets in what the sender's design is made
 * of (images, stylesheets, fonts, media) and still no frames, objects or
 * connections. `dropOutsidePolicy` covers the two things a policy cannot.
 */
export function remoteContentPolicy(allowRemote = false) {
  const remote = allowRemote ? ' http: https:' : '';
  return [
    "default-src 'none'",
    `img-src data: blob: cid:${remote}`,
    `media-src data: blob:${remote}`,
    `font-src data:${remote}`,
    `style-src data: 'unsafe-inline'${remote}`,
  ].join('; ');
}


/**
 * Prefix `html` with the policy's <meta>, so it is the first thing the
 * frame's parser sees. A policy only governs what is parsed after it, and a
 * <meta> policy outside <head> is ignored: leading the document lands it in
 * the implied <head> ahead of any email markup, which the first `<head`
 * the email itself contains cannot promise.
 *
 * Always first, even ahead of a doctype. Splicing it in after one meant
 * deciding where the doctype ends, and a no-break space before it (HTML
 * whitespace is narrower than a regex's `\s`) had already opened <body>,
 * where the policy was ignored. Nothing is lost: a srcdoc document renders
 * in no-quirks mode with or without a doctype, and a doctype after the
 * <meta> is simply skipped.
 */
export function withRemoteContentPolicy(html, allowRemote = false) {
  return '<meta http-equiv="Content-Security-Policy" content="'
    + remoteContentPolicy(allowRemote) + '">' + (html || '');
}


/**
 * Remove what the policy cannot hold (see OUTSIDE_POLICY). For a message
 * whose remote content is allowed; `rewriteRemoteImages` does the same on
 * the blocked path. Returns `html` untouched when there is nothing to drop.
 */
export function dropOutsidePolicy(html) {
  if (!html) return html || '';
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch (_) {
    return html;
  }
  const found = doc.querySelectorAll(OUTSIDE_POLICY);
  if (!found.length) return html;
  found.forEach((el) => el.remove());
  return doc.documentElement.outerHTML;
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
  doc.querySelectorAll(OUTSIDE_POLICY).forEach((el) => el.remove());

  // A remote <base href> sends every relative reference to its host. The
  // policy refuses those like any other, so they have to be counted too, or
  // a newsletter written with relative paths shows no banner and no way to
  // load its pictures.
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href') || '';
  const base = isRemoteUrl(baseHref) ? baseHref : '';
  const remote = (url) => isRemoteUrl(url, base);
  const remoteSrcset = (srcset) => srcsetUrls(srcset).some(remote);

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
    const remoteSrc = remote(src);
    if (!remoteSrc && !remoteSrcset(srcset)) return;
    blocked += 1;
    // `srcset` is fetched even when src is a data URL, and on its own
    // when there is no src at all — strip it.
    if (remoteSrcset(srcset)) {
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
    if (!remoteSrcset(ss)) return;
    s.setAttribute('data-blocked-srcset', ss);
    s.removeAttribute('srcset');
    blocked += 1;
  });

  // background="…" on body/table/td, video posters, <input type=image>,
  // media sources.
  FETCHING_ATTRS.forEach(([selector, attr]) => {
    doc.querySelectorAll(selector).forEach((el) => {
      const url = el.getAttribute(attr) || '';
      if (!remote(url)) return;
      el.setAttribute(`data-blocked-${attr}`, url);
      el.removeAttribute(attr);
      blocked += 1;
    });
  });

  // SVG <image href> and its older xlink:href spelling.
  doc.querySelectorAll('image').forEach((el) => {
    const url = el.getAttribute('href') || el.getAttributeNS(XLINK_NS, 'href') || '';
    if (!remote(url)) return;
    el.setAttribute('data-blocked-href', url);
    el.removeAttribute('href');
    el.removeAttributeNS(XLINK_NS, 'href');
    blocked += 1;
  });

  // <style> blocks: url() and @import. Left as they are, the policy
  // refuses them; counted so the banner says something was held back.
  doc.querySelectorAll('style').forEach((el) => {
    blocked += countRemoteCssUrls(el.textContent, base);
  });

  // style="background-image: url(https://…)" / "background:…url(…)…"
  doc.querySelectorAll('[style]').forEach((el) => {
    const original = el.getAttribute('style') || '';
    if (!/url\(/i.test(original)) return;
    let modified = false;
    const replaced = original.replace(CSS_URL_RE, (match, dq, sq, bare) => {
      if (!remote(dq ?? sq ?? bare)) return match;
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
    if (remote(href)) {
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
