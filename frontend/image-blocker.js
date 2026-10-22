// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * What an email frame may load, and the HTML it gets.
 *
 * `prepareMessage` is the one way into a message frame:
 *
 * 1. A message the reading pane could not render in reasonable time is
 *    refused before any parser sees it (see LIMITS); the caller shows its
 *    plain text instead.
 * 2. It is parsed once, into an inert document: no browsing context, so
 *    nothing in it is fetched or run. Every later decision is taken on that
 *    tree, never on the text: the scanners that read markup by hand kept
 *    reading it differently from the browser.
 * 3. The caller marks what it wants on that tree (suspicious links).
 * 4. What no policy can hold is removed: resource hints and srcdoc frames.
 * 5. With remote content blocked, each remote picture becomes a
 *    placeholder, and what was held back is counted for the banner.
 * 6. The tree is serialised behind the Content-Security-Policy and the
 *    caller's head, and that exact string is parsed again. A serialisation
 *    is not always read back as it was written (namespace tricks can bring
 *    a <link> back to life), so the frame only ever gets HTML whose own
 *    parse holds nothing forbidden; otherwise the message is refused.
 *
 * The policy is the enforcement: the browser refuses each request itself,
 * whatever markup, CSS or URL spelling asked for it. The rest is
 * presentation (placeholders and the count) and the two things a policy
 * cannot hold.
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
 * Anything else is the tracking surface: the count resolves URLs with the
 * engine's own URL parser (see isRemoteUrl), the policy refuses all of it
 * whatever the spelling.
 */

// 1x1 transparent GIF — keeps the placeholder dimensions implicit
// (the <img> width/height attributes still apply) so the email
// layout doesn't shift when images are blocked.
const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// Where a URL with no <base> of its own resolves: the app page, because a
// srcdoc frame borrows its parent's base URL. Node, in the unit tests, has
// no page.
const APP_URL = globalThis.location?.href || 'http://localhost/';
const APP_ORIGIN = new URL(APP_URL).origin;

// A value of nothing but spaces and C0 controls, which the URL parser
// trims to nothing: no fetch.
const BLANK_RE = /^[\x00-\x20]*$/;


/**
 * What the reading pane can render without stalling, measured in Chromium
 * (WebKit has none of these walls), with the pane's own CSS and autosize:
 *
 * - `depth`, the blocks nested in one another on the parsed tree. A frame
 *   loads in about 10 ms up to some 240 levels and then not at all: 256
 *   nested blocks, 128 Gmail-style quoted replies (two blocks each) or 120
 *   nested tables (a table and its cell each) were still loading after
 *   12 s. Inline elements and table sections and rows open no block under
 *   the default layout and are not counted, so a newsletter of 60 nested
 *   layout tables (180) and a thread of 100 replies (200) both fit.
 * - `elements`, all of them, end tags that create one (a stray </p>)
 *   included: a 4.5 MB newsletter has about 70,000.
 * - `openTags`, start tags left open, read off the raw text before any
 *   parse: the parser itself slows down with the square of that (half a
 *   second for 20,000 nested blocks), so a nesting bomb is refused before
 *   it gets there. Elements whose end tag is optional (p, li, td...) are
 *   not counted.
 * - `parseMs` (plus `parseMsPerMB`), the parse's time budget, which bounds
 *   whatever the estimate misses. The 4.5 MB newsletter parses in 40 ms.
 * - `bytes`, `imports` and `bases`: above the fetcher's own 4 MB cap, and an
 *   email has a handful of @import and one <base> at most (each <base>
 *   costs the parser a URL update).
 *
 * Styles can still slow a frame down where markup alone does not (48
 * nested inline-blocks stall Chromium): these limits cover what the markup
 * says, under the default layout.
 */
export const LIMITS = Object.freeze({
  depth: 224,
  elements: 150_000,
  openTags: 2_048,
  parseMs: 300,
  parseMsPerMB: 100,
  bytes: 5_000_000,
  imports: 256,
  bases: 16,
});

// The most a message's data: stylesheets may cost the count, decoded,
// before any further one counts as a single blocked item unread.
const DATA_SHEET_BUDGET = Object.freeze({ sheets: 32, bytes: 1_000_000 });


/**
 * A stand-in for `base` that resolves any URL to the same protocol and
 * origin, which is all isRemoteUrl reads: the base's origin and a slash.
 * Resolving against the base itself parsed it again for every reference,
 * and a hostile <base> or data: stylesheet runs to 200 KB.
 */
