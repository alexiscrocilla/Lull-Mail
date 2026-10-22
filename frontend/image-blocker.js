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


// Where a URL with no <base> of its own resolves: the app page, because a
// srcdoc frame borrows its parent's base URL. Node, in the unit tests, has
// no page.
const APP_URL = globalThis.location?.href || 'http://localhost/';
const APP_ORIGIN = new URL(APP_URL).origin;

// A value of nothing but spaces and C0 controls, which the URL parser
// trims to nothing: no fetch.
const BLANK_RE = /^[\x00-\x20]*$/;


/**
 * Whether the frame would fetch `url` from another server, resolved against
 * `base` (the document's base URL) by the engine's own URL parser rather
 * than judged by its spelling. The parser drops tabs and newlines, takes
 * `https:host` without slashes, honours only an HTML <base> (an SVG one
 * matches a selector but never reaches `baseURI`), and keeps its platform
 * quirks: Chromium on Windows reads `\\host` as a UNC path it will not
 * load, WebKit as `//host`. Patterns kept getting each of these wrong. The
 * app's own origin is not another server: the policy refuses it all the
 * same, there is just nothing there to offer.
 */
function isRemoteUrl(url, base = APP_URL) {
  if (url == null || BLANK_RE.test(url)) return false;
  let u;
  try {
    u = new URL(url, base);
  } catch (_) {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== APP_ORIGIN;
}


/**
 * The same for a URL written in CSS, where `url(#id)` is a reference into
 * the document itself (an SVG gradient, clip-path or filter) and is never
 * resolved against a <base>.
 */
function isRemoteCssUrl(url, base) {
  return !/^[\x00-\x20]*#/.test(url) && isRemoteUrl(url, base);
}


const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;


/**
 * The URLs of a srcset, split by the HTML algorithm: a URL runs to the next
 * whitespace, trailing commas end its candidate, and otherwise its
 * descriptors run to the next comma that is not inside parentheses.
 * Splitting on the first comma read the xmlns of an inline SVG as a remote
 * host and missed the candidate after "1x(,b)"; trimming commas with a
 * pattern was quadratic on a long run of them. One forward pass.
 */
function srcsetUrls(srcset) {
  const s = String(srcset || '');
  const n = s.length;
  const urls = [];
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(s.charCodeAt(i)) || s.charCodeAt(i) === 44)) i += 1;
    if (i >= n) break;
    const start = i;
    while (i < n && !isSpace(s.charCodeAt(i))) i += 1;
    let end = i;
    while (end > start && s.charCodeAt(end - 1) === 44) end -= 1;
    urls.push(s.slice(start, end));
    if (end < i) continue;
    let inParens = false;
    while (i < n) {
      const c = s.charCodeAt(i);
      i += 1;
      if (inParens) {
        if (c === 41) inParens = false;
      } else if (c === 40) {
        inParens = true;
      } else if (c === 44) {
        break;
      }
    }
  }
  return urls;
}


/**
 * A CSS string starting at the quote at `i`: its raw text and where it
 * ends. A backslash escapes the next character; an unescaped newline makes
 * it a bad string (value null), as in CSS.
 */
function readCssString(s, i) {
  const quote = s.charCodeAt(i);
  let j = i + 1;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === quote) return { value: s.slice(i + 1, j), end: j + 1 };
    if (c === 10 || c === 12 || c === 13) return { value: null, end: j };
    j += c === 92 ? 2 : 1;
  }
  return { value: s.slice(i + 1), end: s.length };
}


/**
 * The url( token starting at `i`, read the way CSS reads one: quoted or
 * bare, whitespace allowed around the value. A token that does not close
 * is a bad url (value null) and, as in CSS, runs to the next ")".
 */
