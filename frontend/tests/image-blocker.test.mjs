import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countRemoteCssUrls, remoteContentPolicy, withRemoteContentPolicy,
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
    '.c{background:url("http:x.example/c.gif")}',
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

test('a hostile run of unclosed url( stays linear', () => {
  // The previous pattern rescanned the rest of the input from every
  // `url(`: 180 KB of this froze the reading pane for seconds in Chromium
  // and over a minute in WebKit.
  for (const unit of ['url(//', 'url("//', "url('//", 'url( ', '@import "', 'url("url(\'']) {
    const css = unit.repeat(Math.floor(200_000 / unit.length));
    const started = performance.now();
    countRemoteCssUrls(css);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 250, `${JSON.stringify(unit)}: ${elapsed.toFixed(0)} ms`);
  }
});
