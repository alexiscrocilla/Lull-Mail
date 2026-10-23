// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

/*
 * "Remote images blocked" has to mean the message frame asks nothing of a
 * remote host, not that <img src> was rewritten. The rewriter only ever saw
 * img[src], picture sources, style attributes and <link href>; everything
 * below went around it, and a single request is enough to tell a sender the
 * message was opened.
 *
 * Every vector points at its own path on a host that does not exist, so a
 * failure names exactly which ones got through. Nothing leaves the machine:
 * any request to a host other than the test server is recorded and answered
 * locally.
 */

const TRACKER = 'tracker.example';
const leak = (name) => `https://${TRACKER}/${name}`;

const HOSTILE = `<!DOCTYPE html>
<html><head>
<meta http-equiv="refresh" content="1;url=${leak('meta-refresh')}">
<base href="${leak('base/')}">
<link rel="stylesheet" href="${leak('link-stylesheet.css')}">
<link rel="preload" as="image" href="${leak('link-preload.gif')}">
<link rel="prefetch" href="${leak('link-prefetch')}">
<link rel="preload" as="fetch" href="${leak('link-preload-fetch')}" crossorigin>
<style>
@import url("${leak('style-import-url.css')}");
@import "${leak('style-import-string.css')}";
@font-face { font-family: Leak; src: url(${leak('style-font-face.woff2')}); }
.bg { background-image: url('${leak('style-url.gif')}'); font-family: Leak; }
.set { background-image: image-set("${leak('style-image-set.gif')}" 1x); }
.esc { background: u\\72l(${leak('style-escaped-url.gif')}); }
.cur { cursor: url(${leak('style-cursor.png')}), auto; }
.list { list-style-image: url(${leak('style-list-image.gif')}); }
</style>
</head>
<body background="${leak('body-background.gif')}">
<p id="leak-marker">Bonjour, voici votre lettre d'information.</p>
<div class="bg">bg</div><div class="set">set</div><div class="esc">esc</div>
<div class="cur">cur</div><ul class="list"><li>list</li></ul>
<div style="background-image: image-set('${leak('inline-image-set.gif')}' 1x)">inline</div>
<table background="${leak('table-background.gif')}"><tr>
  <td background="${leak('td-background.gif')}">cell</td>
</tr></table>
<img src="relative-to-base.gif" width="20" height="20" alt="">
<img srcset="${leak('img-srcset-only.gif')} 1x" width="20" height="20" alt="">
<img src="https:${TRACKER}/img-no-slashes.gif" width="20" height="20" alt="">
<img src="\\\\${TRACKER}/img-backslashes.gif" width="20" height="20" alt="">
<img src="ht&#9;tps://${TRACKER}/img-tab-in-scheme.gif" width="20" height="20" alt="">
<input type="image" src="${leak('input-image.gif')}" alt="go">
<video poster="${leak('video-poster.gif')}" width="20" height="20"></video>
<video src="${leak('video-src.mp4')}" preload="auto" width="20" height="20"></video>
<audio src="${leak('audio-src.mp3')}" preload="auto"></audio>
<svg width="20" height="20" xmlns:xlink="http://www.w3.org/1999/xlink">
  <image href="${leak('svg-image-href.gif')}" width="20" height="20"/>
  <image xlink:href="${leak('svg-image-xlink.gif')}" width="20" height="20"/>
  <image href="data:," width="20" height="20">
    <set attributeName="href" to="${leak('svg-smil-set.gif')}"/>
  </image>
</svg>
<iframe src="${leak('nested-iframe.html')}" width="20" height="20"></iframe>
<iframe srcdoc="&lt;img src=&quot;${leak('srcdoc-frame-img.gif')}&quot; width=20 height=20&gt;"
        width="20" height="20"></iframe>
<object data="${leak('object-data.png')}" type="image/png" width="20" height="20"></object>
<embed src="${leak('embed-src.png')}" type="image/png" width="20" height="20">
</body></html>`;

// What HOSTILE may load once the user asks for images: the sender's
// pictures, stylesheets, fonts and media. Never a frame, an object, a
// prefetch, a refresh, or anything a nested frame asks for. No preload
// either, not even of an image: WebKit sends a preload as=fetch whatever
// the policy says, so every preload is dropped.
const SHOWN = [
  'audio-src.mp3', 'body-background.gif', 'img-backslashes.gif', 'img-no-slashes.gif',
  'img-srcset-only.gif', 'img-tab-in-scheme.gif', 'inline-image-set.gif', 'input-image.gif',
  'link-stylesheet.css', 'relative-to-base.gif', 'style-cursor.png',
  'style-escaped-url.gif', 'style-font-face.woff2', 'style-image-set.gif',
  'style-import-string.css', 'style-import-url.css', 'style-list-image.gif', 'style-url.gif',
  'svg-image-href.gif', 'svg-image-xlink.gif', 'svg-smil-set.gif', 'table-background.gif',
  'td-background.gif', 'video-poster.gif', 'video-src.mp4',
];

/**
 * Vectors of SHOWN an engine does not fetch even when the policy lets them
 * through, so their absence proves nothing and is not asked for. Measured,
 * with a trusted sender: Chromium on Windows reads `\\host` as a UNC path,
 * which a web page may not load; WebKit neither preloads media nor follows
 * an href set by SMIL.
 */
function unfetchable(browserName) {
  if (browserName === 'webkit') {
    return new Set(['video-src.mp4', 'audio-src.mp3', 'svg-smil-set.gif']);
  }
  return new Set(process.platform === 'win32' ? ['img-backslashes.gif'] : []);
}

const GIF_BASE64 = 'R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const GIF = Buffer.from(GIF_BASE64, 'base64');

// A negative result needs time to be one: fonts, media preload, the SMIL
// <set> and the one-second meta refresh can all fire after the marker
// paints, which is the last thing a locator can wait for. This is that
// margin, not a race.
const SETTLE_MS = 1500;

const isLocal = (url) => ['127.0.0.1', 'localhost'].includes(new URL(url).hostname);
const names = (urls) => [...new Set(urls.map((u) => new URL(u).pathname.split('/').pop()))].sort();

/**
 * Serve `html` (or what `html()` returns at the time) as the body of every
 * message the page opens, with the sender trusted or not, and record what
 * the message asks for: every
 * request to another host, and every request a frame other than the app's
 * own makes, the app server included.
 *
 * Recorded in a route handler, not on the page's `request` event: Chromium
 * announces a request before its policy check, so a fetch the frame's CSP
 * refuses still fires `request`. A route only sees what reached the
 * network.
 */
async function hostileMailbox(page, html, { trusted = false, text = '' } = {}) {
  const fetched = [];
  // The hermetic server cannot reach IMAP, so each message the pane opens
  // schedules a hydration that fails and announces a body event, and the
  // pane rebuilds the frame about every two seconds. Without the event
  // stream the frame under test stays the one the test put in front of it
  // (bodyEvent() below sends one on purpose).
  await page.route('**/api/events**', (route) => route.abort());
  await page.route(/\/api\/emails\/\d+$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const em = await response.json();
    await route.fulfill({
      response,
      json: {
        ...em,
        body_html: typeof html === 'function' ? html() : html,
        body_text: text,
        sender_images_trusted: trusted,
      },
    });
  });
  // Registered last, so it sees every request before the routes above.
  await page.route(() => true, (route) => {
    const request = route.request();
    let fromApp = false;
    try { fromApp = request.frame() === page.mainFrame(); } catch (_) { /* worker */ }
    const local = isLocal(request.url());
    if (!local || !fromApp) fetched.push(request.url());
    if (local) return route.fallback();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('.css')) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    }
    if (path.endsWith('.html')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>remote</p>' });
    }
    return route.fulfill({ status: 200, contentType: 'image/gif', body: GIF });
  });
  return fetched;
}