function readUrlToken(s, i) {
  const n = s.length;
  let j = i + 4;
  while (j < n && isSpace(s.charCodeAt(j))) j += 1;
  let value;
  const c = s.charCodeAt(j);
  if (c === 34 || c === 39) {
    const str = readCssString(s, j);
    ({ value } = str);
    j = str.end;
  } else {
    const from = j;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (isSpace(d) || d === 34 || d === 39 || d === 40 || d === 41) break;
      j += d === 92 ? 2 : 1;
    }
    j = Math.min(j, n);
    value = s.slice(from, j);
  }
  while (j < n && isSpace(s.charCodeAt(j))) j += 1;
  if (value !== null && s.charCodeAt(j) === 41) return { value, end: j + 1 };
  const close = s.indexOf(')', j);
  return { value: null, end: close < 0 ? n : close + 1 };
}


/**
 * Every URL a stylesheet or a style attribute refers to: `{ value, start,
 * end, isImport }` for each url(…) and @import "…". A forward-only
 * tokenizer, not a pattern: two patterns in a row could be driven
 * quadratic (a bare url( that swallowed "(", then a url( followed by a long
 * run of whitespace), while here the position never moves back. Comments
 * and strings are skipped the way CSS skips them, so a url( inside one is
 * not a reference. Escapes such as `u\72l(` are not decoded; that only
 * costs a banner count, since the policy refuses those fetches regardless.
 */
function cssUrls(css) {
  const s = String(css || '');
  const n = s.length;
  const refs = [];
  let i = 0;
  let afterImport = false;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 47 && s.charCodeAt(i + 1) === 42) {
      const close = s.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
    } else if (c === 34 || c === 39) {
      const str = readCssString(s, i);
      if (afterImport && str.value !== null) {
        refs.push({ value: str.value, start: i, end: str.end, isImport: true });
      }
      afterImport = false;
      i = str.end;
    } else if (c === 64 && s.slice(i + 1, i + 7).toLowerCase() === 'import') {
      afterImport = true;
      i += 7;
    } else if ((c === 117 || c === 85) && s.slice(i, i + 4).toLowerCase() === 'url('
               && !/[\w-]/.test(s[i - 1] || ' ')) {
      const tok = readUrlToken(s, i);
      if (tok.value !== null) {
        refs.push({ value: tok.value, start: i, end: tok.end, isImport: afterImport });
      }
      afterImport = false;
      i = tok.end;
    } else {
      if (!isSpace(c)) afterImport = false;
      i += 1;
    }
  }
  return refs;
}


/**
 * The text of a `data:text/css,…` URL, or null for anything else. Percent
 * escapes are decoded byte by byte, which is all a search for URLs needs.
 */
function dataStylesheet(url) {
  const m = /^[\x00-\x20]*data:([^,]*),/i.exec(url || '');
  if (!m || !/^\s*text\/css\b/i.test(m[1])) return null;
  const body = url.slice(m[0].length);
  if (/;\s*base64\s*$/i.test(m[1])) {
    try {
      return atob(body.replace(/\s+/g, ''));
    } catch (_) {
      return null;
    }
  }
  return body.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}


/**
 * How many references in `css` the frame would fetch from another server,
 * url(…) and @import alike, resolved against `base`. A data: stylesheet it
 * imports is read too: its absolute URLs are live once data: sheets apply,
 * and without counting them a blocked message showed no banner while a
 * trusted sender loaded them. Exported for its unit test.
 */
export function countRemoteCssUrls(css, base = APP_URL, depth = 0) {
  let n = 0;
  for (const { value, isImport } of cssUrls(css)) {
    const sheet = isImport && depth < 3 ? dataStylesheet(value) : null;
    if (sheet !== null) n += countRemoteCssUrls(sheet, value, depth + 1);
    else if (isRemoteCssUrl(value, base)) n += 1;
  }
  return n;
}


/**
 * `css` with every remote url(…) replaced by `replacement`, and how many
 * were. For style attributes, where the placeholder takes the picture's
 * place.
 */
