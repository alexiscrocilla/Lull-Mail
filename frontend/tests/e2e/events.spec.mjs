// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

/*
 * One connection, for the lifetime of the window.
 *
 * A subscription owned by a view mount leaks one connection per navigation,
 * and Chromium allows six per origin — so at six leaks every other request
 * from the page queues client-side and never issues, while the server sits
 * idle and healthy. That is the failure this file exists to prevent, and it
 * is invisible without a test.
 */

test.beforeEach(async ({ page }) => {
  await page.request.post('/__test__/reset');
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  await page.setViewportSize({ width: 1400, height: 900 });
});

test('the window opens exactly one stream and keeps it', async ({ page }) => {
  const opened = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/events') opened.push(r.url());
  });

  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  expect(opened).toHaveLength(1);

  // Navigating between views must not open another one.
  await page.goto('/#/cleanup');
  await page.waitForTimeout(500);
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  await page.locator('[data-folder="favourite"]').click();
  await page.locator('[data-folder="inbox"]').click();
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);

  expect(opened, `opened ${opened.length} streams: ${opened.join(', ')}`).toHaveLength(1);
});

test('nothing polls the status on a loop any more', async ({ page }) => {
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  // The line is the one surface fed purely by status frames.
  await expect(page.locator('#mb-sync-line')).toContainText('Aucune relève');

  // Count only what happens once the window has settled. The rail used to
  // ask every three seconds for the lifetime of the app; ten idle seconds
  // would have cost three or four requests.
  const polls = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/sync/status') polls.push(r.url());
  });
  await page.waitForTimeout(10_000);

  expect(polls, `the status was polled ${polls.length} times in 10 idle seconds`).toHaveLength(0);
});

test('a server without the route falls back to the poll rather than going silent', async ({ page }) => {
  await page.route('**/api/events', (route) => route.fulfill({ status: 404 }));
  const polls = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/sync/status') polls.push(r.url());
  });

  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  await expect(page.locator('#mb-sync-line')).toContainText('Aucune relève');
  expect(polls.length, 'the fallback never started').toBeGreaterThan(0);
});

test('new mail appears while you are looking at the list', async ({ page }) => {
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);

  const polls = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/sync/status') polls.push(r.url());
  });

  const started = Date.now();
  await page.request.post('/__test__/emit?kind=mail');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(19);
  const elapsed = Date.now() - started;

  // Measured before this work: a median of 14.2 s and a worst case of 57 s,
  // because the only arrival signal was a 3 s sample of a boolean that is
  // true just while a pass runs.
  expect(elapsed, `the row took ${elapsed} ms to appear`).toBeLessThan(4000);
  expect(polls, 'the row arrived via a poll, not the stream').toHaveLength(0);
  await expect(page.locator('#email-list .mb-card').first())
    .toContainText('Message arrivé pendant le test');
});

test('an idle window costs nothing at all', async ({ page }) => {
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  // The update check fires once on load; let it.
  await page.waitForTimeout(1500);

  const calls = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (p.startsWith('/api/') && p !== '/api/events') calls.push(p);
  });
  await page.waitForTimeout(20_000);

  // Before: 23 requests a minute, forever, and a 21 MB list reload every 60 s.
  expect(calls, `20 idle seconds cost ${calls.length} requests: ${calls.join(', ')}`)
    .toHaveLength(0);
});

test('a message still downloading fills itself in when the body lands', async ({ page }) => {
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);

  // Put the first message back to envelope, then open it.
  const id = await page.$eval('#email-list .mb-card', (el) => Number(el.dataset.id));
  await page.request.post(`/__test__/emit?kind=envelope&int_id=${id}`);
  await page.locator('#email-list .mb-card').first().click();
  await expect(page.locator('#read-pane .mb-body-loading')).toBeVisible();

  // Well past the 1200 ms single retry this replaced, which against a real
  // provider lost the race essentially always and re-armed nothing.
  await page.waitForTimeout(3000);
  await expect(page.locator('#read-pane .mb-body-loading')).toBeVisible();

  await page.request.post(`/__test__/emit?kind=body&int_id=${id}`);
  await expect(page.locator('#read-pane .mb-body-loading')).toHaveCount(0);
  await expect(page.locator('#read-pane')).toContainText('Corps arrivé par le flux');
});
