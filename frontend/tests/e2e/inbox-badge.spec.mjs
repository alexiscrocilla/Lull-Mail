// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

/*
 * The custom folders load after the message list. Rendering them rebuilt
 * every sidebar badge empty, and with no live stream to repaint them the
 * inbox's unread count stayed hidden until something else redrew the list:
 * an idle window after launch showed no count at all.
 */

test.beforeEach(async ({ page }) => {
  await page.request.post('/__test__/reset');
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  // Nothing but the folder answer may touch the badge here.
  await page.route('**/api/events**', (route) => route.abort());
  await page.route('**/api/sync', (route) => route.fulfill({ json: { ok: false } }));
});

test('the inbox count survives folders that answer after the list', async ({ page }) => {
  let foldersAnswered = false;
  await page.route('**/api/folders', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    await new Promise((done) => setTimeout(done, 600));
    foldersAnswered = true;
    return route.fulfill({ response });
  });
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  await expect(page.locator('#badge-inbox')).toHaveText('6');

  await expect.poll(() => foldersAnswered).toBe(true);
  // A frame for the late render to land, then the count must still be there.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 100))));
  await expect(page.locator('#badge-inbox')).toBeVisible();
  await expect(page.locator('#badge-inbox')).toHaveText('6');
});