test.beforeEach(async ({ page }) => {
  // One server serves every spec file and the mailbox is mutable state, so
  // start from the seeded mailbox rather than from whatever the previous
  // file left behind.
  await page.request.post('/__test__/reset');
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  await page.setViewportSize({ width: 1400, height: 900 });
});

const FRAME = '#read-pane .mb-body-iframe';
const BANNER = '#read-pane .mb-img-banner';

async function openFirstInInbox(page) {
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  await page.locator('#email-list .mb-card').first().click();
  await expect(page.locator('#read-pane .mb-read-subject')).toBeVisible();
  await expect(page.frameLocator(FRAME).locator('#leak-marker')).toBeVisible();
  await page.waitForTimeout(SETTLE_MS);
}

async function showOnce(page) {
  await page.locator(`${BANNER} [data-act="show-once"]`).click();
  await expect(page.locator(BANNER)).toHaveCount(0);
  await expect(page.frameLocator(FRAME).locator('#leak-marker')).toBeVisible();
  await page.waitForTimeout(SETTLE_MS);
  // Still the loaded frame: everything recorded since the click came from it.
  await expect(page.locator(BANNER)).toHaveCount(0);
}

function expectShown(fetched, browserName) {
  const skip = unfetchable(browserName);
  expect(names(fetched).filter((n) => !skip.has(n)))
    .toEqual(SHOWN.filter((n) => !skip.has(n)));
}

test('the reading pane fetches nothing remote while images are blocked', async ({ page }) => {
  const fetched = await hostileMailbox(page, HOSTILE);
  await openFirstInInbox(page);

  await expect(page.locator(BANNER)).toBeVisible();
  expect(fetched).toEqual([]);
});

/** The first message of the inbox, opened from an assistant answer. */
async function openInSideReader(page) {
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  const id = await page.locator('#email-list .mb-card').first().getAttribute('data-id');

  await page.route('**/api/assistant/ask', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ text: `[mail:${id}]`, trace: [] }),
  }));
  await page.goto('/#/ai');
  await page.locator('#aiw-input').fill('zzqx message piégé');
  await page.locator('#aiw-input').press('Enter');
  await page.locator(`.aiw-mailcard[data-mail-id="${id}"]`).click();
}

test('the assistant side reader fetches nothing remote', async ({ page }) => {
  const fetched = await hostileMailbox(page, HOSTILE);
  await openInSideReader(page);

  await expect(page.frameLocator('#aiw-reader .aiw-reader-iframe').locator('#leak-marker'))
    .toBeVisible();
  await page.waitForTimeout(SETTLE_MS);

  expect(fetched).toEqual([]);
});

test('a blocked message does not reach the app server either', async ({ page, baseURL }) => {
  // No <base>: a relative URL resolves against the app itself.
  const fetched = await hostileMailbox(page, `<p id="leak-marker">Bonjour.</p>
    <img src="zz-relative.gif" width="20" height="20" alt="">
    <img src="${baseURL}/zz-loopback.gif" width="20" height="20" alt="">
    <div style="background:url(/zz-style-local.gif)">x</div>`);
  await openFirstInInbox(page);

  expect(fetched).toEqual([]);
});

test('a trusted sender gets pictures, styles, fonts and media, and nothing else',
  async ({ page, browserName }) => {
    const fetched = await hostileMailbox(page, HOSTILE, { trusted: true });
    await openFirstInInbox(page);

    await expect(page.locator(BANNER)).toHaveCount(0);
    expectShown(fetched, browserName);
  });

test('"load for this email" gets the same, and only after the click',
  async ({ page, browserName }) => {
    const fetched = await hostileMailbox(page, HOSTILE);
    await openFirstInInbox(page);
    expect(fetched).toEqual([]);

    await showOnce(page);
    expectShown(fetched, browserName);
  });

// Loaded mode renders the email's own markup, not the rewriter's tidy
// <html><head>, so the policy has to hold whatever comes first. Each body
// carries the same three things it must refuse even then.
const refused = (p) => `<p id="leak-marker">Bonjour.</p>
<img src="${leak(`${p}-img.gif`)}" width="20" height="20" alt="">
<iframe src="${leak(`${p}-iframe.html`)}" width="20" height="20"></iframe>
<object data="${leak(`${p}-object.png`)}" type="image/png" width="20" height="20"></object>
<embed src="${leak(`${p}-embed.png`)}" type="image/png" width="20" height="20">`;

const PLACEMENT = [
  {
    title: 'a no-break space before the doctype',
    mode: 'trusted',
    html: `\u00a0<!DOCTYPE html><html><body>${refused('nbsp')}</body></html>`,
    shown: ['nbsp-img.gif'],
  },
  {
    title: 'a <header> and no <head>',
    mode: 'show-once',
    html: `<header>Lettre</header>${refused('header')}`,
    shown: ['header-img.gif'],
  },
  {
    title: 'markup before <html>',
    mode: 'show-once',
    html: `<img src="${leak('early-lead.gif')}" width="20" height="20" alt="">`
      + `<html><head><title>Lettre</title></head><body>${refused('early')}</body></html>`,
    shown: ['early-img.gif', 'early-lead.gif'],
  },
  {
    title: 'a <head> written inside a comment',
    mode: 'trusted',
    html: `<!-- <head> -->${refused('comment')}`,
    shown: ['comment-img.gif'],
  },
  {
    title: 'a <head> written inside an attribute',
    mode: 'trusted',
    html: `<html><body><p title="see the <head> tag">x</p>${refused('attr')}</body></html>`,
    shown: ['attr-img.gif'],
  },
];

// Where our own <base target> and reset CSS landed. Anywhere but <head> and
// the reset is lost or links navigate the sandboxed frame itself; inside a
// comment, nothing of it applies at all.
const injected = (page) => page.locator(FRAME).evaluate((frame) => {
  const doc = frame.contentDocument;
  return {
    policyInHead: !!doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]'),
    baseInHead: !!doc.head.querySelector('base[target="_blank"]'),
    resetPadding: doc.defaultView.getComputedStyle(doc.body).paddingTop,
  };
});

for (const { title, mode, html, shown } of PLACEMENT) {
  test(`the policy holds in loaded mode with ${title}`, async ({ page }) => {
    const fetched = await hostileMailbox(page, html, { trusted: mode === 'trusted' });
    await openFirstInInbox(page);
    if (mode === 'show-once') {
      expect(fetched).toEqual([]);
      await showOnce(page);
    }

    expect(names(fetched)).toEqual(shown);
    expect(await injected(page)).toEqual({ policyInHead: true, baseInHead: true, resetPadding: '8px' });
  });
}

