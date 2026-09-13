// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

const viewports = [
  { width: 900, height: 700 },
  { width: 1024, height: 768 },
  { width: 1400, height: 900 },
];

// Every avatar asks the backend for the sender domain's favicon, and the
// backend fetches it from that domain for real and caches it on disk. Which
// of the seeded domains answered, and whether the cache was warm, changed
// from run to run — a thousand differing pixels per screenshot, and outbound
// requests from a test suite that has no business making any. Refusing the
// route makes every avatar fall back to its initials bubble, which is what
// the snapshots pin.
test.beforeEach(async ({ page }) => {
  // One server serves every spec file and the mailbox is mutable state, so
  // start from the seeded mailbox rather than from whatever the previous
  // file left behind.
  await page.request.post('/__test__/reset');
  await page.route('**/api/brand-logo/**', (route) => route.abort());
});

/*
 * The inbox paints in three waves: the cards, then the unread badges once
 * the per-account stats land, then the rail's AI queue button, which ships
 * `hidden` in the markup and is revealed only after the AI config call
 * answers. Screenshotting between two waves produced an 81-pixel diff on
 * roughly one run in three, and focusing a card before the list settled let
 * the repaint eat the focus so Enter opened nothing. Wait for the last wave.
 */
async function settled(page) {
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  await expect(page.locator('#badge-inbox')).toHaveText('6');
  await expect(page.locator('#queue-ind')).toBeVisible();
}

for (const viewport of viewports) {
  for (const theme of ['light', 'dark']) {
    test(`mailbox ${viewport.width}px ${theme}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme);
      await page.goto('/#/inbox');
      await settled(page);
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
  await settled(page);
  const first = page.locator('#email-list .mb-card').first();
  await first.focus();
  await page.keyboard.press('Enter');
  // `.mb-subject` is the card's class; the read pane titles with
  // `.mb-read-subject`, so this assertion could never pass.
  await expect(page.locator('#read-pane .mb-read-subject')).toBeVisible();
  await page.locator('#btn-close-read').click();
  await expect(first).toBeVisible();
});
