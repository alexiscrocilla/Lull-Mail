// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Nettoyage page's buttons empty piles of several hundred messages. Until
// now the only thing between "Supprimer 412 spams" and 412 deletions was a
// dialog that repeated the card's own sentence and its own number -- nothing
// said WHICH 412, and the answer to "I do not know what this is" was to not
// press it. Which is what people did.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.request.post('/__test__/reset');
  // Past CONFIRM_ABOVE, which is where the preview lives: below it a card
  // stays one click and a twenty-second undo.
  await page.request.post('/__test__/cleanup?kind=spam&n=260&senders=5');
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  await page.setViewportSize({ width: 1400, height: 900 });
});

const card = (page) => page.locator('.cln-card[data-card="spam"]');
const dialog = (page) => page.locator('.confirm-card');
const rows = (page) => page.locator('.confirm-details li');

test('the button names every sender it is about to empty', async ({ page }) => {
  await page.goto('/#/cleanup');
  await expect(card(page)).toBeVisible();

  await card(page).locator('.cln-card-go').click();
  await expect(dialog(page)).toBeVisible();

  // Five senders, each with its own row and its own checkbox.
  await expect(rows(page)).toHaveCount(5);
  await expect(rows(page).first()).toContainText('Expediteur');
  await expect(rows(page).first()).toContainText('messages');
  await expect(rows(page).first().locator('input')).toBeChecked();
});

test('unticking a sender changes the number on the button', async ({ page }) => {
  await page.goto('/#/cleanup');
  await expect(card(page)).toBeVisible();
  await card(page).locator('.cln-card-go').click();
  await expect(rows(page)).toHaveCount(5);

  const ok = dialog(page).locator('.confirm-btn-ok');
  await expect(ok).toContainText('260');

  // The number must count MESSAGES, not rows: a row stands for one sender
  // and forty messages, and "put the 4 in the trash" over a 222-message
  // press is a worse lie than no number at all.
  const firstRow = await rows(page).first().locator('.confirm-detail-sub').innerText();
  const n = parseInt(firstRow.match(/(\d+)/)[1], 10);
  await rows(page).first().locator('input').uncheck();
  await expect(ok).toContainText(String(260 - n));

  // And unticking everything leaves nothing to press.
  for (const input of await rows(page).locator('input').all()) await input.uncheck();
  await expect(ok).toBeDisabled();
});

test('a sender the user kept still has its mail afterwards', async ({ page }) => {
  await page.goto('/#/cleanup');
  await expect(card(page)).toBeVisible();
  await card(page).locator('.cln-card-go').click();
  await expect(rows(page)).toHaveCount(5);

  const keptLabel = await rows(page).first().locator('.confirm-detail-label').innerText();
  const kept = `s${keptLabel.replace('Expediteur ', '')}@bulk.example`;
  await rows(page).first().locator('input').uncheck();
  await dialog(page).locator('.confirm-btn-ok').click();

  await expect(card(page)).toHaveAttribute('data-state', 'done');

  // Asked of the server, not of a debounced search box: the point is what is
  // in the inbox, and a UI assertion here passes on the pre-search list.
  const still = await (await page.request.get(
    `/api/emails/search?q=${encodeURIComponent(`from:${kept}`)}&folder=inbox`)).json();
  expect(still.results.length).toBeGreaterThan(0);

  // And the senders that stayed ticked are gone from the inbox.
  const others = await (await page.request.get(
    '/api/emails/search?q=Offre&folder=inbox&limit=500')).json();
  const senders = new Set(others.results.map((r) => r.sender));
  expect(senders.size).toBe(1);
});

test('the checkboxes are reachable from the keyboard', async ({ page }) => {
  // The focus trap only knew about buttons, so it yanked focus off every
  // checkbox the moment the user Tabbed onto one.
  await page.goto('/#/cleanup');
  await expect(card(page)).toBeVisible();
  await card(page).locator('.cln-card-go').click();
  await expect(rows(page)).toHaveCount(5);

  await page.keyboard.press('Tab');
  const tags = [];
  for (let i = 0; i < 4; i += 1) {
    tags.push(await page.evaluate(() => document.activeElement?.tagName));
    await page.keyboard.press('Tab');
  }
  expect(tags.filter((x) => x === 'INPUT').length).toBeGreaterThanOrEqual(3);

  // And the trap still holds: focus never leaves the dialog.
  expect(await page.evaluate(() =>
    document.querySelector('.confirm-card').contains(document.activeElement))).toBe(true);
});