test('a trusted message reads the same once its resource hints are gone', async ({ page }) => {
  // The usual web-font snippet, then a <pre> whose first blank line the
  // parser drops: a parse-and-serialise of the message dropped the next
  // one too.
  const fetched = await hostileMailbox(page, `<html><head>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preload" as="fetch" href="${leak('trusted-preload-fetch')}" crossorigin>
</head><body><p id="leak-marker">Bonjour.</p>
<pre id="t">

line after one blank line</pre></body></html>`, { trusted: true });
  await openFirstInInbox(page);

  const text = await page.locator(FRAME)
    .evaluate((frame) => frame.contentDocument.getElementById('t').textContent);
  expect(text).toBe('\nline after one blank line');
  expect(fetched).toEqual([]);
});

test('a newsletter on a remote <base href> still offers its pictures', async ({ page }) => {
  // Relative paths resolve to the base's host. The policy refuses them like
  // any other remote image, so the banner has to count them, or the
  // message shows grey boxes with no way to load them.
  const fetched = await hostileMailbox(page, `<html><head>
    <base href="${leak('nl/2026-10/')}"></head><body>
    <p id="leak-marker">Lettre d'octobre</p>
    <img src="images/hero.jpg" width="300" height="100" alt="hero">
    <img src="images/logo.png" width="80" height="30" alt="logo">
    </body></html>`);
  await openFirstInInbox(page);

  await expect(page.locator(`${BANNER} .mb-img-banner-label`))
    .toHaveText('2 image(s) distante(s) bloquée(s)');
  expect(fetched).toEqual([]);

  await showOnce(page);
  expect(names(fetched)).toEqual(['hero.jpg', 'logo.png']);
});

const LOCAL_RESOURCES = `<html><head>
<link rel="stylesheet" href="data:text/css,%23dcss%7Bcolor%3Argb(9%2C%209%2C%209)%7D">
<style>@import url("data:text/css,%23dimp%7Bcolor%3Argb(8%2C%208%2C%208)%7D");</style>
</head><body>
<p id="leak-marker">Bonjour.</p>
<p id="dcss">data: stylesheet</p>
<p id="dimp">data: @import</p>
<img id="data-img" src="data:image/gif;base64,${GIF_BASE64}" width="20" height="20" alt="">
<img id="remote-img" src="${leak('control-image.gif')}" width="40" height="40" alt="">
</body></html>`;

// Read from the parent: the pane's frame is same-origin and runs nothing.
const frameState = (page) => page.locator(FRAME).evaluate((frame) => {
  const doc = frame.contentDocument;
  const style = (id) => doc.defaultView.getComputedStyle(doc.getElementById(id));
  const remote = doc.getElementById('remote-img');
  return {
    dataImage: doc.getElementById('data-img').naturalWidth,
    dataStylesheet: style('dcss').color,
    dataImport: style('dimp').color,
    remoteSrc: remote.currentSrc,
    remoteLoaded: remote.complete && remote.naturalWidth > 0,
    placeholder: style('remote-img').backgroundColor,
  };
});

test('what is already on the machine renders under the blocked policy', async ({ page }) => {
  const fetched = await hostileMailbox(page, LOCAL_RESOURCES);
  await openFirstInInbox(page);

  const state = await frameState(page);
  expect(state).toMatchObject({
    dataImage: 1,
    dataStylesheet: 'rgb(9, 9, 9)',
    dataImport: 'rgb(8, 8, 8)',
    placeholder: 'rgb(203, 213, 225)',
  });
  expect(state.remoteSrc).toMatch(/^data:image\/gif/);
  expect(fetched).toEqual([]);
});

test('a trusted sender gets both its pictures and the local ones', async ({ page }) => {
  const fetched = await hostileMailbox(page, LOCAL_RESOURCES, { trusted: true });
  await openFirstInInbox(page);

  await expect.poll(async () => (await frameState(page)).remoteLoaded).toBe(true);
  expect(await frameState(page)).toMatchObject({
    dataImage: 1,
    dataStylesheet: 'rgb(9, 9, 9)',
    dataImport: 'rgb(8, 8, 8)',
    remoteSrc: leak('control-image.gif'),
  });
  expect(names(fetched)).toEqual(['control-image.gif']);
});

const BASE = '<base href="https://x.example/nl/">';

/**
 * label -> [email HTML, what the banner should count]. The count follows
 * what the engine would fetch, so one row depends on it: Chromium on
 * Windows reads `\\host` as a UNC path it will not load.
 */
function countCases(browserName) {
  const chromium = browserName === 'chromium';
  return {
    'a remote src': ['<img src="https://x.example/a.gif">', 1],
    'a \\\\host src': ['<img src="\\\\x.example/a.gif">', chromium && process.platform === 'win32' ? 0 : 1],
    'a srcset holding an inline SVG':
      [`<img srcset="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E 1x">`, 0],
    'a remote second srcset candidate': [`<img src="data:image/gif;base64,${GIF_BASE64}"
      srcset="data:image/gif;base64,${GIF_BASE64} 1x, https://x.example/b.gif 2x">`, 1],
    'a comma inside a descriptor\'s parentheses':
      ['<img srcset="a.gif 1x(,b),https://x.example/p.gif 2x">', 1],
    'relative paths and no <base>': ['<img src="a.jpg"><img src="/b.png">', 0],
    'the app\'s own origin': ['<img src="{APP}/x.gif">', 0],
    'https: with no slashes': ['<img src="https:x.example/a.gif">', 1],
    'a tab inside the scheme': ['<img src="ht&#9;tps://x.example/a.gif">', 1],
    'a table background': ['<table background="https://x.example/bg.gif"><tr><td>x</td></tr></table>', 1],
    '<style> url() and @import':
      ['<style>@import "https://x.example/a.css"; .a{background:url(//x.example/b.gif)}</style>', 2],
    '<style> data: url()': [`<style>.a{background:url(data:image/gif;base64,${GIF_BASE64})}</style>`, 0],
    // A remote <base> moves every relative reference, not only <img src>.
    'base: img src': [`${BASE}<img src="a.jpg"><img src="b/c.png">`, 2],
    'base: img srcset': [`${BASE}<img srcset="a.jpg 1x">`, 1],
    'base: table background': [`${BASE}<table background="bg.gif"><tr><td>x</td></tr></table>`, 1],
    'base: video poster': [`${BASE}<video poster="p.gif"></video>`, 1],
    'base: SVG image': [`${BASE}<svg><image href="i.gif"/></svg>`, 1],
    'base: stylesheet link': [`${BASE}<link rel="stylesheet" href="s.css">`, 1],
    'base: <style> url()': [`${BASE}<style>.a{background:url(bg.gif)}</style>`, 1],
    'base: style attribute': [`${BASE}<div style="background:url(bg.gif)">x</div>`, 1],
    // ...except a reference into the document itself.
    'base: url(#id) in SVG styles': [`${BASE}<svg><rect style="fill:url(#g)"/></svg>`
      + '<style>.s{clip-path:url(#c)}</style>', 0],
    // Only an HTML <base> counts, as in the frame.
    'an SVG <base> alone': ['<svg><base href="https://x.example/svg/"></base></svg><img src="a.jpg">', 0],
    'an SVG <base> ahead of the HTML one':
      ['<svg><base href="x/"></base></svg><base href="https://x.example/h/"><img src="a.jpg">', 1],
    // Relative to an http page in both frames (WebKit's DOMParser alone
    // read it as absolute, which the old count trusted).
    'a slashless http: base': ['<base href="http:x.example/hn/"><img src="a.jpg">', 0],
    'a data: stylesheet with a remote URL inside': [
      '<link rel="stylesheet" href="data:text/css,.h%7Bbackground%3Aurl(https%3A%2F%2Fx.example%2Fd.gif)%7D">', 1],
    'a data: @import with a remote URL inside':
      ['<style>@import url("data:text/css,.h%7Bbackground:url(https://x.example/e.gif)%7D");</style>', 1],
    'a srcdoc frame and resource hints, which are dropped': [`<iframe srcdoc="&lt;p&gt;x"></iframe>
      <link rel="prefetch" href="https://x.example/p"><link rel="dns-prefetch" href="//x.example">
      <link rel="preload" as="fetch" href="https://x.example/f">`, 0],
    // What both engines fetch and the count used to miss.
    'image-set() strings, in <style> and style=': ['<style>.h{background-image:image-set("https://x.example/s.gif" 1x)}</style>'
      + `<div style="background-image:image-set('https://x.example/a.gif' 1x)">x</div>`, 2],
    'a url( closed by the end of a style attribute': ['<div style="background-image:url(https://x.example/eof.gif">x</div>', 1],
    'escapes in CSS': ['<style>@\\69mport "https://x.example/c.css"; .u{background:u\\72l(https://x.example/u.gif)}'
      + " .s{background:url('ht\\74ps://x.example/s.gif')}</style>", 3],
    'an SVG feImage': ['<svg><filter id="f"><feImage href="https://x.example/fe.gif"/></filter></svg>', 1],
    'a data: @import in base64 with %3D padding': ['<style>@import "data:text/css;base64,'
      + `${Buffer.from('.b{background:url(https://x.example/b.gif)}').toString('base64').replace(/=/g, '%3D')}";</style>`, 1],
    'base: a relative URL inside a data: stylesheet':
      [`${BASE}<link rel="stylesheet" href="data:text/css,.k%7Bbackground:url(rel.gif)%7D">`, 1],
    'base: background url(#x), which Chromium fetches': [`${BASE}<div style="background:url('#x')">x</div>`, 1],
    'a long remote <base>': [`<base href="https://x.example/${'a'.repeat(5000)}/"><img src="a.gif">`, 1],
    // ...and what fetches nothing, which it used to count.
    '@namespace': ['<style>@namespace svg url(https://x.example/ns);</style>', 0],
    'an alternate data: stylesheet, which never applies': ['<link rel="alternate stylesheet" title="alt" '
      + 'href="data:text/css,.h%7Bbackground%3Aurl(https%3A%2F%2Fx.example%2Fd.gif)%7D">', 0],
    'a "#" inside a data: stylesheet, which ends its URL':
      ['<style>@import "data:text/css,.k{color:#fff}.k{background:url(https://x.example/h.gif)}";</style>', 0],
  };
}

