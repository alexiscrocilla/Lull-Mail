import assert from 'node:assert/strict';
import test from 'node:test';

import { countRemoteCssUrls, remoteContentPolicy, withRemoteContentPolicy } from '../image-blocker.js';

const directives = (policy) => Object.fromEntries(policy.split('; ')
  .map((d) => { const [name, ...sources] = d.split(' '); return [name, sources]; }));

test('the blocked policy allows only what is already on the machine', () => {
  // No 'self' (the app server), no '*', no scheme or host that leaves the
  // machine: every source is one of these.
  const local = new Set(["'none'", "'unsafe-inline'", 'data:', 'blob:', 'cid:']);
  const all = directives(remoteContentPolicy(false));

  assert.deepEqual(all['default-src'], ["'none'"]);
  for (const [name, sources] of Object.entries(all)) {
    for (const source of sources) assert.ok(local.has(source), `${name} ${source}`);
  }
});

test('showing images opens the design resources and nothing else', () => {
  const all = directives(remoteContentPolicy(true));

  for (const name of ['img-src', 'media-src', 'font-src', 'style-src']) {
    assert.deepEqual(all[name].slice(-2), ['http:', 'https:'], name);
  }
  // Frames, objects and connections fall back to this one.
  assert.deepEqual(all['default-src'], ["'none'"]);
});

test('a data: stylesheet applies in both modes', () => {
  for (const shown of [false, true]) {
    assert.ok(directives(remoteContentPolicy(shown))['style-src'].includes('data:'));
  }
});

test('the policy leads the document whatever comes first', () => {
  const meta = /^<meta http-equiv="Content-Security-Policy" content="[^"]+">/;
  const doctype = '<!DOCTYPE html><html><body><p>x</p></body></html>';

  for (const html of ['', '<p>hi</p>', '<html><head></head><body></body></html>', doctype]) {
    assert.match(withRemoteContentPolicy(html), meta);
  }
  // A regex's \s is wider than HTML whitespace: all but the first two open
  // <body> before the doctype, so a <meta> spliced in after the doctype
  // was ignored.
  for (const lead of [' ', '\n', '\u00a0', '\u000b', '\u3000', '\u2028', '\u1680', '\u202f']) {
    assert.match(withRemoteContentPolicy(lead + doctype, true), meta, JSON.stringify(lead));
  }
});

test('remote CSS references are counted in every spelling the browser fetches', () => {
  const css = [
    '.a{background:url(https://x.example/a.gif)}',
    ".b{background:url('//x.example/b.gif')}",
    // No slashes: absolute only when the scheme differs from the page's
    // (http here), which the URL parser decides, not a pattern.
    '.c{background:url("https:x.example/c.gif")}',
    '.d{background:url(" ht\ttps://x.example/d.gif")}',
    '@import "https://x.example/e.css";',
    "@import url('https://x.example/f.css');",
  ].join('\n');

  assert.equal(countRemoteCssUrls(css), 6);
});

test('local CSS references are not counted, relative ones only under a remote base', () => {
  const css = '.a{background:url(data:image/gif;base64,R0lGOD==)}'
    + '.b{background:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\'/%3E")}'
    + '.c{background:url(cid:logo)} .d{background:url(images/bg.jpg)} @import "parts.css";';

  assert.equal(countRemoteCssUrls(css), 0);
  assert.equal(countRemoteCssUrls(css, 'https://cdn.example/nl/'), 2);
});


test('CSS is read the way CSS reads it', () => {
  const remote = (css, base) => countRemoteCssUrls(css, base);
  const sheet = (css) => `data:text/css;base64,${Buffer.from(css).toString('base64')}`;
  const BS = String.fromCharCode(92);

  // Counted: any case, any quoting, whitespace around, parentheses inside
  // quotes, an escaped parenthesis in a bare URL, a data: sheet's own URLs.
  assert.equal(remote('.a{background:URL(https://x.example/u.gif)}'), 1);
  assert.equal(remote('.a{background:url("https://x.example/a(b).gif")}'), 1);
  assert.equal(remote('.a{background:url(\t"https://x.example/q.gif"\n)}'), 1);
  assert.equal(remote(`.a{background:url(https://x.example/a${BS})b.gif)}`), 1);
  assert.equal(remote('@import url("data:text/css,.h%7Bbackground:url(https://x.example/d.gif)%7D");'), 1);
  assert.equal(remote(`@import "${sheet('.h{background:url(https://x.example/e.gif)}')}";`), 1);
  // What both engines fetch and the scanner used to miss: a url( closed by
  // the end of the input, strings in image-set(), escapes in the function
  // name, the at-keyword or the URL itself.
  assert.equal(remote('background-image:url(https://x.example/eof.gif'), 1);
  assert.equal(remote('.e{background:url("https://x.example/eof2.gif'), 1);
  assert.equal(remote("background-image:image-set('https://x.example/i.gif' 1x, \"https://x.example/j.gif\" 2x)"), 2);
  assert.equal(remote('background-image:-webkit-image-set(url(https://x.example/k.gif) 1x)'), 1);
  assert.equal(remote(`@${BS}69mport "https://x.example/c.css";`), 1);
  assert.equal(remote(`background:u${BS}72l(https://x.example/u.gif)`), 1);
  assert.equal(remote(`background:url('ht${BS}74ps://x.example/s.gif')`), 1);
  // Not references: a comment, a string outside @import and image-set(),
  // another function, bad urls, @namespace (it fetches nothing), and a
  // reference into the document from a property that takes an element.
  assert.equal(remote('/* url(https://x.example/c.gif) */'), 0);
  assert.equal(remote('.a::before{content:"url(https://x.example/s.gif)"}'), 0);
  assert.equal(remote('.a{background:myurl(https://x.example/m.gif)}'), 0);
  assert.equal(remote('.a{background:url(https://x.example/a b)}'), 0);
  assert.equal(remote('.a{background:url("https://x.example/a" b)}'), 0);
  assert.equal(remote('@import url(data:text/css,.h%7Bbackground:url(https://x.example/d.gif)%7D);'), 0);
  assert.equal(remote('@namespace svg url(https://x.example/ns);'), 0);
  assert.equal(remote('.a{fill:url(#g)} .b{clip-path:url( #c)} .c{marker-end:url(#m)}', 'https://cdn.example/nl/'), 0);
});