function resolverFor(base) {
  try {
    const u = new URL(base);
    return u.host ? `${u.protocol}//${u.host}/` : u.protocol;
  } catch (_) {
    return APP_URL;
  }
}


/**
 * The scheme of `url` as the URL parser reads it (leading spaces and C0
 * controls skipped, tabs and newlines ignored), lower-cased, or '' for a
 * relative reference. Reads no further than the scheme.
 */
function schemeOf(url) {
  let i = 0;
  while (i < url.length && url.charCodeAt(i) <= 32) i += 1;
  let scheme = '';
  for (; i < url.length; i += 1) {
    const c = url.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c === 58) return scheme.toLowerCase();
    const letter = (c | 32) >= 97 && (c | 32) <= 122;
    if (!letter && !(scheme && ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46))) return '';
    scheme += url[i];
  }
  return '';
}


/** Whether `url` starts with two slashes or backslashes, as the parser reads it. */
function startsWithTwoSlashes(url) {
  let i = 0;
  while (i < url.length && url.charCodeAt(i) <= 32) i += 1;
  let seen = 0;
  for (; i < url.length && seen < 2; i += 1) {
    const c = url.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c !== 47 && c !== BACKSLASH) return false;
    seen += 1;
  }
  return seen === 2;
}


// Whether the origin of the last resolver asked about is another server's.
let lastResolver = '';
let lastResolverRemote = false;


/**
 * Whether the frame would fetch `url` from another server, resolved against
 * `resolver` (see resolverFor) by the engine's own URL parser rather than
 * judged by its spelling. The parser drops tabs and newlines, takes
 * `https:host` without slashes, and keeps its platform quirks: Chromium on
 * Windows reads `\\host` as a UNC path it will not load, WebKit as
 * `//host`. The app's own origin is not another server: the policy refuses
 * it all the same, there is just nothing there to offer.
 */
function isRemoteUrl(url, resolver = APP_URL) {
  if (url == null || BLANK_RE.test(url)) return false;
  // A relative reference that cannot change host (a path, a query, a
  // fragment) lands on the resolver's own origin: no need to parse it, and
  // a message can hold hundreds of thousands of them.
  if (!schemeOf(url) && !startsWithTwoSlashes(url)) {
    if (resolver !== lastResolver) {
      lastResolver = resolver;
      lastResolverRemote = remoteOrigin(resolver);
    }
    return lastResolverRemote;
  }
  let u;
  try {
    u = new URL(url, resolver);
  } catch (_) {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== APP_ORIGIN;
}

function remoteOrigin(resolver) {
  try {
    const u = new URL(resolver);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== APP_ORIGIN;
  } catch (_) {
    return false;
  }
}


const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
const isNewline = (c) => c === 10 || c === 12 || c === 13;
const isHex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isNameChar = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57)
  || c === 45 || c === 95 || c >= 128;
const BACKSLASH = 92;


/**
 * The URLs of a srcset, split by the HTML algorithm: a URL runs to the next
 * whitespace, trailing commas end its candidate, and otherwise its
 * descriptors run to the next comma that is not inside parentheses. One
 * forward pass.
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
 * The CSS escape whose backslash sits just before `i`: [code point, index
 * after it], decoded as CSS Syntax decodes one.
 */
function readEscape(s, i) {
  if (i >= s.length) return [0xfffd, i];
  let j = i;
  while (j < s.length && j - i < 6 && isHex(s.charCodeAt(j))) j += 1;
  if (j === i) {
    const cp = s.codePointAt(i);
    return [cp, i + (cp > 0xffff ? 2 : 1)];
  }
  const cp = parseInt(s.slice(i, j), 16);
  if (j < s.length && isSpace(s.charCodeAt(j))) j += 1;
  return [cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd : cp, j];
}


/** An identifier starting at `i`, escapes decoded: [name, index after it]. */
function readName(s, i) {
  let out = '';
  let from = i;
  let j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (isNameChar(c)) {
      j += 1;
    } else if (c === BACKSLASH && j + 1 < s.length && !isNewline(s.charCodeAt(j + 1))) {
      const [cp, next] = readEscape(s, j + 1);
      out += s.slice(from, j) + String.fromCodePoint(cp);
      j = next;
      from = j;
    } else {
      break;
    }
  }
  return [out + s.slice(from, j), j];
}


/**
 * A CSS string starting at the quote at `i`: its value, escapes decoded,
 * and where it ends. An unescaped newline makes it a bad string (value
 * null); the end of the input closes it, as in CSS.
 */
