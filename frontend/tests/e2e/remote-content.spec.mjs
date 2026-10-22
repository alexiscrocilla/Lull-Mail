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
// prefetch, a refresh, or anything a nested frame asks for.
const SHOWN = [
  'audio-src.mp3', 'body-background.gif', 'img-backslashes.gif', 'img-no-slashes.gif',
  'img-srcset-only.gif', 'img-tab-in-scheme.gif', 'inline-image-set.gif', 'input-image.gif',
  'link-preload.gif', 'link-stylesheet.css', 'relative-to-base.gif', 'style-cursor.png',
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
 * Serve `html` as the body of every message the page opens, with the
 * sender trusted or not, and record what the message asks for: every
 * request to another host, and every request a frame other than the app's
 * own makes, the app server included.
 *
 * Recorded in a route handler, not on the page's `request` event: Chromium
 * announces a request before its policy check, so a fetch the frame's CSP
 * refuses still fires `request`. A route only sees what reached the
 * network.
 */
async function hostileMailbox(page, html, { trusted = false } = {}) {
  const fetched = [];
  // The hermetic server cannot reach IMAP, so each message the pane opens
  // schedules a hydration that fails and announces a body event, and the
  // pane rebuilds the frame about every two seconds, back in blocked mode.
  // Without the event stream the frame under test stays the one the test
  // put in front of it.
  await page.route('**/api/events**', (route) => route.abort());
  await page.route(/\/api\/emails\/\d+$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const em = await response.json();
    await route.fulfill({
      response,
      json: { ...em, body_html: html, body_text: '', sender_images_trusted: trusted },
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

test('the assistant side reader fetches nothing remote', async ({ page }) => {
  const fetched = await hostileMailbox(page, HOSTILE);
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
 * what the engine would fetch, so two rows depend on it: Chromium on
 * Windows reads `\\host` as a UNC path it will not load, and only WebKit
 * reads a slashless `http:host` base as absolute against an http page.
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
    'a slashless http: base': ['<base href="http:x.example/hn/"><img src="a.jpg">', chromium ? 0 : 1],
    'a data: stylesheet with a remote URL inside': [
      '<link rel="stylesheet" href="data:text/css,.h%7Bbackground%3Aurl(https%3A%2F%2Fx.example%2Fd.gif)%7D">', 1],
    'a data: @import with a remote URL inside':
      ['<style>@import url("data:text/css,.h%7Bbackground:url(https://x.example/e.gif)%7D");</style>', 1],
    'a srcdoc frame and resource hints, which are dropped': [`<iframe srcdoc="&lt;p&gt;x"></iframe>
      <link rel="prefetch" href="https://x.example/p"><link rel="dns-prefetch" href="//x.example">
      <link rel="preload" as="fetch" href="https://x.example/f">`, 0],
  };
}

test('the banner counts what the policy refuses', async ({ page, browserName }) => {
  await page.goto('/#/inbox');
  const cases = countCases(browserName);
  const got = await page.evaluate(async (all) => {
    const { rewriteRemoteImages } = await import('/static/image-blocker.js');
    return Object.fromEntries(Object.entries(all).map(([label, [html]]) => [
      label, rewriteRemoteImages(html.replace('{APP}', location.origin)).blockedCount,
    ]));
  }, cases);

  expect(got).toEqual(Object.fromEntries(Object.entries(cases)
    .map(([label, [, count]]) => [label, count])));
});

test('a reference into the document survives a remote <base>', async ({ page }) => {
  await page.goto('/#/inbox');
  const html = await page.evaluate(async (base) => {
    const { rewriteRemoteImages } = await import('/static/image-blocker.js');
    return rewriteRemoteImages(`${base}<svg><rect style="fill:url(#g)"/></svg>`).html;
  }, BASE);

  expect(html).toContain('style="fill:url(#g)"');
  expect(html).not.toContain('data-blocked-style');
});

test('srcdoc frames and resource hints are dropped in both modes', async ({ page }) => {
  await page.goto('/#/inbox');
  const left = await page.evaluate(async () => {
    const m = await import('/static/image-blocker.js');
    const html = '<p>x</p><iframe srcdoc="&lt;img src=x&gt;"></iframe>'
      + '<link rel="prefetch" href="https://x.example/p">'
      + '<link rel="PreConnect" href="https://x.example">'
      + '<link rel="preload" as="fetch" href="https://x.example/f">';
    return [m.rewriteRemoteImages(html).html, m.dropOutsidePolicy(html)].map((out) => {
      const doc = new DOMParser().parseFromString(out, 'text/html');
      return {
        text: doc.body.textContent,
        srcdocFrames: doc.querySelectorAll('iframe[srcdoc]').length,
        links: doc.querySelectorAll('link').length,
      };
    });
  });

  for (const out of left) expect(out).toEqual({ text: 'x', srcdocFrames: 0, links: 0 });
});

test('no hostile markup freezes the rewriter', async ({ page }) => {
  // The same budget on both engines: WebKit took the longest on every
  // quadratic shape found so far (over 90 s at 2 MB).
  await page.goto('/#/inbox');
  const times = await page.evaluate(async () => {
    const m = await import('/static/image-blocker.js');
    const spaces = ' '.repeat(200000);
    const blocked = {
      'url( then spaces, in <style>': `<style>.a{background:url(${spaces}x}</style>`,
      'url( then newlines, in <style>': `<style>.a{background:url(${'\n'.repeat(200000)}x}</style>`,
      'url( then spaces, in a style attribute': `<div style="background:url(${spaces}x">d</div>`,
      'url(// over and over': `<style>${'url(//'.repeat(33000)}</style>`,
      'commas inside a srcset URL': `<img srcset="a${','.repeat(200000)}b 1x">`,
      'commas inside a <source> srcset URL': `<picture><source srcset="a${','.repeat(200000)}b 1x"></picture>`,
    };
    const out = {};
    for (const [label, html] of Object.entries(blocked)) {
      const started = performance.now();
      m.rewriteRemoteImages(html);
      out[label] = performance.now() - started;
    }
    const started = performance.now();
    m.dropOutsidePolicy('<link rel="'.repeat(40000));
    out['unclosed <link rel=", loaded mode'] = performance.now() - started;
    return out;
  });

  for (const [label, ms] of Object.entries(times)) expect(ms, label).toBeLessThan(500);
});
