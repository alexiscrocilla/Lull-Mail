// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // One server serves every spec file and the mailbox is mutable state, so
  // start from the seeded mailbox rather than from whatever the previous
  // file left behind.
  await page.request.post('/__test__/reset');
});

/*
 * pywebview opens the page with no fragment, so the boot line that defaults
 * the route used to *assign* location.hash — which fires `hashchange`, which
 * queues a second render(). The queued render ran while the AI probe was
 * still in flight, so a cold launch loaded the mail list twice and, with AI
 * on, painted one frame of the no-AI mailbox before correcting itself.
 */

test('a cold launch loads the mail list exactly once', async ({ page }) => {
  await page.route('**/api/brand-logo/**', (route) => route.abort());

  const listLoads = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname === '/api/emails') listLoads.push(url.search);
  });

  // No fragment: this is what the desktop shell actually opens.
  await page.goto('/');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  await expect(page.locator('#queue-ind')).toBeVisible();

  expect(listLoads, `list loaded ${listLoads.length} times: ${listLoads.join(' | ')}`)
    .toHaveLength(1);
  expect(page.url()).toContain('#/inbox');
});

test('the AI flag is resolved, never left undefined, before the first paint', async ({ page }) => {
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  const flag = await page.evaluate(() => window.aiEnabled);
  expect(typeof flag).toBe('boolean');
});

test('a backend that refuses the probe leaves the flag off, not unresolved', async ({ page }) => {
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  await page.route('**/api/setup/status', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
  );
  await page.goto('/');
  await expect(page.locator('#email-list .mb-card')).toHaveCount(18);
  expect(await page.evaluate(() => window.aiEnabled)).toBe(false);
  // And the AI rail entries stay hidden rather than offering a 409.
  await expect(page.locator('#ai-toggle')).toBeHidden();
  await expect(page.locator('#queue-ind')).toBeHidden();
});