function readCssString(s, i) {
  const quote = s.charCodeAt(i);
  let out = '';
  let from = i + 1;
  let j = from;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === quote) return { value: out + s.slice(from, j), end: j + 1 };
    if (isNewline(c)) return { value: null, end: j };
    if (c === BACKSLASH) {
      out += s.slice(from, j);
      const d = s.charCodeAt(j + 1);
      if (Number.isNaN(d) || isNewline(d)) {
        j += 2;
      } else {
        const [cp, next] = readEscape(s, j + 1);
        out += String.fromCodePoint(cp);
        j = next;
      }
      from = j;
      continue;
    }
    j += 1;
  }
  return { value: out + s.slice(from), end: s.length };
}


/** The rest of a bad url, which CSS consumes up to ")" or the end. */
function skipBadUrl(s, j) {
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 41) return { value: null, end: j + 1 };
    j += c === BACKSLASH ? 2 : 1;
  }
  return { value: null, end: s.length };
}


/**
 * The value of a url( whose "(" ends just before `i`, read the way CSS
 * reads it: quoted or bare, whitespace around it, escapes decoded, and
 * closed by ")" or by the end of the input. Anything else is a bad url
 * (value null).
 */
function readUrlValue(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && isSpace(s.charCodeAt(j))) j += 1;
  const c = s.charCodeAt(j);
  if (c === 34 || c === 39) {
    const str = readCssString(s, j);
    j = str.end;
    while (j < n && isSpace(s.charCodeAt(j))) j += 1;
    if (str.value !== null && (j >= n || s.charCodeAt(j) === 41)) {
      return { value: str.value, end: Math.min(j + 1, n) };
    }
    return skipBadUrl(s, j);
  }
  let out = '';
  let from = j;
  while (j < n) {
    const d = s.charCodeAt(j);
    if (d === 41) return { value: out + s.slice(from, j), end: j + 1 };
    if (isSpace(d)) {
      const value = out + s.slice(from, j);
      while (j < n && isSpace(s.charCodeAt(j))) j += 1;
      if (j >= n) return { value, end: n };
      if (s.charCodeAt(j) === 41) return { value, end: j + 1 };
      return skipBadUrl(s, j);
    }
    if (d === 34 || d === 39 || d === 40) return skipBadUrl(s, j);
    if (d === BACKSLASH) {
      if (j + 1 < n && isNewline(s.charCodeAt(j + 1))) return skipBadUrl(s, j);
      const [cp, next] = readEscape(s, j + 1);
      out += s.slice(from, j) + String.fromCodePoint(cp);
      j = next;
      from = j;
      continue;
    }
    j += 1;
  }
  return { value: out + s.slice(from), end: n };
}


/**
 * Every URL a stylesheet or a style attribute refers to: `{ kind, value,
 * start, end, isImport, property }` for each url(…), each string inside
 * image-set(…), and each @import. A forward-only tokenizer, not a pattern:
 * patterns could be driven quadratic, while here the position never moves
 * back. It follows CSS where the count depends on it: comments and strings
 * are not references, escapes are decoded (`u\72l(`, `@\69mport`, an
 * escaped scheme), a url( left open at the end still counts, and
 * @namespace fetches nothing. `property` is the declaration a url( sits in,
 * for url(#id).
 */
function cssUrls(css) {
  const s = String(css || '');
  const n = s.length;
  const refs = [];
  let i = 0;
  let property = '';
  let lastName = '';
  let atRule = '';
  let parens = 0;
  let imageSet = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 47 && s.charCodeAt(i + 1) === 42) {
      const close = s.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
    } else if (c === 34 || c === 39) {
      const str = readCssString(s, i);
      if (str.value !== null && (atRule === 'import' || (imageSet && parens >= imageSet))) {
        refs.push({
          kind: 'string', value: str.value, start: i, end: str.end, isImport: atRule === 'import', property,
        });
      }
      if (atRule === 'import') atRule = 'import-done';
      i = str.end;
    } else if (c === 64) {
      const [name, next] = readName(s, i + 1);
      atRule = name.toLowerCase();
      i = Math.max(next, i + 1);
    } else if (isNameChar(c) || (c === BACKSLASH && i + 1 < n && !isNewline(s.charCodeAt(i + 1)))) {
      const [name, next] = readName(s, i);
      const lower = name.toLowerCase();
      if (s.charCodeAt(next) === 40) {
        if (lower === 'url') {
          const tok = readUrlValue(s, next + 1);
          if (tok.value !== null && atRule !== 'namespace') {
            refs.push({
              kind: 'url', value: tok.value, start: i, end: tok.end, isImport: atRule === 'import', property,
            });
          }
          if (atRule === 'import') atRule = 'import-done';
          i = tok.end;
          continue;
        }
        parens += 1;
        if (!imageSet && (lower === 'image-set' || lower === '-webkit-image-set')) imageSet = parens;
        i = next + 1;
        continue;
      }
      lastName = lower;
      i = Math.max(next, i + 1);
    } else {
      if (c === 40) {
        parens += 1;
      } else if (c === 41) {
        if (imageSet && parens === imageSet) imageSet = 0;
        if (parens) parens -= 1;
      } else if (c === 58) {
        property = lastName;
      } else if (c === 59 || c === 123 || c === 125) {
        property = '';
        lastName = '';
        atRule = '';
      }
      i += 1;
    }
  }
  return refs;
}