function replaceRemoteCssUrls(css, base, replacement) {
  const refs = cssUrls(css).filter((r) => isRemoteCssUrl(r.value, base));
  if (!refs.length) return { css, count: 0 };
  let out = '';
  let at = 0;
  for (const r of refs) {
    out += css.slice(at, r.start) + replacement;
    at = r.end;
  }
  return { css: out + css.slice(at), count: refs.length };
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
// policy and may load whatever the message may. Resource hints escape it
// too: Chromium sends a prefetch as soon as any fetch directive admits its
// URL, and WebKit sends a preload as=fetch despite default-src 'none'.
// None of them has a use in an email. A preload of something the policy
// does govern (an image, a stylesheet, a font) stays.
const HINT_RELS = new Set(['prefetch', 'prerender', 'preconnect', 'dns-prefetch', 'modulepreload']);
const GOVERNED_PRELOADS = new Set(['image', 'style', 'font']);

function isHintOutsidePolicy(rel, as) {
  const rels = String(rel || '').toLowerCase().split(/[\t\n\f\r ]+/);
  if (rels.some((r) => HINT_RELS.has(r))) return true;
  return rels.includes('preload') && !GOVERNED_PRELOADS.has(String(as || '').trim().toLowerCase());
}

// Elements whose content the HTML tokenizer reads as text, so a "<link"
// inside them is no tag. <noscript> is not one here: a frame that runs no
// script parses its content as markup.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']);


/**
 * Where the raw text of a `name` element that starts at `from` ends: at its
 * end tag, or at the end of the input.
 */
function rawTextEnd(lower, name, from) {
  const close = `</${name}`;
  let p = lower.indexOf(close, from);
  while (p >= 0) {
    const c = lower.charCodeAt(p + close.length);
    if (Number.isNaN(c) || isSpace(c) || c === 47 || c === 62) return p;
    p = lower.indexOf(close, p + close.length);
  }
  return lower.length;
}


/**
 * Call `visit(name, attrs, start, end)` for each start tag of `html`, read
 * the way the HTML tokenizer reads it: `attrs` holds `[name, value,
 * nameStart, nameEnd]` in source order, a quoted value may contain ">",
 * comments and end tags are skipped, and so is the text of raw-text
 * elements. One forward pass; offsets index `html` itself.
 */
function scanStartTags(html, visit) {
  // ASCII-only lowercasing keeps every offset where it was.
  const lower = html.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = lower.indexOf('<', i);
    if (lt < 0) return;
    const c = lower.charCodeAt(lt + 1);
    if (lower.startsWith('!--', lt + 1)) {
      const close = lower.indexOf('-->', lt + 4);
      i = close < 0 ? n : close + 3;
      continue;
    }
    if (c === 33 || c === 47 || c === 63) {
      // <!doctype …>, </end …>, <?…>
      const close = lower.indexOf('>', lt + 2);
      i = close < 0 ? n : close + 1;
      continue;
    }
    if (!(c >= 97 && c <= 122)) {
      i = lt + 1;
      continue;
    }
    let k = lt + 1;
    while (k < n && !isSpace(lower.charCodeAt(k)) && lower[k] !== '/' && lower[k] !== '>') k += 1;
    const name = lower.slice(lt + 1, k);
    const attrs = [];
    let end = -1;
    while (k < n) {
      while (k < n && (isSpace(html.charCodeAt(k)) || html[k] === '/')) k += 1;
      if (k >= n) break;
      if (html[k] === '>') {
        end = k + 1;
        break;
      }
      const nameStart = k;
      k += 1;
      while (k < n && !isSpace(html.charCodeAt(k)) && html[k] !== '/' && html[k] !== '>'
             && html[k] !== '=') k += 1;
      const nameEnd = k;
      while (k < n && isSpace(html.charCodeAt(k))) k += 1;
      let value = '';
      if (html[k] === '=') {
        k += 1;
        while (k < n && isSpace(html.charCodeAt(k))) k += 1;
        const quote = html[k];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, k + 1);
          if (close < 0) break;
          value = html.slice(k + 1, close);
          k = close + 1;
        } else {
          const from = k;
          while (k < n && !isSpace(html.charCodeAt(k)) && html[k] !== '>') k += 1;
          value = html.slice(from, k);
        }
      }
      attrs.push([lower.slice(nameStart, nameEnd), value, nameStart, nameEnd]);
    }
    // A tag cut off by the end of the input is dropped by the tokenizer.
    if (end < 0) return;
    visit(name, attrs, lt, end);
    i = end;
    if (name === 'plaintext') return;
    if (RAW_TEXT.has(name)) i = rawTextEnd(lower, name, end);
  }
}


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
 * connections. `dropOutsidePolicy` covers what a policy cannot.
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
 * Remove what the policy cannot hold from a message whose remote content is
 * allowed: the resource hints go, and a srcdoc frame loses its srcdoc (it
 * stays, empty). A text edit of exactly those tags rather than a parse and
 * serialise: a round trip through the DOM changes what the browser reads
 * the second time (a <pre>'s first blank line, everything after
 * <plaintext>). `rewriteRemoteImages` drops the same things on the blocked
 * path, where the message is serialised anyway. Returns `html` untouched
 * when there is nothing to drop.
 */
