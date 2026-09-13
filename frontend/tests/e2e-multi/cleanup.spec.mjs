// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Nettoyage page with three mailboxes. Every count it shows and every
// button it offers is destructive or irreversible, so "which mailbox is this
// about" is not a nicety.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.request.post('/__test__/reset');
  await page.route('**/api/brand-logo/**', (route) => route.abort());
});

test('the page names the mailbox it is about, and lets you change it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/cleanup');

  const picker = page.locator('#cln-accounts');
  await expect(picker).toBeVisible();
  await expect(picker.locator('.cln-acc')).toHaveCount(4);   // Tous + 3
  await expect(picker.locator('.cln-acc').first()).toHaveClass(/active/);

  // Picking one re-asks the server rather than filtering what is on screen:
  // the counts, the floors and the ranking are all per scope.
  const scoped = page.waitForRequest((r) =>
    r.url().includes('/api/cleanup/suggestions') && r.url().includes('pro%40lullmail.test'));
  await picker.locator('[data-account="pro@lullmail.test"]').click();
  await scoped;

  await expect(picker.locator('[data-account="pro@lullmail.test"]'))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(picker.locator('.cln-acc').first()).not.toHaveClass(/active/);
});

test('the scope is not remembered across mounts', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/cleanup');

  const picker = page.locator('#cln-accounts');
  await expect(picker).toBeVisible();
  await picker.locator('[data-account="asso@lullmail.test"]').click();
  await expect(picker.locator('[data-account="asso@lullmail.test"]'))
    .toHaveAttribute('aria-pressed', 'true');

  // Leave and come back. A destructive page that silently reopens filtered
  // is a page that deletes the wrong mailbox's mail the one time the user
  // forgets which filter they left on.
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card').first()).toBeVisible();
  await page.goto('/#/cleanup');

  await expect(page.locator('#cln-accounts .cln-acc').first()).toHaveClass(/active/);
});