/**
 * Run prepareMessage in the page on each message of `cases` and parse each
 * srcdoc it returns, as the frame will: the count, the srcdoc, and what in
 * it no policy could hold.
 */
function prepared(page, cases, options = {}) {
  return page.evaluate(async ([all, opts]) => {
    const { prepareMessage } = await import('/static/image-blocker.js');
    return Object.fromEntries(Object.entries(all).map(([label, html]) => {
      const out = prepareMessage(html.replace('{APP}', location.origin), opts);
      if (!out.srcdoc) return [label, { refused: out.refused }];
      const doc = new DOMParser().parseFromString(out.srcdoc, 'text/html');
      return [label, {
        count: out.blockedCount,
        srcdoc: out.srcdoc,
        hints: [...doc.querySelectorAll('link')]
          .filter((l) => /pre|dns/i.test(l.getAttribute('rel') || '')).length,
        srcdocFrames: doc.querySelectorAll('iframe[srcdoc]').length,
      }];
    }));
  }, [cases, options]);
}

test('the banner counts what the policy refuses', async ({ page, browserName }) => {
  await page.goto('/#/inbox');
  const cases = countCases(browserName);
  const got = await prepared(page, Object.fromEntries(Object.entries(cases).map(([label, [html]]) => [label, html])));

  expect(Object.fromEntries(Object.entries(got).map(([label, out]) => [label, out.count])))
    .toEqual(Object.fromEntries(Object.entries(cases).map(([label, [, count]]) => [label, count])));
});

test('a reference into the document survives a remote <base>', async ({ page }) => {
  await page.goto('/#/inbox');
  const { srcdoc } = (await prepared(page, { svg: `${BASE}<svg><rect style="fill:url(#g)"/></svg>` })).svg;

  expect(srcdoc).toContain('style="fill:url(#g)"');
  expect(srcdoc).not.toContain('data-blocked-style');
});

// Markup a hand-written scanner reads differently from the HTML parser, and
// serialisations the parser reads back as something else. Each carries
// what no policy can hold: hints and a srcdoc frame.
const hidden = (n) => `<link rel="prefetch" href="${leak(`${n}-pf`)}">`
  + `<link rel="preload" as="fetch" href="${leak(`${n}-pff`)}" crossorigin>`;
const PARSER_TRAPS = {
  'a comment closed by <!-->': `<p>m</p><!-->${hidden('c1')}<!-- -->`,
  'a comment closed by <!--->': `<p>m</p><!--->${hidden('c2')}<!-- -->`,
  'a comment closed by --!>': `<p>m</p><!-- x --!>${hidden('c3')}<!-- -->`,
  'an end tag with a quoted ">"': `<p>m</p></x a='><style>'>${hidden('c4')}`,
  'an SVG <title>': `<p>m</p><svg><title>${hidden('c5')}</title></svg>`,
  'an SVG <style> left by </svg>': `<p>m</p><svg><style></svg>${hidden('c6')}`,
  'a MathML <style> left by </math>': `<p>m</p><math><style></math>${hidden('c7')}`,
  'an SVG <plaintext>': `<p>m</p><svg><plaintext></svg>${hidden('c8')}`,
  'an SVG CDATA section': `<p>m</p><svg><![CDATA[ > <title> ]]></svg>${hidden('c9')}`,
  'character references in rel': `<p>m</p><link rel="pre&#102;etch" href="${leak('c10')}">`
    + `<link rel="pre&#108;oad" as="fetch" href="${leak('c10b')}" crossorigin>`,
  'a srcdoc frame inside an SVG <title>': `<p>m</p><svg><title><iframe srcdoc="&lt;link rel=prefetch `
    + `href=${leak('c11')}&gt;"></iframe></title></svg>`,
  'a "<" left in front of a hint': `<p>m</p><<link rel=prefetch href=x>link rel="prefetch" href="${leak('c12')}">`,
  'a "<" left in front of a srcdoc frame': `<p>m</p><<link rel=prefetch href=x>iframe `
    + `srcdoc="&lt;img src=${leak('c13.gif')}&gt;"></iframe>`,
  // Read as text inside an HTML <style> the first time, and as a live <link>
  // once serialised and parsed again: nested <form>s confuse the namespace.
  'a <link> that a reparse brings to life': '<p id="leak-marker">m</p><form><math><mtext></form><form><mglyph><style>'
    + `</math><link rel="preload" as="fetch" href="${leak('mx-pff')}" crossorigin>`,
};

for (const allowRemote of [false, true]) {
  test(`nothing a policy cannot hold survives the parser's tricks, images ${allowRemote ? 'shown' : 'blocked'}`,
    async ({ page }) => {
      await page.goto('/#/inbox');
      const got = await prepared(page, PARSER_TRAPS, { allowRemote });
      for (const [label, out] of Object.entries(got)) {
        expect(out, label).toMatchObject({ hints: 0, srcdocFrames: 0 });
      }
    });
}

