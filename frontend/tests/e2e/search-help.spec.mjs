// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

/*
 * The row this replaced held three controls and filtered nothing: two of
 * them spliced a literal operator into the search box and the third appended
 * an after: date. It occupied a permanent band above the list, and the
 * placeholder spent sixty-two characters quoting four of the eleven
 * operators plus a date from the previous year.
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
});

test('the operator row is gone and the placeholder is one word', async ({ page }) => {
  await expect(page.locator('#search-filters')).toHaveCount(0);
  await expect(page.locator('.mb-fbtn')).toHaveCount(0);
  await expect(page.locator('#search-date')).toHaveCount(0);
  await expect(page.locator('#search')).toHaveAttribute('placeholder', 'Rechercher');
});

test('the help fold is closed at rest and opens from the keyboard', async ({ page }) => {
  const fold = page.locator('.mb-search-help');
  const panel = page.locator('.mb-search-help-panel');
  await expect(panel).toBeHidden();

  // One Tab from the search field, which is where "/" puts the caret.
  await page.locator('#search').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  await expect(fold).toHaveAttribute('open', '');

  await page.keyboard.press('Enter');
  await expect(panel).toBeHidden();
});

test('the help documents operators the parser actually accepts', async ({ page }) => {
  await page.locator('.mb-search-help > summary').click();
  const codes = await page.$$eval('.mb-search-help-panel code', (n) => n.map((e) => e.textContent));

  // Every example is a real operator from src/search_query.py.
  const operators = codes.map((c) => c.split(':')[0]);
  const known = ['from', 'to', 'subject', 'in', 'is', 'has', 'category', 'min_score', 'label', 'before', 'after'];
  for (const op of operators) expect(known).toContain(op);

  // The after: example is a working "last 30 days", not a fixed past date.
  const after = codes.find((c) => c.startsWith('after:'));
  const days = Math.round((Date.now() - Date.parse(after.slice(6))) / 86_400_000);
  expect(days).toBeGreaterThanOrEqual(29);
  expect(days).toBeLessThanOrEqual(31);

  // The trash is unreachable by search — a pre-existing backend limit. The
  // help must not advertise it.
  expect(codes).not.toContain('in:deleted');
});

test('a typed operator still narrows the list', async ({ page }) => {
  await page.locator('#search').fill('from:nora@rivage-studio.fr');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(3);
});
