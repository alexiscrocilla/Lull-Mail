// SPDX-License-Identifier: GPL-3.0-or-later
//
// Three mailboxes, one list. Everything here is a case a single account
// cannot express, which is exactly why none of it was caught: at N=1 the
// buggy code and the correct code render the same pixels.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.request.post('/__test__/reset');
  await page.route('**/api/brand-logo/**', (route) => route.abort());
});

// 18 on the primary + 6 each on the two others.
const TOTAL = 30;

// The first paint after the server boots is the slow one: two requests, a
// cold Python process and a cold SQLite page cache, and only then 30 rows.
// Five seconds is comfortable on a developer machine and not always enough
// on a CI runner — where the failure artefact showed all 30 rows present,
// just later. This gate means "the app has finished loading", not "it loaded
// within the default timeout"; every other assertion keeps the 5 s default
// so a genuinely broken one still fails fast.
const BOOT_MS = 30_000;

async function settled(page) {
  await expect(page.locator('#email-list .mb-card')).toHaveCount(TOTAL, { timeout: BOOT_MS });
  await expect(page.locator('#queue-ind')).toBeVisible({ timeout: BOOT_MS });
}

test('every row says which mailbox it landed in', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/inbox');
  await settled(page);

  // Not "some rows": the account is either a property of every row or it is
  // guesswork on the ones that lack it.
  await expect(page.locator('#email-list .mb-card .mb-card-acc')).toHaveCount(TOTAL);

  const names = await page.locator('#email-list .mb-card-acc-name').allInnerTexts();
  expect(new Set(names)).toEqual(new Set(['Demo', 'Pro', 'Asso']));
});

test('the same newsletter in two mailboxes is two distinguishable rows', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/inbox');
  await settled(page);

  // Same sender, same subject, different account: without the chip these
  // two rows are byte-identical and the user cannot tell which mailbox to
  // go and unsubscribe from.
  const shared = page.locator('#email-list .mb-card', {
    has: page.locator('.mb-sender', { hasText: 'Lettre Rivage' }),
  });
  await expect(shared).toHaveCount(4);

  const accounts = await shared.locator('.mb-card-acc-name').allInnerTexts();
  expect(new Set(accounts)).toEqual(new Set(['Pro', 'Asso']));

  // And the accessible name carries it too, so the rows are distinguishable
  // to a screen reader, which never sees the chip.
  const labels = await shared.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  expect(labels.filter((l) => l.includes('Compte Pro'))).toHaveLength(2);
  expect(labels.filter((l) => l.includes('Compte Asso'))).toHaveLength(2);
});

test('the sidebar counters follow the account filter', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/inbox');
  await settled(page);

  // 6 unread on Demo, 3 on each of the others.
  const inboxBadge = page.locator('#badge-inbox');
  await expect(inboxBadge).toHaveText('12');

  await page.locator('[data-acc="pro@lullmail.test"]').click();
  await expect(page.locator('#email-list .mb-card')).toHaveCount(6);
  // A badge that keeps summing every mailbox contradicts the list beside it.
  await expect(inboxBadge).toHaveText('3');

  // Back to all accounts.
  await page.locator('[data-acc="pro@lullmail.test"]').click();
  await expect(page.locator('#email-list .mb-card')).toHaveCount(TOTAL);
  await expect(inboxBadge).toHaveText('12');
});

test('a search over two mailboxes returns both, and says so', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/inbox');
  await settled(page);

  // Two accounts selected. The request used to carry no account filter at
  // all and prune client-side, so past the row cap the busier mailbox took
  // every slot and the other returned nothing.
  await page.locator('[data-acc="pro@lullmail.test"]').click();
  await page.locator('[data-acc="asso@lullmail.test"]').click({ modifiers: ['Shift'] });
  await expect(page.locator('#email-list .mb-card')).toHaveCount(12);

  await page.locator('#search').fill('Rivage');
  const hits = page.locator('#email-list .mb-card');
  await expect(hits).toHaveCount(4);
  const accounts = await hits.locator('.mb-card-acc-name').allInnerTexts();
  expect(new Set(accounts)).toEqual(new Set(['Pro', 'Asso']));

  // And the header says an account filter is on -- the sidebar's account
  // section collapses, so nothing else did.
  await expect(page.locator('#filter-chips .mb-chip-filter')).toContainText('2 comptes');
});
