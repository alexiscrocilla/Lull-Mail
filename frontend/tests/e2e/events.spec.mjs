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