test('a fragment-only URL is local only where it names an element', () => {
  // Chromium resolves background-image:url(#x) against the <base> and
  // fetches it; fill:url(#g) points at a gradient and fetches nothing.
  const base = 'https://cdn.example/nl/';
  assert.equal(countRemoteCssUrls("div{background:url('#x')}", base), 1);
  assert.equal(countRemoteCssUrls('rect{fill:url(#g);stroke:url(#s)}', base), 0);
  // Without a remote base it resolves to the app itself: nothing remote.
  assert.equal(countRemoteCssUrls("div{background:url('#x')}"), 0);
});

test('data: stylesheets are decoded the way the browser decodes them', () => {
  const remote = (css, base) => countRemoteCssUrls(css, base);
  const css = '.k{background:url(https://x.example/k.gif)}';
  const pct = (bytes) => [...bytes].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('');
  const b64 = Buffer.from(css).toString('base64');

  // base64 whose padding is percent-encoded: percent-decode first.
  assert.equal(remote(`@import "data:text/css;base64,${b64.replace(/=/g, '%3D')}";`), 1);
  // UTF-16, by charset and by byte-order mark.
  assert.equal(remote(`@import "data:text/css;charset=utf-16le,${pct(Buffer.from(css, 'utf16le'))}";`), 1);
  assert.equal(remote(`@import "data:text/css,${pct(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(css, 'utf16le')]))}";`), 1);
  // A tab inside the scheme, which the URL parser drops.
  assert.equal(remote(`@import "da\tta:text/css,${encodeURIComponent(css)}";`), 1);
  // Four levels deep.
  let nested = css;
  for (let i = 0; i < 4; i += 1) nested = `@import "data:text/css;base64,${Buffer.from(nested).toString('base64')}";`;
  assert.equal(remote(nested), 1);
  // "#" starts the URL's fragment: what follows is not part of the sheet.
  assert.equal(remote('@import "data:text/css,.k{color:#fff}.k{background:url(https://x.example/after-hash.gif)}";'), 0);
  // Not a stylesheet: data: of another type never applies.
  assert.equal(remote(`@import "data:text/plain,${encodeURIComponent(css)}";`), 0);
  // A relative URL inside resolves against the document, as Chromium does.
  const rel = `@import "data:text/css,${encodeURIComponent('.k{background:url(rel.gif)}')}";`;
  assert.equal(remote(rel), 0);
  assert.equal(remote(rel, 'https://cdn.example/nl/'), 1);
});

test('no hostile CSS can make the count quadratic', () => {
  // Each of these drove an earlier version quadratic: a pattern that
  // swallowed "(", whitespace after url(, a URL resolved against a 100 KB
  // base or data: URL once per reference (7 to 16 s at 200 KB).
  const BS = String.fromCharCode(92);
  const units = ['url(//', 'url("//', "url('//", 'url( ', '@import "', 'url("url(\'',
    `url("${BS}"`, '/*', 'url(((', `u${BS}72l(`, `${BS}`, '@', 'image-set(', 'image-set("'];
  const inputs = [];
  for (const size of [200_000, 2_000_000]) {
    for (const u of units) inputs.push([`${JSON.stringify(u)} x ${size}`, u.repeat(Math.floor(size / u.length))]);
    for (const ch of [' ', '\t', '\n']) inputs.push([`url( then ${JSON.stringify(ch)} x ${size}`, `url(${ch.repeat(size)}x`]);
    inputs.push([`data: @import of url(a), ${size}`, `@import "data:text/css,${'url(a)'.repeat(size / 6)}";`]);
    inputs.push([`data: @import, base64, ${size}`,
      `@import "data:text/css;base64,${Buffer.from('url(a)'.repeat(size / 8)).toString('base64')}";`]);
    inputs.push([`nested data: @imports, ${size}`, `@import "data:text/css,${'@import %22data:text/css,'.repeat(size / 26)}";`]);
  }
  const longBase = `http://example.invalid/${'a'.repeat(100_000)}`;
  for (const [label, css] of inputs) {
    for (const base of [undefined, longBase]) {
      const started = performance.now();
      countRemoteCssUrls(css, base);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 500, `${label}${base ? ', long base' : ''}: ${elapsed.toFixed(0)} ms`);
    }
  }
});
