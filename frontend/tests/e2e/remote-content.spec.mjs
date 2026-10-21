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
<object data="${leak('object-data.png')}" type="image/png" width="20" height="20"></object>
<embed src="${leak('embed-src.png')}" type="image/png" width="20" height="20">
</body></html>`;

// The one thing "Charger pour ce mail" is supposed to bring back.
const OPT_IN = `<p id="leak-marker">Bonjour.</p>
<img src="${leak('opt-in-image.gif')}" width="40" height="40" alt="">
<iframe src="${leak('opt-in-nested-iframe.html')}" width="20" height="20"></iframe>
<object data="${leak('opt-in-object.png')}" type="image/png" width="20" height="20"></object>`;

const GIF = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');

// A negative result needs time to be one: fonts, media preload, the SMIL
// <set> and the one-second meta refresh can all fire after the marker
// paints, which is the last thing a locator can wait for. This is that
// margin, not a race.
const SETTLE_MS = 1500;

/**
 * Serve `html` as the body of every message the page opens, and record each
 * request the page makes to a host other than the test server.
 *
 * Recorded in the route handler, not on the page's `request` event: Chromium
 * announces a request before its policy check, so a fetch the frame's CSP
 * refuses still fires `request`. The route only sees what reached the
 * network.
 */
async function hostileMailbox(page, html) {
  const remote = [];
  const isLocal = (url) => new URL(url).hostname === '127.0.0.1';
  await page.context().route((url) => !isLocal(url.href), (route) => {
    remote.push(route.request().url());
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('.css')) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    }
    if (path.endsWith('.html')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>remote</p>' });
    }
    return route.fulfill({ status: 200, contentType: 'image/gif', body: GIF });
  });
  await page.route(/\/api\/emails\/\d+$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const em = await response.json();
    await route.fulfill({
      response,
      json: { ...em, body_html: html, body_text: '', sender_images_trusted: false },
    });
  });
  return remote;
}

test.beforeEach(async ({ page }) => {
  // One server serves every spec file and the mailbox is mutable state, so
  // start from the seeded mailbox rather than from whatever the previous
  // file left behind.
  await page.request.post('/__test__/reset');
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  await page.setViewportSize({ width: 1400, height: 900 });
});

async function openFirstInInbox(page) {
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  await page.locator('#email-list .mb-card').first().click();
  await expect(page.locator('#read-pane .mb-read-subject')).toBeVisible();
}

test('the reading pane fetches nothing remote while images are blocked', async ({ page }) => {
  const remote = await hostileMailbox(page, HOSTILE);
  await openFirstInInbox(page);

  await expect(page.locator('#read-pane .mb-img-banner')).toBeVisible();
  await expect(page.frameLocator('#read-pane .mb-body-iframe').locator('#leak-marker'))
    .toBeVisible();
  await page.waitForTimeout(SETTLE_MS);

  expect(remote).toEqual([]);
});

test('the assistant side reader fetches nothing remote', async ({ page }) => {
  const remote = await hostileMailbox(page, HOSTILE);
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

  expect(remote).toEqual([]);
});

test('"load for this email" brings images back and nothing else', async ({ page }) => {
  const remote = await hostileMailbox(page, OPT_IN);
  await openFirstInInbox(page);
  await expect(page.frameLocator('#read-pane .mb-body-iframe').locator('#leak-marker'))
    .toBeVisible();
  await page.waitForTimeout(SETTLE_MS);
  expect(remote).toEqual([]);

  await page.locator('#read-pane .mb-img-banner [data-act="show-once"]').click();
  await expect(page.locator('#read-pane .mb-img-banner')).toHaveCount(0);
  // Also proves the recorder sees requests made from inside the frame, so
  // the empty lists above are not a blind spot.
  await expect.poll(() => remote).toContain(leak('opt-in-image.gif'));
  await page.waitForTimeout(SETTLE_MS);

  expect(remote).toEqual([leak('opt-in-image.gif')]);
});