// Declarations where url(#id) names an element of the document (a gradient,
// a clip path, a filter) and is never fetched. Anywhere else, Chromium
// resolves a fragment-only URL against the <base> like any other, so a
// background-image of url(#x) under a remote base is a remote picture.
const ELEMENT_REFERENCES = new Set([
  'fill', 'stroke', 'clip-path', 'mask', 'filter', 'marker', 'marker-start', 'marker-mid', 'marker-end',
]);

function isRemoteCssRef(ref, resolver) {
  if (ELEMENT_REFERENCES.has(ref.property) && /^[\x00-\x20]*#/.test(ref.value)) return false;
  return isRemoteUrl(ref.value, resolver);
}


/** Bytes of `text` with its percent escapes decoded, as fetch decodes a data: URL. */
function percentDecode(text) {
  const raw = new TextEncoder().encode(text);
  const out = new Uint8Array(raw.length);
  let n = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === 37 && i + 2 < raw.length && isHex(raw[i + 1]) && isHex(raw[i + 2])) {
      out[n] = parseInt(String.fromCharCode(raw[i + 1], raw[i + 2]), 16);
      n += 1;
      i += 2;
    } else {
      out[n] = raw[i];
      n += 1;
    }
  }
  return out.subarray(0, n);
}


/**
 * The text of a data: stylesheet URL, null when `url` is not one, false
 * when it is too large to read. Read
 * the way the browser reads it: tabs and newlines dropped, the fragment
 * cut, percent escapes decoded, then base64, then the text decoded by its
 * byte-order mark or else its charset.
 */
function dataStylesheet(url) {
  let s = String(url || '').replace(/^[\x00-\x20]+/, '').replace(/[\t\n\r]/g, '');
  if (!/^data:/i.test(s)) return null;
  s = s.slice(5);
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  const comma = s.indexOf(',');
  if (comma < 0) return null;
  const params = s.slice(0, comma).split(';').map((p) => p.trim().toLowerCase());
  if (params[0] !== 'text/css') return null;
  // A sheet's encoded text is at most a few times its decoded size, so the
  // budget is checked before decoding as well as after.
  if (s.length - comma > 4 * DATA_SHEET_BUDGET.bytes) return false;
  let bytes = percentDecode(s.slice(comma + 1));
  if (params[params.length - 1] === 'base64') {
    try {
      const text = atob(new TextDecoder('latin1').decode(bytes).replace(/[\t\n\f\r ]+/g, ''));
      bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0));
    } catch (_) {
      return null;
    }
  }
  let label = params.find((p) => p.startsWith('charset='))?.slice(8) || 'utf-8';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) label = 'utf-16le';
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) label = 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch (_) {
    return new TextDecoder().decode(bytes);
  }
}


/**
 * How many references in `css` the frame would fetch from another server.
 * A data: stylesheet it imports is decoded and read too, within `budget`;
 * past it, each further one counts as a single held-back item. Relative
 * URLs inside a data: sheet resolve against the document, as Chromium
 * resolves them (WebKit fetches none of them, so there it over-counts).
 */
function countCss(css, resolver, budget) {
  let n = 0;
  for (const ref of cssUrls(css)) {
    if (ref.isImport && isDataUrl(ref.value)) {
      n += countDataSheet(ref.value, resolver, budget);
    } else if (isRemoteCssRef(ref, resolver)) {
      n += 1;
    }
  }
  return n;
}

// "data:" as the URL parser reads it, tabs and newlines anywhere.
const isDataUrl = (url) => /^[\x00-\x20]*d[\t\n\r]*a[\t\n\r]*t[\t\n\r]*a[\t\n\r]*:/i.test(url);