test('a <link> a reparse brings to life fetches nothing with images blocked', async ({ page }) => {
  // WebKit sends a preload as=fetch whatever the policy says; serialising
  // the old rewriter's tree turned this text into one.
  const fetched = await hostileMailbox(page, PARSER_TRAPS['a <link> that a reparse brings to life']);
  await openFirstInInbox(page);

  expect(fetched).toEqual([]);
});

test('hints the old text scanner missed fetch nothing for a trusted sender', async ({ page }) => {
  const traps = Object.entries(PARSER_TRAPS).filter(([label]) => !label.includes('reparse'))
    .map(([, html]) => html.replace('<p>m</p>', '')).join('');
  const fetched = await hostileMailbox(page, `<p id="leak-marker">m</p>${traps}`, { trusted: true });
  await openFirstInInbox(page);

  expect(fetched).toEqual([]);
});

test('a trusted message reads the same, flagged links and all', async ({ page }) => {
  // A shortener link is flagged, which used to send the whole message
  // through a parse and serialise: the <pre> lost a line and the tail of
  // <plaintext> showed its closing tags as text.
  await hostileMailbox(page, '<p id="leak-marker"><a href="https://bit.ly/abc">lien</a></p>'
    + '<pre id="t">\n\nline after one blank line</pre><plaintext>tail <b>x</b>', { trusted: true });
  await openFirstInInbox(page);

  const text = await page.locator(FRAME).evaluate((frame) => ({
    pre: frame.contentDocument.getElementById('t').textContent,
    tail: frame.contentDocument.body.textContent.split('line after one blank line')[1],
    flagged: frame.contentDocument.querySelector('a').getAttribute('href'),
  }));
  expect(text.pre).toBe('\nline after one blank line');
  expect(text.tail).toBe('tail <b>x</b>');
  expect(text.flagged).not.toBe('https://bit.ly/abc');
});

/*
 * The shapes of real mail an earlier version refused as too deep or too
 * long, at the sizes the review corpus had them. Each must render as sent.
 * `#deepest` is the innermost or last element, the one layout gets to last.
 */
function promotion(levels) {
  let html = `<p id="deepest">Flash sale! ${'Save big today. '.repeat(10)}</p>`
    + '<img src="https://cdn.example.com/sale.gif" width="600" height="300">';
  for (let i = 0; i < levels; i += 1) {
    html = `<div style="padding:2px"><table width="100%"><tr><td>${html}</td></tr></table></div>`;
  }
  return `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
}

function layoutTables(levels, sections) {
  let html = '';
  for (let s = 0; s < sections; s += 1) {
    html += `<tr><td style="padding:10px"><h2>Section ${s}</h2><p>${'word '.repeat(40)}</p>`
      + `<img src="https://cdn.example.com/s${s}.gif" width="600" height="200">`
      + `<a href="https://shop.example.com/${s}">Shop now</a></td></tr>`;
  }
  html = `<table width="600" align="center">${html}</table><p id="deepest">Unsubscribe</p>`;
  for (let i = 0; i < levels; i += 1) {
    html = `<table width="100%" bgcolor="#f4f4f4"><tr><td align="center">${html}</td></tr></table>`;
  }
  return `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
}

