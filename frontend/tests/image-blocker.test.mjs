import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countRemoteCssUrls, dropOutsidePolicy, remoteContentPolicy, withRemoteContentPolicy,
} from '../image-blocker.js';

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

  // Counted: any case, any quoting, whitespace around, parentheses inside
  // quotes, an escaped parenthesis in a bare URL, a data: sheet's own URLs.
  assert.equal(remote('.a{background:URL(https://x.example/u.gif)}'), 1);
  assert.equal(remote('.a{background:url("https://x.example/a(b).gif")}'), 1);
  assert.equal(remote('.a{background:url(\t"https://x.example/q.gif"\n)}'), 1);
  assert.equal(remote('.a{background:url(https://x.example/a\\)b.gif)}'), 1);
  assert.equal(remote('@import url("data:text/css,.h%7Bbackground:url(https://x.example/d.gif)%7D");'), 1);
  // Unquoted, the "(" inside makes it a bad url: CSS imports nothing.
  assert.equal(remote('@import url(data:text/css,.h%7Bbackground:url(https://x.example/d.gif)%7D);'), 0);
  assert.equal(remote(`@import "${sheet('.h{background:url(https://x.example/e.gif)}')}";`), 1);
  // Not references: a comment, a string that is not an @import, another
  // function, a bad url, a fragment into the document even under a base,
  // and a relative URL inside a data: sheet, which resolves to nothing.
  assert.equal(remote('/* url(https://x.example/c.gif) */'), 0);
  assert.equal(remote('.a::before{content:"url(https://x.example/s.gif)"}'), 0);
  assert.equal(remote('.a{background:myurl(https://x.example/m.gif)}'), 0);
  assert.equal(remote('.a{background:url(https://x.example/a b)}'), 0);
  assert.equal(remote('.a{background:url("https://x.example/a" b)}'), 0);
  assert.equal(remote('.a{fill:url(#g)} .b{clip-path:url( #c)}', 'https://cdn.example/nl/'), 0);
  assert.equal(remote(`@import "${sheet('.h{background:url(rel.gif)}')}";`), 0);
});

test('no hostile run of CSS can make the scan quadratic', () => {
  // Each of these drove a pattern quadratic: the first one swallowed "(",
  // the next let a url( be followed by a long run of whitespace (13 to
  // 19 s for 200 KB in the pane, over 90 s at 2 MB).
  const units = ['url(//', 'url("//', "url('//", 'url( ', '@import "', 'url("url(\'',
    'url("\\"', '/*', 'url(((', 'u\\72l('];
  const inputs = units.map((u) => [JSON.stringify(u), u.repeat(Math.floor(200_000 / u.length))]);
  for (const ch of [' ', '\t', '\n']) {
    inputs.push([`url( then ${JSON.stringify(ch)} x 2 MB`, `url(${ch.repeat(2_000_000)}x`]);
  }
  inputs.push(['url(" then 2 MB with no closing quote', `url("${'a'.repeat(2_000_000)}`]);
  for (const [label, css] of inputs) {
    const started = performance.now();
    countRemoteCssUrls(css);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 250, `${label}: ${elapsed.toFixed(0)} ms`);
  }
});

test('dropping hints edits only the hint tags', () => {
  const page = '<html><head><title>A <link rel="prefetch" href="t"> title</title>\n'
    + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    + '<LINK REL="PreFetch dns-prefetch" HREF="https://x.example/p">\n'
    + '<link rel="preload" as="fetch" href="https://x.example/f" crossorigin>\n'
    + '<link rel="preload" href="https://x.example/q?a=1>2" as="image">\n'
    + '<link rel="stylesheet" href="https://x.example/s.css">\n'
    + '<style>/* <link rel=prefetch href=x> */</style>\n'
    + '</head><body><!-- <link rel="prefetch" href="c"> -->\n'
    + '<pre id="t">\n\nline after one blank line</pre>\n'
    + '<noscript><link rel=prerender href="https://x.example/n"></noscript>\n'
    + '<iframe title="x" srcdoc="&lt;img src=x&gt;" SRCDOC="y"></iframe>\n'
    + '<textarea><link rel="prefetch" href="ta"></textarea>\n'
    + '<plaintext><link rel="prefetch" href="pt">';
  const expected = page
    .replace('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>', '')
    .replace('<LINK REL="PreFetch dns-prefetch" HREF="https://x.example/p">', '')
    .replace('<link rel="preload" as="fetch" href="https://x.example/f" crossorigin>', '')
    .replace('<link rel=prerender href="https://x.example/n">', '')
    .replace('srcdoc="&lt;img src=x&gt;" SRCDOC="y"', 'data-blocked-srcdoc="&lt;img src=x&gt;" data-blocked-srcdoc="y"');

  assert.equal(dropOutsidePolicy(page), expected);
  // Nothing to drop: the very same string back, not a re-serialised one.
  const plain = '<pre>\n\nx</pre><link rel="stylesheet" href="s.css">';
  assert.equal(dropOutsidePolicy(plain), plain);
});

test('no hostile markup can make the hint scan quadratic', () => {
  for (const unit of ['<link', '<link rel="', '<!--', '<style>', '</', '<a b=\'', '<x ', '<link =']) {
    const html = unit.repeat(Math.floor(2_000_000 / unit.length));
    const started = performance.now();
    dropOutsidePolicy(html);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 250, `${JSON.stringify(unit)}: ${elapsed.toFixed(0)} ms`);
  }
});
