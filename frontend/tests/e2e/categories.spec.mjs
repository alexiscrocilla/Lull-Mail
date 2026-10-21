// SPDX-License-Identifier: GPL-3.0-or-later
//
// The categories used to be a sidebar section styled exactly like the folders
// above it. With "Boîte de réception" and "Toutes" both highlighted, users
// could not tell a place from a filter, and reported that they did not know
// the list filtered their mail at all. They are tabs over the list now, the
// way Apple Mail and Proton Mail show theirs.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.request.post('/__test__/reset');
  await page.request.post('/__test__/cleanup?kind=newsletter&n=5&senders=2');
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(23);
});

const tabs = (page) => page.locator('#mb-cats [role="tab"]');
const tab = (page, cat) => page.locator(`#mb-cats [data-cat="${cat}"]`);

test('the categories are tabs over the list, not sidebar entries', async ({ page }) => {
  await expect(page.locator('#mb-cats')).toHaveAttribute('role', 'tablist');
  await expect(tab(page, '')).toHaveAttribute('aria-selected', 'true');
  // Nothing category-shaped is left among the folders.
  await expect(page.locator('.mb-side [data-cat]')).toHaveCount(0);
  // Exactly one tab is in the Tab order.
  await expect(page.locator('#mb-cats [tabindex="0"]')).toHaveCount(1);
});

test('a tab filters the list and says which one is on', async ({ page }) => {
  await tab(page, 'newsletter').click();
  await expect(tab(page, 'newsletter')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, '')).toHaveAttribute('aria-selected', 'false');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(5);

  // The tab is the indicator, so no filter chip and no "Réinitialiser"
  // repeat it in the row above.
  await expect(page.locator('#filter-chips .mb-chip-filter')).toHaveCount(0);
  await expect(page.locator('#filter-chips .mb-chip-reset')).toHaveCount(0);
});

test('arrow keys move between tabs and select as they go', async ({ page }) => {
  await tab(page, '').focus();
  await page.keyboard.press('ArrowRight');
  const second = tabs(page).nth(1);
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('End');
  await expect(tabs(page).last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tab(page, '')).toBeFocused();
  await expect(page.locator('#email-list .mb-card')).toHaveCount(23);
});

test('an empty tab says so and offers the way back', async ({ page }) => {
  await tab(page, 'transactional').click();
  const cta = page.locator('[data-empty-act="all-categories"]');
  await expect(cta).toBeVisible();
  await cta.click();
  await expect(tab(page, '')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(23);
});

test('the tabs belong to the inbox and filter nothing elsewhere', async ({ page }) => {
  await tab(page, 'newsletter').click();
  await expect(page.locator('#email-list .mb-card')).toHaveCount(5);

  await page.locator('.mb-folder[data-folder="deleted"]').click();
  await expect(page.locator('#mb-cats-wrap')).toBeHidden();

  // Back in the inbox, the tab the user left is still the one on.
  await page.locator('.mb-folder[data-folder="inbox"]').click();
  await expect(page.locator('#mb-cats-wrap')).toBeVisible();
  await expect(tab(page, 'newsletter')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(5);
});

test('a deep link with its own search is not narrowed by an old tab', async ({ page }) => {
  await tab(page, 'newsletter').click();
  await expect(page.locator('#email-list .mb-card')).toHaveCount(5);

  // The cleanup page's "Voir ces messages" link. Intersected with a tab
  // left on from earlier, it landed on an empty list.
  await page.goto(`/#/inbox?q=${encodeURIComponent('from:camille@atelier-martin.fr')}`);
  await expect(tab(page, '')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#email-list .mb-card').first()).toBeVisible();
});

test('the cleanup page can open the trash directly', async ({ page }) => {
  // « Ouvrir la corbeille » linked to #/inbox?folder=deleted, which nothing
  // read: the link landed on the inbox.
  await page.goto('/#/inbox?folder=deleted');
  await expect(page.locator('.mb-folder[data-folder="deleted"]')).toHaveClass(/active/);
  await expect(page.locator('#mb-cats-wrap')).toBeHidden();
});

test('deleting a label asks in the app, not in a system box', async ({ page }) => {
  // window.confirm opened a box titled with the local server's address.
  const made = await (await page.request.post('/api/labels', {
    data: { name: 'Voyage', color: '#93C5FD' },
    headers: { Origin: 'http://127.0.0.1:8765' },
  })).json();
  try {
    await page.reload();
    await page.locator('#title-userlabels > span').click();
    await page.locator(`[data-edit-label="${made.id}"]`).click();
    await page.locator('#mb-label-modal-delete').click();

    const dialog = page.locator('.confirm-card');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#confirm-title')).toContainText('Voyage');
    await dialog.locator('.confirm-btn-cancel').click();
    await expect(dialog).toHaveCount(0);
    const labels = await (await page.request.get('/api/labels')).json();
    expect(labels.some((l) => l.id === made.id)).toBe(true);
  } finally {
    await page.request.delete(`/api/labels/${made.id}`, {
      headers: { Origin: 'http://127.0.0.1:8765' },
    });
  }
});

test('folded sidebar sections can be opened from the keyboard', async ({ page }) => {
  // The section headers were <div>s listening for clicks.
  const toggle = page.locator('#title-folders > span');
  await expect(toggle).toHaveAttribute('role', 'button');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // And what is folded away is out of the Tab order too.
  expect(await page.locator('#wrap-folders').evaluate((el) => el.inert)).toBe(true);
  await page.keyboard.press(' ');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
});