test('leaving the page takes the dialog with it', async ({ page }) => {
  await page.goto('/#/cleanup');
  await expect(card(page)).toBeVisible();
  await card(page).locator('.cln-card-go').click();
  await expect(dialog(page)).toBeVisible();

  // confirmAsync appends to document.body, which the router's #view wipe
  // does not touch: the modal stayed pinned over the inbox with the page
  // behind it inert.
  await page.goto('/#/inbox');
  await expect(page.locator('.confirm-backdrop')).toHaveCount(0);
  await expect(page.locator('#email-list .mb-card').first()).toBeVisible();
});

test('a small pile still goes in one click', async ({ page }) => {
  await page.request.post('/__test__/reset');
  await page.request.post('/__test__/cleanup?kind=spam&n=12&senders=3');
  await page.goto('/#/cleanup');
  await expect(card(page)).toBeVisible();

  // At twelve spams a dialog is the friction, not the safety -- and a
  // dialog shown every time is the one that gets dismissed without reading.
  await card(page).locator('.cln-card-go').click();
  await expect(card(page)).toHaveAttribute('data-state', 'done');
  await expect(page.locator('.confirm-card')).toHaveCount(0);
});

test('leaving the page does not leave the keyboard trapped behind it', async ({ page }) => {
  await page.goto('/#/cleanup');
  await expect(card(page)).toBeVisible();
  await card(page).locator('.cln-card-go').click();
  await expect(dialog(page)).toBeVisible();

  // The teardown used to delete the backdrop node directly. That skips
  // close(), which is what removes confirm.js's document-level CAPTURE
  // keydown listener -- and its Tab trap then preventDefaults every Tab in
  // the app, forever, against a card no longer in the document.
  await page.goto('/#/inbox');
  await expect(page.locator('.confirm-backdrop')).toHaveCount(0);
  await expect(page.locator('#email-list .mb-card').first()).toBeVisible();

  await page.locator('#search').focus();
  await page.keyboard.press('Tab');
  const moved = await page.evaluate(() => document.activeElement?.id !== 'search');
  expect(moved).toBe(true);
  // And specifically onto the filter toggle, which is the next control.
  await expect(page.locator('.mb-refine-toggle')).toBeFocused();
});

test('a sender whose address contains a pipe is still spared', async ({ page }) => {
  await page.request.post('/__test__/reset');
  await page.request.post('/__test__/cleanup?kind=spam&n=260&senders=5&pipe=1');
  await page.goto('/#/cleanup');
  await expect(card(page)).toBeVisible();
  await card(page).locator('.cln-card-go').click();
  await expect(rows(page)).toHaveCount(5);

  // The row key used to be `${sender}|${account}`, split on the first pipe:
  // the fields shifted, the exclusion matched nothing, and the mail the user
  // explicitly kept was trashed anyway with nothing on screen to say so.
  const target = rows(page).filter({ hasText: 'Expediteur 0' });
  await expect(target).toHaveCount(1);
  await target.locator('input').uncheck();
  await dialog(page).locator('.confirm-btn-ok').click();
  await expect(card(page)).toHaveAttribute('data-state', 'done');

  const left = await (await page.request.get(
    '/api/emails/search?q=Offre&folder=inbox&limit=500')).json();
  const senders = new Set(left.results.map((r) => r.sender));
  expect([...senders]).toEqual(['Expediteur 0 <new|s0@bulk.example>']);
});

test('the live label reads as a singular when one message is left', async ({ page }) => {
  await page.request.post('/__test__/reset');
  await page.request.post('/__test__/cleanup?kind=spam&n=201&senders=3&solo=1');
  await page.goto('/#/cleanup');
  await expect(card(page)).toBeVisible();
  await card(page).locator('.cln-card-go').click();
  await expect(rows(page)).toHaveCount(4);   // three bulk senders + the solo one

  // The label is recomputed from the ticks, so it can reach n = 1 -- and
  // confirm.js also pushes it into an aria-live region, so a screen reader
  // says it out loud.
  const counts = [];
  for (const row of await rows(page).all()) {
    const sub = await row.locator('.confirm-detail-sub').innerText();
    counts.push(parseInt(sub.match(/(\d+)/)[1], 10));
  }
  expect(Math.min(...counts)).toBe(1);

  for (const [i, row] of (await rows(page).all()).entries()) {
    if (counts[i] !== 1) await row.locator('input').uncheck();
  }
  await expect(dialog(page).locator('.confirm-btn-ok')).not.toContainText('les 1');
});
