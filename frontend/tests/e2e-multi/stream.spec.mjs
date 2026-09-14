// SPDX-License-Identifier: GPL-3.0-or-later
//
// What the event stream does when the mail it announces belongs to a
// mailbox the user is not currently looking at.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.request.post('/__test__/reset');
  await page.route('**/api/brand-logo/**', (route) => route.abort());
});

const TOTAL = 30;
// See rows.spec.mjs: the first paint after the server boots is the slow one,
// and the gate below means "the app has finished loading", not "it loaded
// inside the default timeout".
const BOOT_MS = 30_000;

function bootedInbox(page) {
  return Promise.all([
    expect(page.locator('#email-list .mb-card')).toHaveCount(TOTAL, { timeout: BOOT_MS }),
    expect(page.locator('#queue-ind')).toBeVisible({ timeout: BOOT_MS }),
  ]);
}

test('mail for a filtered-out mailbox moves its badge without rebuilding the list', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/inbox');
  await bootedInbox(page);

  // Scope the list to one mailbox.
  await page.locator('[data-acc="demo@lullmail.test"]').click();
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);

  const proBadge = page.locator('[data-acc="pro@lullmail.test"] .mb-acc-badge');
  await expect(proBadge).toHaveText('3');

  // Count what the arrival costs. A list rebuild here is not a cosmetic
  // waste: it closes an open popover and can evict checked rows, for a
  // message the filter would hide anyway.
  let listRequests = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/emails?')) listRequests += 1;
  });

  await page.request.post('/__test__/emit?kind=mail&account=pro@lullmail.test');

  // The badge on that mailbox is exactly how the user is meant to find out.
  await expect(proBadge).toHaveText('4');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  expect(listRequests).toBe(0);
});

test('mail for the mailbox in view lands in the list', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/inbox');
  await bootedInbox(page);

  await page.locator('[data-acc="pro@lullmail.test"]').click();
  await expect(page.locator('#email-list .mb-card')).toHaveCount(6);

  await page.request.post('/__test__/emit?kind=mail&account=pro@lullmail.test');

  await expect(page.locator('#email-list .mb-card')).toHaveCount(7);
  await expect(page.locator('#email-list .mb-card').first())
    .toContainText('Message arrivé pendant le test');
});

test('a refresh refused mid-selection is drained when the selection clears', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/inbox');
  await bootedInbox(page);

  // A live multi-selection blocks a background rebuild: it would evict the
  // checked rows from the visible window.
  await page.locator('#email-list .mb-card').first().locator('.mb-avatar').click();
  await expect(page.locator('#email-list .mb-card.checked')).toHaveCount(1);

  await page.request.post('/__test__/emit?kind=mail&account=demo@lullmail.test');
  // Past the 1 s coalescing window, so the reload has been attempted and
  // refused -- not merely still pending. With no clock left in the app,
  // nothing was going to retry it.
  await page.waitForTimeout(1600);
  await expect(page.locator('#email-list .mb-card')).toHaveCount(TOTAL);

  await page.keyboard.press('Escape');
  await expect(page.locator('#email-list .mb-card.checked')).toHaveCount(0);
  await expect(page.locator('#email-list .mb-card')).toHaveCount(TOTAL + 1);
});
