// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

/*
 * The read pane header carried ten buttons plus a two-item overflow menu
 * whose "Ré-analyser" was byte-identical to the visible one next to it, and
 * whose "move" was byte-identical to the trash button outside the trash. Six
 * controls survive, in two groups, with exactly one of them accent-filled.
 */

const EXPECTED = [
  'btn-fav-toggle',
  'btn-close-read',
  'btn-read-toggle',
  'btn-trash',
  'btn-forward',
  'btn-reply-toggle',
];

test.beforeEach(async ({ page }) => {
  await page.route('**/api/brand-logo/**', (route) => route.abort());
});

async function openFirst(page) {
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  await page.locator('#email-list .mb-card').first().click();
  await expect(page.locator('#read-pane .mb-read-subject')).toBeVisible();
}

test('the read pane offers six controls and no overflow menu', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openFirst(page);

  // Scoped to the two action groups. Controls that belong to the content —
  // the tag chip, the AI box's re-analyse, the attachment-scan retry — are
  // not toolbar buttons and are counted by neither group.
  const actions = await page.$$eval(
    '.mb-read-actions button, .mb-thread-actions button',
    (nodes) => nodes.filter((n) => n.offsetParent !== null).map((n) => n.id || n.className),
  );
  expect(actions.sort()).toEqual([...EXPECTED].sort());

  for (const gone of ['#btn-more', '#btn-print', '#btn-tag']) {
    await expect(page.locator(gone)).toHaveCount(0);
  }
});

test('the pane as a whole', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openFirst(page);
  await expect(page.locator('#read-pane')).toHaveScreenshot('read-pane-1400-light.png', {
    animations: 'disabled',
  });
});

test('Répondre is the only filled control, and it says so in words', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openFirst(page);

  const reply = page.locator('#btn-reply-toggle');
  await expect(reply).toContainText('Répondre');
  // Every other action button carries a muted or danger variant.
  const filled = await page.$$eval('#read-pane .read-action-btn', (nodes) =>
    nodes
      .filter((n) => !n.classList.contains('read-action-btn-muted')
                  && !n.classList.contains('read-action-btn-danger'))
      .map((n) => n.id),
  );
  expect(filled).toEqual(['btn-reply-toggle']);
});

test('every control in the pane has an accessible name', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openFirst(page);

  const unnamed = await page.$$eval('#read-pane button', (nodes) => nodes
    .filter((n) => n.offsetParent !== null)
    .filter((n) => !(n.getAttribute('aria-label') || n.textContent.trim()))
    .map((n) => n.id || n.className));
  expect(unnamed).toEqual([]);
});

test('in the trash the same button restores instead of deleting', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);

  // Trash one from the pane, then follow it into the folder.
  await page.locator('#email-list .mb-card').first().click();
  await expect(page.locator('#btn-trash')).toHaveAttribute('aria-label', 'Supprimer');
  await page.locator('#btn-trash').click();
  await expect(page.locator('#email-list .mb-card')).toHaveCount(17);

  await page.locator('[data-folder="deleted"]').click();
  await expect(page.locator('#email-list .mb-card')).toHaveCount(1);
  await page.locator('#email-list .mb-card').first().click();
  await expect(page.locator('#read-pane .mb-read-subject')).toBeVisible();
  // Same id, opposite job — and reachable by keyboard, which the menu item
  // it replaced was not.
  await expect(page.locator('#btn-trash')).toHaveAttribute('aria-label', 'Restaurer dans la boîte');
  await page.locator('#btn-trash').click();
  await expect(page.locator('#email-list .mb-card')).toHaveCount(0);
});
