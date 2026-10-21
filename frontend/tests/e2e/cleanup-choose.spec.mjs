// SPDX-License-Identifier: GPL-3.0-or-later
//
// "All of it or nothing" was the Nettoyage page's most reported failing: a
// user who wanted to leave three newsletters out of nine, or empty the spam
// of two senders out of six, had no way to say so. Every card that stands
// for several things now has « Choisir… », and the unsubscribe sheet is a
// checklist whose unticked lists are remembered as kept.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.request.post('/__test__/reset');
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  await page.setViewportSize({ width: 1400, height: 900 });
});

const card = (page, id) => page.locator(`.cln-card[data-card="${id}"]`);
const dialog = (page) => page.locator('.confirm-card');
const rows = (page) => page.locator('.confirm-details li');

test('a small pile can be picked through, not only emptied', async ({ page }) => {
  await page.request.post('/__test__/cleanup?kind=spam&n=12&senders=3');
  await page.goto('/#/cleanup');
  await expect(card(page, 'spam')).toBeVisible();

  // Below the confirm gate the main button stays one click; the choice is
  // the button next to it.
  await card(page, 'spam').locator('.cln-card-pick').click();
  await expect(rows(page)).toHaveCount(3);

  const label = await rows(page).first().locator('.confirm-detail-label').innerText();
  const kept = `s${label.replace('Expediteur ', '')}@bulk.example`;
  await rows(page).first().locator('input').uncheck();
  await dialog(page).locator('.confirm-btn-ok').click();
  await expect(card(page, 'spam')).toHaveAttribute('data-state', 'done');

  const still = await (await page.request.get(
    `/api/emails/search?q=${encodeURIComponent(`from:${kept}`)}&folder=inbox`)).json();
  expect(still.results.length).toBeGreaterThan(0);
});

test('all-or-none and the live count', async ({ page }) => {
  await page.request.post('/__test__/cleanup?kind=spam&n=12&senders=3');
  await page.goto('/#/cleanup');
  await card(page, 'spam').locator('.cln-card-pick').click();
  await expect(rows(page)).toHaveCount(3);

  const toggle = dialog(page).locator('.confirm-toggle-all');
  const ok = dialog(page).locator('.confirm-btn-ok');
  await expect(dialog(page).locator('.confirm-count')).toHaveText('3 sur 3 cochés');
  await toggle.click();
  await expect(dialog(page).locator('.confirm-count')).toHaveText('0 sur 3 cochés');
  await expect(ok).toBeDisabled();
  await toggle.click();
  await expect(ok).toBeEnabled();
  await expect(rows(page).locator('input:checked')).toHaveCount(3);
});

test('a long checklist can be filtered, and Escape clears the filter first', async ({ page }) => {
  await page.request.post('/__test__/cleanup?kind=spam&n=24&senders=12');
  await page.goto('/#/cleanup');
  await card(page, 'spam').locator('.cln-card-pick').click();
  await expect(rows(page)).toHaveCount(12);

  const filter = dialog(page).locator('.confirm-filter');
  await filter.fill('Expediteur 11');
  await expect(rows(page).locator('visible=true')).toHaveCount(1);

  // Unticking through the filter only touches what is shown.
  await dialog(page).locator('.confirm-toggle-all').click();
  await expect(rows(page).locator('input:checked')).toHaveCount(11);

  // Escape here used to close the dialog, and every untick with it.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeVisible();
  await expect(filter).toHaveValue('');
  await expect(rows(page).locator('visible=true')).toHaveCount(12);
  await expect(rows(page).locator('input:checked')).toHaveCount(11);
});

test('unticked lists are not unsubscribed, and are not offered again', async ({ page }) => {
  await page.request.post('/__test__/cleanup?kind=newsletter&n=60&senders=6&unsub=1');

  // The one-click POST leaves the machine; answer it here and read what
  // the page asked for.
  let sent = null;
  await page.route('**/api/cleanup/unsubscribe/bulk', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, job_id: 'fakejob', total: sent.entries.length, skipped: [] } });
  });
  await page.route('**/api/cleanup/jobs/fakejob', (route) => route.fulfill({
    json: { id: 'fakejob', total: 4, done: 4, failed: 0, finished: true },
  }));

  await page.goto('/#/cleanup');
  await expect(card(page, 'unsub_bulk')).toBeVisible();
  await card(page, 'unsub_bulk').locator('.cln-card-go').click();
  await expect(rows(page)).toHaveCount(6);

  const keptNames = [];
  for (const row of (await rows(page).all()).slice(0, 2)) {
    keptNames.push(await row.locator('.confirm-detail-label').innerText());
    await row.locator('input').uncheck();
  }
  await expect(dialog(page).locator('.confirm-btn-ok')).toHaveText('Se désabonner des 4');
  await dialog(page).locator('.confirm-btn-ok').click();

  await expect(card(page, 'unsub_bulk')).toContainText('2 listes conservées');
  expect(sent.entries).toHaveLength(4);
  const senders = sent.entries.map((e) => e.sender);
  for (const name of keptNames) {
    expect(senders).not.toContain(`s${name.replace('Expediteur ', '')}@bulk.example`);
  }

  // The fake job stamped nothing, so the four come back -- but the two the
  // user kept do not, and the footer offers them back.
  await page.reload();
  await expect(card(page, 'unsub_bulk').locator('.cln-card-title'))
    .toHaveText('Se désabonner de 4 listes que vous ne lisez pas');
  const unkeep = page.locator('#cln-unkeep');
  await expect(unkeep).toHaveText('Réafficher 2 abonnements conservés');
  await unkeep.click();
  await expect(card(page, 'unsub_bulk').locator('.cln-card-title'))
    .toHaveText('Se désabonner de 6 listes que vous ne lisez pas');
  await expect(unkeep).toBeHidden();
});