function countDataSheet(url, resolver, budget) {
  if (!isDataUrl(url)) return 0;
  if (budget.sheets <= 0 || budget.bytes <= 0) return 1;
  budget.sheets -= 1;
  const sheet = dataStylesheet(url);
  if (sheet === null) return 0;
  if (sheet === false) return 1;
  budget.bytes -= sheet.length;
  if (budget.bytes < 0) return 1;
  return countCss(sheet, resolver, budget);
}


/**
 * How many references in `css` the frame would fetch from another server,
 * resolved against `base`. For the unit tests; the rewriter counts with
 * the document's own resolver and budget.
 */
export function countRemoteCssUrls(css, base = APP_URL) {
  return countCss(css, resolverFor(base), { ...DATA_SHEET_BUDGET });
}


/**
 * `css` with every remote url(…) replaced by `replacement`, and how many
 * were. For style attributes, where the placeholder takes the picture's
 * place. Strings inside image-set() are counted but left in place: the
 * policy refuses them, and cutting one would leave image-set() invalid.
 */
function replaceRemoteCssUrls(css, resolver, replacement) {
  const refs = cssUrls(css).filter((r) => isRemoteCssRef(r, resolver));
  const urls = refs.filter((r) => r.kind === 'url');
  let out = '';
  let at = 0;
  for (const r of urls) {
    out += css.slice(at, r.start) + replacement;
    at = r.end;
  }
  return { css: urls.length ? out + css.slice(at) : css, count: refs.length, replaced: urls.length };
}


// No end tag needed: void elements, and those the parser closes on its own
// when the next one starts (an open <p>, <li>, <td>... never nests).
const NEVER_OPEN = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track',
  'wbr', 'keygen', 'p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'colgroup',
  'caption', 'option', 'optgroup', 'rb', 'rp', 'rt', 'rtc', 'html', 'head', 'body',
]);


/** The tag name that starts at `i` (just after "<" or "</"), lower-cased. */
function tagNameAt(html, i) {
  let j = i;
  while (j < html.length) {
    const c = html.charCodeAt(j);
    if (!(((c | 32) >= 97 && (c | 32) <= 122) || (c >= 48 && c <= 57) || c === 45)) break;
    j += 1;
  }
  return html.slice(i, j).toLowerCase();
}


/**
 * Why `html` should not even be parsed, read off the raw text in one pass,
 * or null. These are estimates: a tag written inside a comment counts, and
 * a "</div>" written inside an attribute lowers the open count although
 * the parser closes nothing there. So the parse's time budget and the
 * exact counts on the parsed tree stand behind them.
 */
function heavySource(html) {
  if (html.length > LIMITS.bytes) return 'size';
  let open = 0;
  let tags = 0;
  let gt = -1;
  for (let i = html.indexOf('<'); i >= 0; i = html.indexOf('<', i + 1)) {
    const closing = html.charCodeAt(i + 1) === 47;
    const first = html.charCodeAt(i + (closing ? 2 : 1)) | 32;
    if (first < 97 || first > 122) continue;
    // An element takes one or two tags (a stray </p> builds one on its
    // own). More than twice the element limit is more elements than the
    // limit, or tags that build nothing (stray end tags, tags in comments
    // or attributes): not worth a parse either way.
    if ((tags += 1) > 2 * LIMITS.elements) return 'elements';
    const name = tagNameAt(html, i + (closing ? 2 : 1));
    if (NEVER_OPEN.has(name)) continue;
    if (closing) {
      if (open) open -= 1;
      continue;
    }
    // A start tag closed by "/>" opens nothing (in SVG and MathML; HTML
    // ignores the slash, which only makes the estimate low).
    if (gt < i) gt = html.indexOf('>', i);
    if (gt < 0) break;
    if (html.charCodeAt(gt - 1) === 47) continue;
    if ((open += 1) > LIMITS.openTags) return 'nesting';
  }
  let imports = 0;
  const atImport = /@import/gi;
  while (atImport.exec(html)) {
    if ((imports += 1) > LIMITS.imports) return 'imports';
  }
  let bases = 0;
  const baseTag = /<base/gi;
  while (baseTag.exec(html)) {
    if ((bases += 1) > LIMITS.bases) return 'bases';
  }
  return null;
}


// Elements that open no block under the default layout: inline phrasing,
// and a table's sections and rows (the table and its cells do).
const NO_BLOCK = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'dfn', 'em', 'font', 'i', 'kbd', 'label',
  'mark', 'nobr', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u',
  'var', 'br', 'wbr', 'img', 'tbody', 'thead', 'tfoot', 'tr',
]);


