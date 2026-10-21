// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

/*
 * With no model configured, every control that can only produce a 409 has to
 * be absent. "AI off" does not mean "no signal", though: the analysis pass
 * runs regex rules and a sender memo before it ever reaches a model, and
 * neither of those is gated. So the category list stays, and the wording
 * that describes the pass must not claim a model read anything.
 */

test.beforeEach(async ({ page }) => {
  // One server serves every spec file and the mailbox is mutable state, so
  // start from the seeded mailbox rather than from whatever the previous
  // file left behind.
  await page.request.post('/__test__/reset');
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  await page.route('**/api/setup/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ai_enabled: false, has_openai: false, configured: true }),
    }),
  );
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/#/inbox');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
});

test('no control on screen can produce a 409', async ({ page }) => {
  expect(await page.evaluate(() => window.aiEnabled)).toBe(false);

  // Rail entries that lead to the AI page and the analysis queue.
  await expect(page.locator('#ai-toggle')).toBeHidden();
  await expect(page.locator('#queue-ind')).toBeHidden();

  // The quick chip whose only possible result is an empty list.
  await expect(page.locator('[data-quick="reply"]')).toHaveCount(0);

  // The sort mode that orders by a number nothing displays; with one option
  // left the control is furniture, so it goes too.
  await expect(page.locator('#sort-select-wrap')).toBeHidden();

  // The bulk re-analyse button, one 409 per selected message.
  await page.locator('#email-list .mb-card').first().locator('.mb-avatar').click();
  await expect(page.locator('#sel-bar')).toBeVisible();
  await expect(page.locator('#sel-bar [data-act="ai"]')).toHaveCount(0);
});

test('the read pane makes no claim a model did not make', async ({ page }) => {
  await page.locator('#email-list .mb-card').first().click();
  await expect(page.locator('#read-pane .mb-read-subject')).toBeVisible();
  // No analysis box, no re-analyse control.
  await expect(page.locator('.mb-ai-box')).toHaveCount(0);
  await expect(page.locator('#btn-analyze')).toHaveCount(0);
  // And no category pill: the seeded mail is "important", a verdict this
  // configuration cannot produce.
  await expect(page.locator('#read-pane .cat-chip')).toHaveCount(0);
});

test('the category tabs survive, because rules still classify', async ({ page }) => {
  // Spam, newsletters and receipts come from regex rules that run with no
  // model at all, and these tabs are the only way to reach them now.
  await expect(page.locator('#mb-cats [data-cat="spam"]')).toHaveCount(1);
  await expect(page.locator('#mb-cats [data-cat="newsletter"]')).toHaveCount(1);
  await expect(page.locator('#mb-cats [data-cat="transactional"]')).toHaveCount(1);
});

test('a reply filter set while AI was on does not strand the user', async ({ page }) => {
  // Arrive with the filter already applied, as a user returning from
  // Settings after switching the model off would.
  await page.goto('/#/inbox?reply=1');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  await expect(page.locator('[data-quick="reply"]')).toHaveCount(0);
});