function quotedReplies(replies) {
  let html = '<div dir="ltr" id="deepest">The first message of the thread.</div>';
  for (let i = 0; i < replies; i += 1) {
    html = `<div class="gmail_quote"><div class="gmail_attr">On Mon, ${i} Jan 2026, A wrote:<br></div>`
      + '<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">'
      + `<div dir="ltr">Reply ${i}. ${'quoted text '.repeat(20)}</div>${html}</blockquote></div>`;
  }
  return `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
}

function invoice(lines) {
  let rows = '';
  for (let i = 0; i < lines; i += 1) {
    rows += `<tr><td>${i}</td><td>Item ${i} with some detail</td><td>${i * 3}</td>`
      + `<td>$${(i * 9.99).toFixed(2)}</td></tr>`;
  }
  return '<!DOCTYPE html><html><head><style>td{border:1px solid #ddd;padding:6px}</style></head><body>'
    + '<h1>Invoice</h1><table><thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Amount</th></tr></thead>'
    + `<tbody>${rows}</tbody></table><p id="deepest">Total</p></body></html>`;
}

function newsletter(bytes) {
  const stories = [];
  for (let i = 0, size = 0; size < bytes; i += 1) {
    const story = `<tr><td style="padding:12px"><table width="100%"><tr><td><h3>Story ${i}</h3>`
      + `<p>${'A reasonably long paragraph of newsletter copy. '.repeat(8)}</p>`
      + `<img src="https://cdn.example.com/track.gif?i=${i}" width="560" height="240">`
      + `<p><a href="https://example.com/${i}">Read more</a></p></td></tr></table></td></tr>`;
    stories.push(story);
    size += story.length;
  }
  return '<!DOCTYPE html><html><head></head><body>'
    + `<table align="center">${stories.join('')}</table><p id="deepest">Unsubscribe</p></body></html>`;
}

const REAL_MAIL = {
  'a promotion 40 div+table levels deep': promotion(40),
  'a promotion 60 div+table levels deep': promotion(60),
  'a newsletter in 55 nested layout tables': layoutTables(55, 30),
  'a thread of 100 quoted Gmail replies': quotedReplies(100),
  'an invoice of 5,000 lines': invoice(5_000),
  'a 3 MB newsletter': newsletter(3_000_000),
  'a 4.5 MB newsletter': newsletter(4_500_000),
};

/** What prepareMessage makes of each message, and how long it takes. */
function preparedTimes(page, cases) {
  return page.evaluate(async (all) => {
    const { prepareMessage } = await import('/static/image-blocker.js');
    return Object.fromEntries(Object.entries(all).map(([label, html]) => {
      const started = performance.now();
      const out = prepareMessage(html);
      return [label, { refused: out.refused || null, ms: performance.now() - started }];
    }));
  }, cases);
}

test('real mail renders as sent, however deep or long', async ({ page }) => {
  await page.goto('/#/inbox');
  const got = await preparedTimes(page, REAL_MAIL);
  for (const [label, { refused, ms }] of Object.entries(got)) {
    expect(refused, label).toBeNull();
    expect(ms, label).toBeLessThan(2000);
  }
});

/**
 * The open message's frame laid out to the end: loaded down to `#deepest`,
 * then fitted to its content (the fitting reads the layout, so a frame
 * stuck in it never gets there), and the deepest element given a box,
 * squeezed to no width in a deep thread as any reader shows one.
 */
async function laidOut(page, timeout) {
  await expect.poll(() => page.locator(FRAME).evaluate((frame) => {
    const doc = frame.contentDocument;
    return !!doc && doc.readyState === 'complete' && !!doc.getElementById('deepest')
      && parseFloat(frame.style.height) > 0;
  }), { timeout }).toBe(true);
  const bottom = await page.frameLocator(FRAME).locator('#deepest')
    .evaluate((el) => el.getBoundingClientRect().bottom);
  expect(bottom).toBeGreaterThan(0);
}

for (const label of [
  'a promotion 60 div+table levels deep',
  'a newsletter in 55 nested layout tables',
  'a thread of 100 quoted Gmail replies',
]) {
  test(`${label} opens in the reading pane as sent`, async ({ page }) => {
    await hostileMailbox(page, REAL_MAIL[label]);
    await openFirst(page);

    // Each settles in well under a second in either engine.
    await laidOut(page, 15_000);
    await expect(page.locator('#read-pane .mb-body-notice')).toHaveCount(0);
  });
}

// WebKit took 5.5 to 14.5 s to settle the 4.5 MB newsletter on one dev
// machine, depending on load (the slowness is a known issue in the 0.15.4
// notes), which no budget can promise a slower runner. It opens a 1 MB one
// instead, the same path, settled in 1.5 s there; Chromium, the engine the
// Windows app runs on, opens the 4.5 MB one, settled in 2.5 s.
const LARGE_NEWSLETTER = { chromium: REAL_MAIL['a 4.5 MB newsletter'], webkit: newsletter(1_000_000) };

test('a large newsletter opens in the reading pane as sent', async ({ page, browserName }) => {
  test.setTimeout(120_000);
  await hostileMailbox(page, LARGE_NEWSLETTER[browserName]);
  await openFirst(page);

  await laidOut(page, 60_000);
  await expect(page.locator('#read-pane .mb-body-notice')).toHaveCount(0);
});

// Markup made to stall the reader, and what turns each one away: the
// estimates read off the raw text, the parse's time budget, or the checks
// on the parsed tree.
const BOMBS = {
  '200,000 nested blocks': ['<div>'.repeat(200_000), ['nesting']],
  '20,000 nested blocks, each hiding a </div> in an attribute':
    ['<div title="</div>">'.repeat(20_000), ['slow', 'depth']],
  '120 nested tables': [`${'<table><tr><td>'.repeat(120)}deep`, ['depth']],
  '130 quoted Gmail replies': [`${'<div class="gmail_quote"><blockquote>'.repeat(130)}deep`, ['depth']],
  'a million stray </p>': [`x${'</p>'.repeat(1_000_000)}`, ['elements']],
  '160,000 line breaks': ['mot<br>'.repeat(160_000), ['elements']],
  '20,000 @import rules': [`<style>${'@import "x.css";'.repeat(20_000)}</style>`, ['imports']],
};

test('markup made to stall the reader is turned away within a second', async ({ page }) => {
  await page.goto('/#/inbox');
  const got = await preparedTimes(page, Object.fromEntries(
    Object.entries(BOMBS).map(([label, [html]]) => [label, `<p>m</p>${html}`]),
  ));
  for (const [label, [, reasons]] of Object.entries(BOMBS)) {
    expect(reasons, label).toContain(got[label].refused);
    expect(got[label].ms, label).toBeLessThan(1000);
  }
});

/**
 * The first message of the inbox, opened: the pane's header in place. In
 * place, not visible: for a large message, being visible waits on the
 * frame's layout, which the tests that care time on their own.
 */
async function openFirst(page) {
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  await page.locator('#email-list .mb-card').first().click();
  await expect(page.locator('#read-pane .mb-read-subject')).toBeAttached({ timeout: 30_000 });
}

/** The open message, rendered again the way a body event renders it. */
async function bodyEvent(page) {
  const block = page.locator('#read-pane .mb-body-block');
  const intId = Number(await block.getAttribute('data-int-id'));
  await block.evaluate((el) => el.setAttribute('data-before', ''));
  await Promise.all([
    page.waitForResponse((r) => /\/api\/emails\/\d+$/.test(new URL(r.url()).pathname)),
    page.evaluate((id) => window.dispatchEvent(new CustomEvent('lull:body', { detail: { int_id: id } })), intId),
  ]);
  await expect(page.locator('#read-pane .mb-body-block[data-before]')).toHaveCount(0, { timeout: 30_000 });
}

/** Samples the page's main thread from now on, until it navigates. */
async function stallSampler(page) {
  await page.evaluate(() => {
    window.zzStall = { last: performance.now(), worst: 0 };
    setInterval(() => {
      const now = performance.now();
      window.zzStall.worst = Math.max(window.zzStall.worst, now - window.zzStall.last);
      window.zzStall.last = now;
    }, 20);
  });
  return {
    reset: () => page.evaluate(() => { window.zzStall.worst = 0; window.zzStall.last = performance.now(); }),
    worst: () => page.evaluate(() => window.zzStall.worst),
  };
}

test('a message too long to render shows its text, and its beginning as sent', async ({ page }) => {
  // Two forced renders of 140,000 elements, 1.6 to 2.2 s each on a dev
  // machine, and 200,000 characters of text: 10 to 15 s in all there.
  test.setTimeout(90_000);
  // Past the element limit. No text part: the text is the HTML's own.
  await hostileMailbox(page, `<p id="leak-marker">Bonjour Alice,</p>${'mot<br>'.repeat(160_000)}`);
  await openFirst(page);

  const notice = page.locator('#read-pane .mb-body-notice');
  await expect(notice).toContainText('Message très long, affiché en texte');
  await expect(page.locator('#read-pane .mb-body-text')).toContainText('Bonjour Alice,');
  // 640,000 characters, more than a refused message gets back.
  await expect(page.locator('#read-pane .mb-body-cut')).toHaveText('(texte tronqué)');
  await expect(page.locator(FRAME)).toHaveCount(0);

  await notice.locator('[data-act="show-as-sent"]').click();
  await expect(page.frameLocator(FRAME).locator('#leak-marker')).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveCount(0);
  await expect(page.locator('#read-pane .mb-body-simplified')).toContainText('seulement le début');

  await bodyEvent(page);
  await expect(page.frameLocator(FRAME).locator('#leak-marker')).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveCount(0);
});

for (const tables of [128, 200]) {
  test(`"show as sent" renders ${tables} nested tables at once, flattened`, async ({ page }) => {
    // Rendered as written, a 2 KB message like this one kept Chromium busy
    // for minutes, the whole app with it.
    await hostileMailbox(page, `<p id="leak-marker">m</p>${'<table><tr><td>'.repeat(tables)}deep`);
    await openFirst(page);
    const notice = page.locator('#read-pane .mb-body-notice');
    await expect(notice).toContainText('Message très imbriqué, affiché en texte');
    const stalls = await stallSampler(page);

    await notice.locator('[data-act="show-as-sent"]').click();
    const frame = page.frameLocator(FRAME);
    // 0.3 s in Chromium, 1.3 s in WebKit on a dev machine: the stall
    // below, not this wait, is what tells a freeze.
    await expect(frame.locator('#leak-marker')).toBeVisible({ timeout: 20_000 });
    await expect(frame.locator('body')).toContainText('deep');
    await expect(page.locator('#read-pane .mb-body-simplified')).toContainText('mise en page aplatie');
    // The frame is fitted again 120 and 400 ms after it loads.
    await page.waitForTimeout(600);
    expect(await stalls.worst()).toBeLessThan(2000);

    // And the app still answers: the next message opens.
    const next = await page.locator('#email-list .mb-card').nth(1).getAttribute('data-id');
    await page.locator('#email-list .mb-card').nth(1).click();
    await expect(page.locator(`#read-pane .mb-body-block[data-int-id="${next}"]`)).toBeAttached({ timeout: 20_000 });
  });
}

test('"show as sent" reads every bomb within its bounds, into a frame within the limits', async ({ page }) => {
  // About 5.5 s in all on a dev machine.
  test.setTimeout(90_000);
  await page.goto('/#/inbox');
  const got = await page.evaluate(async (all) => {
    const { prepareMessage } = await import('/static/image-blocker.js');
    return Object.fromEntries(Object.entries(all).map(([label, [html]]) => {
      const started = performance.now();
      const out = prepareMessage(`<p>m</p>${html}`, { force: true });
      const ms = performance.now() - started;
      // What the frame is given passes the limits without being forced.
      const again = out.srcdoc ? prepareMessage(out.srcdoc).refused || null : 'none';
      return [label, { ms, refused: out.refused || null, again }];
    }));
  }, BOMBS);
  for (const [label, [, reasons]] of Object.entries(BOMBS)) {
    const { ms, refused, again } = got[label];
    // A second of parse at most, then the unwrapping and the checks: at
    // most 1.9 s on a dev machine, against the minutes it took unbounded.
    expect(ms, label).toBeLessThan(10_000);
    if (reasons.includes('imports')) {
      expect(refused, label).toBe('imports');
    } else {
      expect(refused, label).toBeNull();
      // Within the limits on depth and size. 'slow' would only say this
      // machine read a megabyte slower than the normal budget allows.
      expect([null, 'slow'], label).toContain(again);
    }
  }
});

test('markup that would cost the frame what it cost the blocker gets no "show as sent"', async ({ page }) => {
  await hostileMailbox(page, `<p>Bonjour.</p><style>${'@import "x.css";'.repeat(20_000)}</style>`);
  await openFirst(page);

  const notice = page.locator('#read-pane .mb-body-notice');
  await expect(notice).toContainText('ne peut pas être affiché tel quel');
  await expect(notice.locator('[data-act="show-as-sent"]')).toHaveCount(0);
});

test('a text part cut at the fetcher\'s cap gives way to the text of the HTML', async ({ page }) => {
  const words = 'Paragraphe. '.repeat(1_000);
  await hostileMailbox(page, `<p>${words}</p>${'<br>'.repeat(160_000)}<p>Fin du message.</p>`,
    { text: words.slice(0, 8_000) });
  await openFirst(page);

  await expect(page.locator('#read-pane .mb-body-notice')).toBeVisible();
  await expect(page.locator('#read-pane .mb-body-text')).toContainText('Fin du message.');
  await expect(page.locator('#read-pane .mb-body-cut')).toHaveCount(0);
});

test('a text-only message at the fetcher\'s cap is said cut', async ({ page }) => {
  await hostileMailbox(page, '', { text: 'Paragraphe. '.repeat(1_000).slice(0, 8_000) });
  await openFirst(page);

  await expect(page.locator('#read-pane .mb-body-text')).toContainText('Paragraphe.');
  await expect(page.locator('#read-pane .mb-body-cut')).toHaveText('(texte tronqué)');
});

test('"load for this email" holds when the message is rendered again', async ({ page }) => {
  await hostileMailbox(page, HOSTILE);
  await openFirstInInbox(page);
  await showOnce(page);

  await bodyEvent(page);
  await expect(page.frameLocator(FRAME).locator('#leak-marker')).toBeVisible();
  await expect(page.locator(BANNER)).toHaveCount(0);
});

test('the assistant side reader shows a heavy message as its text', async ({ page }) => {
  await hostileMailbox(page, `<p>Bonjour Alice,</p>${'<br>'.repeat(160_000)}<p>Fin du message.</p>`);
  await openInSideReader(page);

  await expect(page.locator('#aiw-reader .aiw-reader-text')).toContainText('affiché ici en texte');
  await expect(page.locator('#aiw-reader .aiw-reader-text')).toContainText('Fin du message.');
  await expect(page.locator('#aiw-reader .aiw-reader-iframe')).toHaveCount(0);
});

/**
 * Messages whose only remote reference is one kind of picture, for the
 * differential test. `u(name)` is a URL under the message's own path, so
 * a request tells which message made it.
 */
const ONE_PICTURE = {
  img: (u) => `<img src="${u('a.gif')}" width="9" height="9">`,
  srcset: (u) => `<img srcset="${u('a.gif')} 1x" width="9" height="9">`,
  picture: (u) => `<picture><source srcset="${u('a.gif')}"><img width="9" height="9"></picture>`,
  background: (u) => `<table background="${u('a.gif')}" width="9" height="9"><tr><td>b</td></tr></table>`,
  poster: (u) => `<video poster="${u('a.gif')}" width="9" height="9"></video>`,
  input: (u) => `<input type="image" src="${u('a.gif')}" alt="i">`,
  svgImage: (u) => `<svg width="9" height="9"><image href="${u('a.gif')}" width="9" height="9"/></svg>`,
  feImage: (u) => `<svg width="9" height="9"><filter id="f"><feImage href="${u('a.gif')}"/></filter>`
    + '<rect width="9" height="9" filter="url(#f)"/></svg>',
  styleAttr: (u) => `<div style="width:9px;height:9px;background:url(${u('a.gif')})">s</div>`,
  imageSetAttr: (u) => `<div style="width:9px;height:9px;background-image:image-set('${u('a.gif')}' 1x)">s</div>`,
  eofAttr: (u) => `<div style="width:9px;height:9px;background-image:url(${u('a.gif')}">s</div>`,
  styleUrl: (u) => `<style>.d{width:9px;height:9px;background:url(${u('a.gif')})}</style><div class="d">s</div>`,
  styleEscape: (u) => `<style>.d{width:9px;height:9px;background:url('ht\\74ps${u('a.gif').slice(5)}')}</style>`
    + '<div class="d">s</div>',
  imports: (u) => `<style>@import "${u('a.css')}";</style>`,
  escapedImport: (u) => `<style>@\\69mport "${u('a.css')}";</style>`,
  dataSheet: (u) => `<link rel="stylesheet" href="data:text/css,.d%7Bwidth:9px;height:9px;background:url(${u('a.gif')})%7D">`
    + '<div class="d">s</div>',
  baseRelative: (u) => `<base href="${u('')}"><img src="a.gif" width="9" height="9">`,
  baseFragment: (u) => `<base href="${u('')}"><div style="width:9px;height:9px;background:url('#x')">s</div>`,
  baseDataSheet: (u) => `<base href="${u('')}"><link rel="stylesheet" href="data:text/css,.d%7Bwidth:9px;`
    + 'height:9px;background:url(a.gif)%7D"><div class="d">s</div>',
  // These fetch nothing in either engine, and must not be counted.
  namespace: (u) => `<style>@namespace svg url(${u('ns')});</style>`,
  fillFragment: (u) => `<base href="${u('')}"><svg width="9" height="9">`
    + '<rect width="9" height="9" style="fill:url(#g)"/></svg>',
};

// Counted although this engine fetches nothing: Chromium does fetch them,
// and the count cannot tell the engines apart.
const OVER_COUNTED = { chromium: [], webkit: ['baseFragment', 'baseDataSheet'] };

test('the banner offers every picture the engine would fetch, and nothing else', async ({ page, browserName }) => {
  const fetched = [];
  await page.route(`https://${TRACKER}/**`, (route) => {
    fetched.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 200, contentType: 'image/gif', body: GIF });
  });
  await page.goto('/#/inbox');
  const messages = Object.fromEntries(Object.entries(ONE_PICTURE)
    .map(([label, make]) => [label, make((name) => leak(`${label}/${name}`))]));
  const blocked = await prepared(page, messages);
  const shown = await prepared(page, messages, { allowRemote: true });

  // Every message in its own frame, all at once, then one settle.
  await page.evaluate((all) => Promise.all(all.map((srcdoc) => new Promise((done) => {
    const frame = document.createElement('iframe');
    frame.sandbox = 'allow-same-origin';
    frame.onload = done;
    frame.srcdoc = srcdoc;
    document.body.append(frame);
  }))), Object.values(shown).map((out) => out.srcdoc));
  await page.waitForTimeout(SETTLE_MS);

  const disagreements = [];
  for (const label of Object.keys(ONE_PICTURE)) {
    const loads = fetched.some((path) => path.startsWith(`/${label}/`));
    const counted = blocked[label].count > 0;
    if (loads && !counted) disagreements.push(`${label}: fetched, but no banner offers it`);
    if (counted && !loads && !OVER_COUNTED[browserName].includes(label)) {
      disagreements.push(`${label}: a banner for nothing`);
    }
  }
  expect(disagreements).toEqual([]);
});