/**
 * Why the parsed tree under `root` is too heavy for the frame, or null:
 * more than LIMITS.elements elements, or blocks nested deeper than
 * LIMITS.depth. One walk, stopped at the first limit passed.
 */
function heavyTree(root) {
  const weight = (el) => (NO_BLOCK.has(el.localName) ? 0 : 1);
  let count = 0;
  let depth = 0;
  let el = root;
  for (;;) {
    count += 1;
    depth += weight(el);
    if (count > LIMITS.elements) return 'elements';
    if (depth > LIMITS.depth) return 'depth';
    if (el.firstElementChild) {
      el = el.firstElementChild;
      continue;
    }
    for (;;) {
      depth -= weight(el);
      if (el === root) return null;
      if (el.nextElementSibling) {
        el = el.nextElementSibling;
        break;
      }
      el = el.parentElement;
    }
  }
}


const PARSE_CHUNK = 32_768;

/**
 * `html` parsed into an inert document: built by the engine's full HTML
 * parser, with no browsing context, so nothing in it is fetched or run.
 * Faster than DOMParser where it matters: Chromium's DOMParser took a
 * second on 200 KB of @import rules that this parses in 10 ms. The doctype
 * gives the no-quirks tree a srcdoc frame builds (in quirks mode a <table>
 * stays inside an open <p>); a doctype of the email's own after it is
 * ignored, as in the frame.
 *
 * Written in chunks, so a parse that runs past `budgetMs` stops there:
 * `complete` is false and the document holds what was read so far. The
 * tree is the same as one write would build (the tokenizer carries its
 * state from one write to the next); a chunk never ends inside a surrogate
 * pair or a CRLF.
 */
function parseInert(html, budgetMs = Infinity) {
  const doc = document.implementation.createHTMLDocument('');
  doc.open();
  doc.write('<!DOCTYPE html>');
  const started = performance.now();
  let complete = true;
  for (let i = 0; i < html.length;) {
    let end = Math.min(i + PARSE_CHUNK, html.length);
    while (end < html.length && ((html.charCodeAt(end) & 0xfc00) === 0xdc00
      || (html.charCodeAt(end) === 10 && html.charCodeAt(end - 1) === 13))) end += 1;
    doc.write(html.slice(i, end));
    i = end;
    if (i < html.length && performance.now() - started > budgetMs) {
      complete = false;
      break;
    }
  }
  doc.close();
  return { doc, complete };
}


// The most text a refused message gets back from its tree.
const TEXT_CAP = 200_000;
// Elements whose text is not part of the message.
const NO_TEXT = new Set(['head', 'script', 'style', 'title', 'template', 'iframe', 'object']);
// Elements that start a new line in the text.
const LINE_BREAKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'center', 'dd', 'div', 'dl', 'dt', 'figcaption',
  'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'tr', 'ul',
]);


/**
 * The readable text of a parsed message, for when it is shown as text: a
 * new line at each block, a space between table cells, runs of white space
 * folded. `{ text, textCut }`, cut at TEXT_CAP characters.
 */
function documentText(doc) {
  const root = doc.body || doc.documentElement;
  if (!root) return { text: '', textCut: false };
  // 1 = NodeFilter.SHOW_ELEMENT, 4 = SHOW_TEXT; 1 = FILTER_ACCEPT, 2 = FILTER_REJECT.
  const walker = doc.createTreeWalker(root, 1 | 4, {
    acceptNode: (n) => (n.nodeType === 1 && NO_TEXT.has(n.localName) ? 2 : 1),
  });
  let out = '';
  let space = false;
  let breaks = 0;
  const separate = () => {
    if (out && breaks) out += breaks > 1 ? '\n\n' : '\n';
    else if (out && space) out += ' ';
    space = false;
    breaks = 0;
  };
  for (let n = walker.nextNode(); n && out.length < TEXT_CAP; n = walker.nextNode()) {
    if (n.nodeType === 1) {
      if (LINE_BREAKS.has(n.localName)) breaks += 1;
      else if (n.localName === 'td' || n.localName === 'th') space = true;
      continue;
    }
    const data = n.data;
    let from = 0;
    for (let i = 0; i <= data.length; i += 1) {
      if (i === data.length || isSpace(data.charCodeAt(i)) || data.charCodeAt(i) === 160) {
        if (i > from) {
          separate();
          out += data.slice(from, i);
        }
        if (i < data.length) space = true;
        from = i + 1;
      }
    }
  }
  return { text: out.slice(0, TEXT_CAP), textCut: out.length >= TEXT_CAP };
}


