// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

/*
 * What this replaced, in two steps. First a permanent row of three controls
 * that filtered nothing: two spliced a literal operator into the search box
 * and the third appended an after: date. Then a "?" circle opening an
 * 800-pixel reference card listing eleven operators as samples to read and
 * retype -- documentation standing in for an interface.
 *
 * Now the operators are controls you click, and every filter that is on says
 * so in the chip row and can be taken off from there on its own.
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

const panel = (page) => page.locator('#mb-refine-form');
const chips = (page) => page.locator('#filter-chips .mb-chip-filter');

test('the reference card is gone and the placeholder is one word', async ({ page }) => {
  await expect(page.locator('#search-filters')).toHaveCount(0);
  await expect(page.locator('.mb-search-help')).toHaveCount(0);
  await expect(page.locator('.mb-search-help-panel')).toHaveCount(0);
  await expect(page.locator('#search')).toHaveAttribute('placeholder', 'Rechercher');
});

test('the filter panel is closed at rest and opens from the keyboard', async ({ page }) => {
  await expect(panel(page)).toBeHidden();

  // One Tab from the search field, which is where "/" puts the caret.
  await page.locator('#search').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('#mb-refine')).toHaveAttribute('open', '');

  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeHidden();
});

test('a control writes its operator into the field and narrows the list', async ({ page }) => {
  await page.locator('.mb-refine-toggle').click();
  await panel(page).locator('[data-op="from"]').fill('nora@rivage-studio.fr');

  // The field is the single source of truth: the control writes into it,
  // and it is what runs the search.
  await expect(page.locator('#search')).toHaveValue('from:nora@rivage-studio.fr');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(3);
});

test('a checkbox writes and unwrites its operator', async ({ page }) => {
  await page.locator('.mb-refine-toggle').click();
  const box = panel(page).locator('[data-op="has"][data-value="attachment"]');

  await box.check();
  await expect(page.locator('#search')).toHaveValue('has:attachment');
  await box.uncheck();
  await expect(page.locator('#search')).toHaveValue('');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
});

test('an active filter is a chip, and the chip removes only itself', async ({ page }) => {
  await page.locator('#search').fill('from:nora@rivage-studio.fr subject:Compte');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(3);
  await expect(chips(page)).toHaveCount(2);

  // Before this, one filter you no longer wanted meant clearing all of them.
  await chips(page).filter({ hasText: 'Objet' }).click();
  await expect(page.locator('#search')).toHaveValue('from:nora@rivage-studio.fr');
  await expect(chips(page)).toHaveCount(1);
  await expect(page.locator('#email-list .mb-card')).toHaveCount(3);
});

test('what has no control is still typeable, still chipped, and never destroyed', async ({ page }) => {
  // min_score and to: have no control on purpose. Using a control must not
  // throw them away.
  await page.locator('#search').fill('min_score:7 to:demo@lullmail.test facture');
  await expect(chips(page)).toHaveCount(2);

  await page.locator('.mb-refine-toggle').click();
  await panel(page).locator('[data-op="subject"]').fill('devis');

  await expect(page.locator('#search'))
    .toHaveValue('min_score:7 to:demo@lullmail.test facture subject:devis');
  await expect(chips(page)).toHaveCount(3);
});

test('the panel reflects what was typed in the field', async ({ page }) => {
  await page.locator('#search').fill('from:louis@maison-bernard.fr has:attachment');
  await page.locator('.mb-refine-toggle').click();

  await expect(panel(page).locator('[data-op="from"]'))
    .toHaveValue('louis@maison-bernard.fr');
  await expect(panel(page).locator('[data-op="has"][data-value="attachment"]'))
    .toBeChecked();
  await expect(page.locator('#mb-refine-badge')).toHaveText('2');
});

test('Escape closes the panel without dropping the selection', async ({ page }) => {
  // The mailbox's own Escape handler clears a multi-selection, and it does
  // not exempt the panel's toggle. Without stopPropagation, closing the
  // panel silently threw away the user's checked rows.
  await page.locator('#email-list .mb-card').first().locator('.mb-avatar').click();
  await expect(page.locator('#email-list .mb-card.checked')).toHaveCount(1);

  await page.locator('.mb-refine-toggle').click();
  await expect(panel(page)).toBeVisible();
  await page.locator('.mb-refine-toggle').press('Escape');

  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#email-list .mb-card.checked')).toHaveCount(1);
});

test('a typed operator still narrows the list', async ({ page }) => {
  await page.locator('#search').fill('from:nora@rivage-studio.fr');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(3);
});

test('the panel fits the narrowest window without pushing the page sideways', async ({ page }) => {
  // The panel spans the header rather than sitting in a 360px column, so
  // the one thing to pin is that it never widens the document.
  await page.setViewportSize({ width: 900, height: 600 });
  await page.locator('.mb-refine-toggle').click();
  await expect(panel(page)).toBeVisible();

  const geometry = await page.evaluate(() => {
    const f = document.querySelector('#mb-refine-form');
    const r = f.getBoundingClientRect();
    return { right: r.right, bottom: r.bottom, scrollW: document.documentElement.scrollWidth,
             innerW: window.innerWidth, innerH: window.innerHeight };
  });
  expect(geometry.scrollW).toBeLessThanOrEqual(geometry.innerW);
  expect(geometry.right).toBeLessThanOrEqual(geometry.innerW);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.innerH);
});

test('a search with no results names the filters and removes them one by one', async ({ page }) => {
  await page.locator('#search').fill('from:nora@rivage-studio.fr subject:zzz-introuvable');
  const empty = page.locator('.mb-list-empty');
  await expect(empty).toBeVisible();

  // Not « from:nora@… subject:zzz-introuvable » quoted back at the user.
  await expect(empty).not.toContainText('from:');
  await expect(empty.locator('.mb-chip-filter')).toHaveCount(2);

  // The one CTA used to be "clear everything", which throws away the
  // filter that was right along with the one that was not.
  await empty.locator('.mb-chip-filter').filter({ hasText: 'Objet' }).click();
  await expect(page.locator('#email-list .mb-card')).toHaveCount(3);
  await expect(page.locator('#search')).toHaveValue('from:nora@rivage-studio.fr');
});

test('a search that could not run says so instead of showing no results', async ({ page }) => {
  await page.route('**/api/emails/search**', (route) => route.abort('failed'));
  await page.locator('#search').fill('category:newsletter');

  const empty = page.locator('.mb-list-empty');
  await expect(empty).toBeVisible();
  // The fallback is a local substring match, so `category:newsletter`
  // becomes a hunt for that literal text -- a different search, and
  // indistinguishable from "nothing matched" unless it says so.
  await expect(empty).toContainText('échoué');
  await expect(empty.locator('[data-empty-act="retry-search"]')).toBeVisible();

  await page.unroute('**/api/emails/search**');
  await empty.locator('[data-empty-act="retry-search"]').click();
  await expect(page.locator('#email-list .mb-card')).toHaveCount(0);
  await expect(page.locator('.mb-list-empty')).not.toContainText('échoué');
});