test('no hostile markup freezes the reader', async ({ page }) => {
  // Every shape that froze an earlier version, at 200 KB and at 2 MB. The
  // too-heavy ones are refused up front; the rest are read in one pass.
  await page.goto('/#/inbox');
  const times = await page.evaluate(async () => {
    const { prepareMessage } = await import('/static/image-blocker.js');
    const fill = (unit, size) => unit.repeat(Math.floor(size / unit.length));
    const shapes = {
      'url(// in <style>': (n) => `<style>${fill('url(//', n)}</style>`,
      'url(// in style=': (n) => `<div style="${fill('url(//', n)}">d</div>`,
      'url( then spaces, in <style>': (n) => `<style>.a{background:url(${' '.repeat(n)}x}</style>`,
      'url( then newlines, in <style>': (n) => `<style>.a{background:url(${'\n'.repeat(n)}x}</style>`,
      'url( then spaces, in style=': (n) => `<div style="background:url(${' '.repeat(n)}x">d</div>`,
      'commas inside a srcset URL': (n) => `<img srcset="a${','.repeat(n)}b 1x">`,
      'commas inside a <source> srcset URL': (n) => `<picture><source srcset="a${','.repeat(n)}b 1x"></picture>`,
      'a data: stylesheet of url(a)': (n) => `<link rel="stylesheet" href="data:text/css,${fill('url(a)', n)}">`,
      'a data: @import of url(a)': (n) => `<style>@import "data:text/css,${fill('url(a)', n)}";</style>`,
      'a long <base> and <style> refs': (n) => `<base href="http://example.invalid/${'a'.repeat(n / 2)}">`
        + `<style>${fill('url(x)', n / 2)}</style>`,
      'a long <base> and style= refs': (n) => `<base href="http://example.invalid/${'a'.repeat(n / 2)}">`
        + `<div style="${fill('url(x)', n / 2)}">d</div>`,
      'a long <base> and images': (n) => `<base href="http://example.invalid/${'a'.repeat(n / 2)}">`
        + fill('<img src=x>', n / 2),
      'nested tables': (n) => fill('<table><tr><td>', n),
      'nested blocks': (n) => fill('<div>', n),
      'many @import': (n) => `<style>${fill('@import "x.css";', n)}</style>`,
      'many <base>': (n) => fill('<base href="https://x.example/">', n),
    };
    const out = {};
    for (const [label, make] of Object.entries(shapes)) {
      for (const size of [200_000, 2_000_000]) {
        const html = `<p id="leak-marker">m</p>${make(size)}`;
        const started = performance.now();
        prepareMessage(html);
        out[`${label}, ${size / 1000} KB`] = performance.now() - started;
      }
    }
    return out;
  });

  // At most 48 ms at 200 KB and 515 ms at 2 MB on a dev machine; an earlier
  // version took 1 to 18 s at 200 KB, and over 20 s at 2 MB.
  for (const [label, ms] of Object.entries(times)) {
    expect(ms, label).toBeLessThan(label.endsWith('2000 KB') ? 5000 : 500);
  }
});