export function dropOutsidePolicy(html) {
  if (!html) return html || '';
  const edits = [];
  scanStartTags(html, (name, attrs, start, end) => {
    const first = (attr) => attrs.find((a) => a[0] === attr);
    if (name === 'link' && isHintOutsidePolicy(first('rel')?.[1], first('as')?.[1])) {
      edits.push([start, end, '']);
    } else if (name === 'iframe') {
      for (const [attr, , from, to] of attrs) {
        if (attr === 'srcdoc') edits.push([from, to, 'data-blocked-srcdoc']);
      }
    }
  });
  if (!edits.length) return html;
  let out = '';
  let at = 0;
  for (const [from, to, text] of edits) {
    out += html.slice(at, from) + text;
    at = to;
  }
  return out + html.slice(at);
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
  doc.querySelectorAll('iframe[srcdoc]').forEach((el) => el.remove());
  doc.querySelectorAll('link[rel]').forEach((el) => {
    if (isHintOutsidePolicy(el.getAttribute('rel'), el.getAttribute('as'))) el.remove();
  });

  // Every URL resolves against the document's base URL, which follows the
  // email's own <base href> when it has one. A remote base sends each
  // relative reference to its host; the policy refuses those like any
  // other, so they are counted too, or a newsletter written with relative
  // paths shows no banner and no way to load its pictures. `baseURI` is the
  // parser's own answer, so an SVG or MathML <base> plays no part in it,
  // exactly as in the frame.
  const base = doc.baseURI;
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
    const out = replaceRemoteCssUrls(original, base, `url(${TRANSPARENT_PIXEL})`);
    if (!out.count) return;
    blocked += out.count;
    el.setAttribute('data-blocked-style', original);
    el.setAttribute('style', out.css);
  });

  // Strip any `<link rel="…stylesheet" href="https://…">` — external
  // CSS in an email is exotic but if present it can pull tracking
  // pixels of its own. Cheap defence. A data: stylesheet stays (it
  // applies), and the remote URLs inside it are counted.
  doc.querySelectorAll('link[href]').forEach((link) => {
    const href = link.getAttribute('href') || '';
    if (remote(href)) {
      link.setAttribute('data-blocked-href', href);
      link.removeAttribute('href');
      blocked += 1;
    } else if (/(^|\s)stylesheet(\s|$)/i.test(link.getAttribute('rel') || '')) {
      const sheet = dataStylesheet(href);
      if (sheet !== null) blocked += countRemoteCssUrls(sheet, href, 1);
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
