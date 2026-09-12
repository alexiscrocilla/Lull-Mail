// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

const viewports = [
  { width: 900, height: 700 },
  { width: 1024, height: 768 },
  { width: 1400, height: 900 },
];

for (const viewport of viewports) {
  for (const theme of ['light', 'dark']) {
    test(`mailbox ${viewport.width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
      await page.goto('/#/inbox');
      await expect(page.locator('#email-list .mb-card').first()).toBeVisible();
      await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
      await expect(page).toHaveScreenshot(`mailbox-${viewport.width}-${theme}.png`, {
        animations: 'disabled',
        fullPage: true,
      });
    });
  }
}

test('keyboard opens the focused message and returns to the list', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto('/#/inbox');
  const first = page.locator('#email-list .mb-card').first();
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#read-pane .mb-subject')).toBeVisible();
  await page.locator('#btn-close-read').click();
  await expect(first).toBeVisible();
});