/**
 * The URL relative references in the message resolve against: its first
 * HTML <base href> (an SVG or MathML one plays no part), resolved against
 * the app page, which is what the frame falls back to. An inert document's
 * own base URL is about:blank, so it cannot answer this.
 */
function documentBase(doc) {
  for (const el of doc.querySelectorAll('base[href]')) {
    if (el.namespaceURI !== XHTML_NS) continue;
    try {
      return new URL(el.getAttribute('href'), APP_URL).href;
    } catch (_) {
      return APP_URL;
    }
  }
  return APP_URL;
}


// What the policy cannot hold, in either mode. A srcdoc frame is never
// fetched, so frame-src does not see it; it inherits the message's policy
// and loads whatever the message may. Resource hints escape it too:
// Chromium sends a prefetch as soon as any fetch directive admits its URL,
// and WebKit sends a preload as=fetch under default-src 'none', even with
// connect-src 'none' (measured). None of them has a use in an email, so
// every preload goes, whatever its `as`.
const HINT_RELS = new Set(['prefetch', 'prerender', 'preconnect', 'dns-prefetch', 'preload', 'modulepreload']);

const isHint = (el) => (el.getAttribute('rel') || '').toLowerCase().split(/[\t\n\f\r ]+/)
  .some((rel) => HINT_RELS.has(rel));

