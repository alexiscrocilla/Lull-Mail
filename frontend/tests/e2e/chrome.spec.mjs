// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

/*
 * What the inbox offers at rest, with one account, no custom folder and no
 * personal label. These numbers are the claim this work makes, so they are
 * asserted rather than described. They will move again — when they do, move
 * them here on purpose.
 */

test.beforeEach(async ({ page }) => {
  // One server serves every spec file and the mailbox is mutable state, so
  // start from the seeded mailbox rather than from whatever the previous
  // file left behind.
  await page.request.post('/__test__/reset');
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  await expect(page.locator('#queue-ind')).toBeVisible();
});

test('the rail carries eight entries', async ({ page }) => {
  const rail = await page.$$eval('#rail a, #rail button', (n) =>
    n.filter((e) => e.offsetParent !== null).map((e) => e.id || e.getAttribute('href')));
  expect(rail).toHaveLength(8);
  // The keyboard-shortcuts button is gone; "?" and the palette are the doors.
  expect(rail).not.toContain('cheat-toggle');
});

test('the list header is seven controls', async ({ page }) => {
  const header = await page.$$eval('.mb-search button, .mb-search input, .mb-search summary',
    (n) => n
      .filter((e) => e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden')
      .map((e) => e.id || e.className.trim()));
  // The search field and its help summary, the three quick chips, select-all
  // and the sort button. The "reset filters" chip is not among them: it is
  // visibility:hidden until a filter is actually on.
  expect(header).toHaveLength(7);
  expect(await page.locator('#thread-toggle').count()).toBe(0);
});

test('the sidebar drops what a single-account first run cannot use', async ({ page }) => {
  // Sent is empty until this app sends something: the fetcher only ever
  // selects INBOX.
  await expect(page.locator('[data-folder="sent"]')).toHaveCount(0);
  // One account is not a choice between accounts.
  await expect(page.locator('#mb-accounts-list')).toHaveCount(0);
  // Favoris stays: with the card star gone it is the only one-click answer
  // to "which mail is shielded from Nettoyage".
  await expect(page.locator('[data-folder="favourite"]')).toHaveCount(1);
});

test('two sort modes, newest first', async ({ page }) => {
  await page.locator('#sort-select-btn').click();
  const options = await page.$$eval('#sort-select-drop .acc-select-opt', (n) => n.map((e) => e.dataset.sort));
  expect(options).toEqual(['date-desc', 'score']);
});

test('the retired features leave nothing behind in storage', async ({ page }) => {
  const leftovers = await page.evaluate(() =>
    ['mb-tabs', 'sb-section-order-v1', 'mb-thread-view'].filter((k) => localStorage.getItem(k) !== null));
  expect(leftovers).toEqual([]);
});

test('a user who had switched conversation view on is not left stuck in it', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('mb-thread-view', '1');
    localStorage.removeItem('mb-retired-v1');
  });
  await page.reload();
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  expect(await page.evaluate(() => localStorage.getItem('mb-thread-view'))).toBeNull();
});
