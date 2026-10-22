// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

// The seeded mailbox is pinned to 25 August 2026, its newest message at
// 11:30 Paris time. A minute before that day ends, it is still today's mail.
const LAST_MINUTE = new Date('2026-08-25T23:59:00+02:00');

test.beforeEach(async ({ page }) => {
  await page.request.post('/__test__/reset');
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  // Two things would fix the labels by rendering them again, which is the
  // one thing these tests rule out. The stream: the test server cannot
  // hydrate a body without IMAP and says so every couple of seconds, and
  // each time the open message is drawn anew. And coming back to the
  // window, which asks for a fetch whose end reloads the list.
  await page.route('**/api/events**', (route) => route.abort());
  await page.route('**/api/sync', (route) => route.fulfill({ json: { ok: false } }));
  await page.clock.install({ time: LAST_MINUTE });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  await expect(page.locator('#badge-inbox')).toHaveText('6');
});

// A new node would carry the right day too, so each test marks the one it
// watches: the label has to change on the element that was already there.
async function marked(locator) {
  await locator.evaluate((el) => { el.dataset.probe = 'kept'; });
  return locator;
}

test('the list turns today into yesterday at midnight, without a reload', async ({ page }) => {
  const card = await marked(page.locator('#email-list .mb-card').first());
  await expect(card.locator('.mb-date')).toHaveText("Aujourd'hui 11:30");
  await card.focus();

  await page.clock.runFor('02:00');

  await expect(card.locator('.mb-date')).toHaveText('Hier 11:30');
  // Screen readers get the date from the card's own label, not its text.
  await expect(card).toHaveAttribute('aria-label', /\. Hier 11:30/);
  await expect(card).not.toHaveAttribute('aria-label', /Aujourd'hui/);
  await expect(card).toHaveAttribute('data-probe', 'kept');
  await expect(card).toBeFocused();
});

test('a machine that slept through midnight catches up when the window comes back', async ({ page }) => {
  const card = await marked(page.locator('#email-list .mb-card').first());
  await expect(card.locator('.mb-date')).toHaveText("Aujourd'hui 11:30");

  // The wall clock jumps two days and no timer fires: what a suspended
  // machine looks like to the page when it wakes.
  await page.clock.setSystemTime(new Date('2026-08-27T08:00:00+02:00'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

  await expect(card.locator('.mb-date')).toHaveText('25 août');
  await expect(card).toHaveAttribute('data-probe', 'kept');
});

test('the rows of an open conversation follow the day change too', async ({ page }) => {
  // No seeded message has a reply, so the thread is answered here.
  const earlier = {
    int_id: 990001,
    folder: 'inbox',
    sender: 'Camille Martin <camille@atelier-martin.fr>',
    subject: 'Point sur la maquette de septembre',
    date_received: '2026-08-25T06:00:00+00:00',
    summary: 'Première version de la maquette.',
  };
  await page.route(/\/api\/emails\/\d+\/thread/, (route) => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3]);
    return route.fulfill({ json: { messages: [earlier, { int_id: id, folder: 'inbox' }] } });
  });
  await page.locator('#email-list .mb-card').first().click();
  const row = await marked(page.locator('#read-pane .mb-thread-msg').first());
  await expect(row.locator('.mb-thread-msg-date')).toHaveText("Aujourd'hui 08:00");

  await page.clock.runFor('02:00');

  await expect(row.locator('.mb-thread-msg-date')).toHaveText('Hier 08:00');
  await expect(row).toHaveAttribute('data-probe', 'kept');
});