function outsidePolicy(doc) {
  return [...doc.querySelectorAll('iframe[srcdoc]'), ...[...doc.querySelectorAll('link[rel]')].filter(isHint)];
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


/**
 * Swap every remote picture of `doc` for a placeholder and count what was
 * held back: <img>, <source>, the attributes that fetch on their own, SVG
 * <image> and <feImage>, inline-style url(…), stylesheet links, and the
 * references in <style> blocks and data: stylesheets (counted; the policy
 * refuses them). `rewritten` is what was changed in place, which a settled
 * document has none of left.
 */
function rewriteRemote(doc, budget) {
  const resolver = resolverFor(documentBase(doc));
  const remote = (url) => isRemoteUrl(url, resolver);
  const remoteSrcset = (srcset) => srcsetUrls(srcset).some(remote);
  let count = 0;
  let rewritten = 0;

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
    const remoteSet = remoteSrcset(srcset);
    if (!remoteSrc && !remoteSet) return;
    count += 1;
    rewritten += 1;
    // `srcset` is fetched even when src is a data URL, and on its own
    // when there is no src at all — strip it.
    if (remoteSet) {
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
    count += 1;
    rewritten += 1;
  });

  // background="…" on body/table/td, video posters, <input type=image>,
  // media sources.
  FETCHING_ATTRS.forEach(([selector, attr]) => {
    doc.querySelectorAll(selector).forEach((el) => {
      const url = el.getAttribute(attr) || '';
      if (!remote(url)) return;
      el.setAttribute(`data-blocked-${attr}`, url);
      el.removeAttribute(attr);
      count += 1;
      rewritten += 1;
    });
  });

  // SVG <image> and <feImage>, by href or the older xlink:href.
  doc.querySelectorAll('image, feImage').forEach((el) => {
    const url = el.getAttribute('href') || el.getAttributeNS(XLINK_NS, 'href') || '';
    if (!remote(url)) return;
    el.setAttribute('data-blocked-href', url);
    el.removeAttribute('href');
    el.removeAttributeNS(XLINK_NS, 'href');
    count += 1;
    rewritten += 1;
  });

  // <style> blocks: url(), image-set() and @import. Left as they are, the
  // policy refuses them; counted so the banner says something was held
  // back.
  doc.querySelectorAll('style').forEach((el) => {
    count += countCss(el.textContent, resolver, budget);
  });

  // style="background-image: url(https://…)" / "background:…url(…)…"
  doc.querySelectorAll('[style]').forEach((el) => {
    const original = el.getAttribute('style') || '';
    if (!/url\(|image-set|\\/i.test(original)) return;
    const out = replaceRemoteCssUrls(original, resolver, `url(${TRANSPARENT_PIXEL})`);
    count += out.count;
    if (!out.replaced) return;
    rewritten += out.replaced;
    el.setAttribute('data-blocked-style', original);
    el.setAttribute('style', out.css);
  });

  // Strip any `<link rel="…stylesheet" href="https://…">` — external
  // CSS in an email is exotic but if present it can pull tracking
  // pixels of its own. Cheap defence. A data: stylesheet stays (it
  // applies), and the remote URLs inside it are counted; an alternate
  // one never applies, so it is not.
  doc.querySelectorAll('link[href]').forEach((link) => {
    const href = link.getAttribute('href') || '';
    const rels = (link.getAttribute('rel') || '').toLowerCase().split(/[\t\n\f\r ]+/);
    if (remote(href)) {
      link.setAttribute('data-blocked-href', href);
      link.removeAttribute('href');
      count += 1;
      rewritten += 1;
    } else if (rels.includes('stylesheet') && !rels.includes('alternate')) {
      count += countDataSheet(href, resolver, budget);
    }
  });

  return { count, rewritten };
}


/**
 * Make the serialisation read back as the tree it came from, where the
 * HTML serialiser does not: the parser drops the newline that opens a
 * <pre>, <listing> or <textarea>, so one that starts with a newline needs
 * a second; and <plaintext> has no end tag, so what follows it would come
 * back as text. Its text moves into a <pre>, which renders the same way.
 */
function stabilise(doc) {
  for (const el of doc.querySelectorAll('plaintext')) {
    if (el.namespaceURI !== XHTML_NS) continue;
    const pre = doc.createElement('pre');
    pre.textContent = el.textContent;
    el.replaceWith(pre);
  }
  for (const el of doc.querySelectorAll('pre, listing, textarea')) {
    if (el.namespaceURI !== XHTML_NS) continue;
    const first = el.firstChild;
    if (first && first.nodeType === 3 && first.data.charCodeAt(0) === 10) first.data = `\n${first.data}`;
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
 * connections. prepareMessage removes what a policy cannot hold.
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
 * The frame document for a message: `{ srcdoc, blockedCount }`, or
 * `{ refused, text, textCut }` when it is to be shown as text instead.
 * `refused` says why: 'size', 'nesting', 'imports', 'bases', 'slow',
 * 'depth' or 'elements' for a message too heavy to render (see LIMITS),
 * 'unstable' for one whose serialisation will not settle. `text` is the
 * message's own text read off its parsed tree (empty when it was refused
 * before any parse), `textCut` whether it stops short.
 *
 * `allowRemote` is the user's "show images" choice. `head` goes right after
 * the policy, ahead of the email (the caller's <base target> and reset
 * CSS). `decorate(doc)` runs once on the parsed message before anything is
 * removed (the suspicious-link marking). `force` is the user's "show as
 * sent": no LIMITS, and every safety step all the same.
 *
 * The srcdoc returned is checked by parsing it again, as the frame will: it
 * holds no resource hint, no srcdoc frame, nothing past LIMITS, and, with
 * remote content blocked, nothing left to replace by a placeholder. A pass
 * that leaves any of those is redone on its own output, at most three
 * times; 'unstable' is never forced.
 */
export function prepareMessage(html, {
  allowRemote = false, head = '', decorate = null, force = false,
} = {}) {
  const source = String(html || '');
  const tooHeavy = force ? null : heavySource(source);
  if (tooHeavy) return { refused: tooHeavy, text: '', textCut: false };
  const budgetMs = force ? Infinity : LIMITS.parseMs + (LIMITS.parseMsPerMB * source.length) / 1e6;
  const first = parseInert(source, budgetMs);
  let doc = first.doc;
  const refuse = (reason, cut = false) => {
    const { text, textCut } = documentText(doc);
    return { refused: reason, text, textCut: textCut || cut };
  };
  if (!first.complete) return refuse('slow', true);
  const heavy = force ? null : heavyTree(doc.documentElement);
  if (heavy) return refuse(heavy);
  decorate?.(doc);
  const budget = { ...DATA_SHEET_BUDGET };
  let blockedCount = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    outsidePolicy(doc).forEach((el) => el.remove());
    if (!allowRemote) {
      const out = rewriteRemote(doc, budget);
      blockedCount += pass === 0 ? out.count : out.rewritten;
    }
    stabilise(doc);
    const body = doc.documentElement.outerHTML;
    const srcdoc = withRemoteContentPolicy(head + body, allowRemote);
    const check = parseInert(srcdoc, 2 * budgetMs);
    if (!check.complete) return refuse('slow');
    const settled = !outsidePolicy(check.doc).length
      && (force || !heavyTree(check.doc.documentElement))
      && (allowRemote || !rewriteRemote(check.doc, { sheets: 0, bytes: 0 }).rewritten);
    if (settled) return { srcdoc, blockedCount };
    doc = parseInert(body).doc;
  }
  return refuse('unstable');
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
