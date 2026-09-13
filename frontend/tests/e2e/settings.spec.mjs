// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

/*
 * Five cards became three, with Synchronisation and Stockage behind one
 * disclosure. The layout is the risky part: .dash-grid clips its overflow,
 * so the disclosure has to be a flex sibling with min-height:0 — flex-shrink
 * would squeeze the accounts row, which owns the only flexible track, to
 * zero and then overflow the page with no scrollbar to get it back. Hence
 * both viewports.
 */

test.beforeEach(async ({ page }) => {
  await page.request.post('/__test__/reset');
  await page.route('**/api/brand-logo/**', (route) => route.abort());
});

for (const vp of [{ width: 900, height: 600 }, { width: 1400, height: 900 }]) {
  test(`settings fits at ${vp.width}x${vp.height}`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto('/#/settings');
    await expect(page.locator('#accounts-list .set-acc-row')).toHaveCount(1);

    // Three cards above the fold, and the disclosure closed. Visible, not
    // merely present: the grid clips its overflow, so a card squeezed to
    // zero height disappears with no scrollbar to bring it back -- which is
    // exactly what happened to the accounts card at 900x600.
    const cards = await page.$$eval('.dash-grid--fill > section.card', (n) =>
      n.filter((e) => e.getBoundingClientRect().height > 40).length);
    expect(cards).toBe(3);
    await expect(page.locator('#accounts-list .set-acc-row').first()).toBeInViewport();
    const fold = page.locator('details.set-advanced-page');
    await expect(fold).not.toHaveAttribute('open', '');

    // Open it and reach the last control inside. This is the assertion the
    // layout can actually fail.
    await fold.locator('> summary').click();
    const wipe = page.locator('#btn-wipe-data');
    await wipe.scrollIntoViewIfNeeded();
    await expect(wipe).toBeVisible();

    // Nothing escapes the page horizontally.
    const overflow = await page.evaluate(() => {
      const d = document.querySelector('.dash');
      return d.scrollWidth - d.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

test('the storage actions are plain content, not a second view', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/settings');
  await page.locator('details.set-advanced-page > summary').click();
  await expect(page.locator('#btn-storage-actions')).toHaveCount(0);
  await expect(page.locator('#view-storage-actions')).toHaveCount(0);
  for (const id of ['#btn-open-data', '#btn-export-config', '#btn-import-config', '#btn-wipe-ai', '#btn-wipe-data']) {
    await expect(page.locator(id)).toBeVisible();
  }
});

test('the disclosure does not remember being open', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/settings');
  await page.locator('details.set-advanced-page > summary').click();
  await expect(page.locator('details.set-advanced-page')).toHaveAttribute('open', '');
  await page.goto('/#/inbox');
  await page.goto('/#/settings');
  await expect(page.locator('details.set-advanced-page')).not.toHaveAttribute('open', '');
});

test('with no model, the inert scan control is hidden and notifications say why they are silent', async ({ page }) => {
  await page.route('**/api/setup/status', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    return route.fulfill({ json: { ...body, ai_enabled: false } });
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/settings');
  await expect(page.locator('#ntfy-noai')).toBeVisible();
  await page.locator('details.set-advanced-page > summary').click();
  await expect(page.locator('#field-injection')).toBeHidden();
});

test('turning notifications off does not wipe the topic from the field', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/settings');
  await page.locator('#btn-ntfy-random').click();
  const topic = await page.locator('#ntfy-topic').inputValue();
  expect(topic).toMatch(/^lullmail-/);
  await page.locator('#btn-save-ntfy').click();
  await expect(page.locator('#ntfy-topic')).toHaveValue(topic);

  // Switch off, save, and the field must still show what to switch back on.
  // The radio itself is visually hidden inside its segment label.
  await page.locator('label:has(#ntfy-seg-off)').click();
  await page.locator('#btn-save-ntfy').click();
  await expect(page.locator('#ntfy-topic')).toHaveValue(topic);
});