// The same shapes at 200 KB, the most HTML the fetcher keeps of a message
// with no inline picture, opened in the reading pane itself.
const fill = (unit, size) => unit.repeat(Math.floor(size / unit.length));
const FROZE = {
  'url(// in <style>': `<style>${fill('url(//', 200_000)}</style>`,
  'url(// in style=': `<div style="${fill('url(//', 200_000)}">d</div>`,
  'url( then spaces, in <style>': `<style>.a{background:url(${' '.repeat(200_000)}x}</style>`,
  'url( then spaces, in style=': `<div style="background:url(${' '.repeat(200_000)}x">d</div>`,
  'commas inside a srcset URL': `<img srcset="a${','.repeat(200_000)}b 1x">`,
  'a data: stylesheet of url(a)': `<link rel="stylesheet" href="data:text/css,${fill('url(a)', 200_000)}">`,
  'a data: @import of url(a)': `<style>@import "data:text/css,${fill('url(a)', 200_000)}";</style>`,
  'a long <base> and <style> refs': `<base href="http://example.invalid/${'a'.repeat(100_000)}">`
    + `<style>${fill('url(x)', 100_000)}</style>`,
  'a long <base> and images': `<base href="http://example.invalid/${'a'.repeat(100_000)}">`
    + fill('<img src=x>', 100_000),
  'nested tables': fill('<table><tr><td>', 200_000),
  'nested blocks': fill('<div>', 200_000),
  'many @import': `<style>${fill('@import "x.css";', 200_000)}</style>`,
  'many <base>': fill('<base href="https://x.example/">', 200_000),
};

test('the reading pane opens every shape that froze it without stalling', async ({ page }) => {
  // Thirteen messages, 14 to 17 s in all on a dev machine.
  test.setTimeout(120_000);
  // From the click to the frame loaded (or the text shown), then through
  // the frame's fitting to its content, with the main thread sampled all
  // along: what the user waits for, not just the blocker's share.
  let html = '';
  await hostileMailbox(page, () => html);
  await page.goto('/#/inbox');
  const cards = page.locator('#email-list .mb-card');
  await expect(cards).toHaveCount(18);
  const stalls = await stallSampler(page);

  const slow = [];
  let nth = 0;
  for (const [label, body] of Object.entries(FROZE)) {
    html = `<p id="leak-marker">m</p>${body}`;
    nth = 1 - nth;
    const id = await cards.nth(nth).getAttribute('data-id');
    await stalls.reset();
    const started = Date.now();
    await cards.nth(nth).click();
    await expect.poll(() => page.evaluate((intId) => {
      const block = document.querySelector(`#read-pane .mb-body-block[data-int-id="${intId}"]`);
      if (!block) return false;
      if (block.querySelector('.mb-body-notice')) return true;
      const doc = block.querySelector('.mb-body-iframe')?.contentDocument;
      return !!doc && doc.readyState === 'complete' && !!doc.getElementById('leak-marker');
    }, id), { timeout: 10_000 }).toBe(true);
    const opened = Date.now() - started;
    // The frame is fitted again 120 and 400 ms after it loads.
    await page.waitForTimeout(600);
    const stall = await stalls.worst();
    if (opened > 5000 || stall > 2000) slow.push(`${label}: opened in ${opened} ms, stalled ${Math.round(stall)} ms`);
  }
  expect(slow).toEqual([]);
});

