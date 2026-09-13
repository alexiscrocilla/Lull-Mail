// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // One server serves every spec file and the mailbox is mutable state, so
  // start from the seeded mailbox rather than from whatever the previous
  // file left behind.
  await page.request.post('/__test__/reset');
});

/*
 * The sidebar sync line is the only keyboard-reachable place an account
 * failure is spoken: the per-account list writes the server's message into a
 * `title` attribute and nothing else, and that list is about to stop being
 * rendered for people with a single account. So the line has to carry the
 * message itself, not a count.
 */

const ERROR_MESSAGE = 'AUTHENTICATIONFAILED: identifiants refuses par le serveur';

function statusPayload({ error }) {
  return {
    running: false,
    fetching: false,
    analysing: false,
    phase: 'idle',
    last_sync_iso: '2026-09-13T08:00:00+00:00',
    queue_pending: 0,
    pending_ops: 0,
    analysis: {},
    accounts: [
      {
        email: 'demo@lullmail.test',
        name: 'Demo',
        type: 'imap',
        phase: 'idle',
        fetched: 0,
        new: 0,
        last_new_count: 0,
        last_new_at: null,
        last_sync: '2026-09-13T08:00:00+00:00',
        error,
        backoff_until: null,
        consecutive_failures: error ? 3 : 0,
        push: { connected: false, supported: null, error: null },
      },
    ],
  };
}

async function stubStatus(page, { error }) {
  await page.route('**/api/sync/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(statusPayload({ error })),
    }),
  );
  await page.route('**/api/brand-logo/**', (route) => route.abort());
}

test('a single failing account states its reason in the sync line', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await stubStatus(page, { error: ERROR_MESSAGE });
  await page.goto('/#/inbox');

  const line = page.locator('#mb-sync-line');
  await expect(line).toContainText(ERROR_MESSAGE);
  // The account it belongs to, so the message still makes sense once a
  // second account exists.
  await expect(line).toContainText('Demo');
  await expect(line).toHaveClass(/has-error/);
});

test('several failing accounts still fall back to a count', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  await page.route('**/api/sync/status', (route) => {
    const payload = statusPayload({ error: ERROR_MESSAGE });
    payload.accounts.push({
      ...payload.accounts[0],
      email: 'second@lullmail.test',
      name: 'Second',
      error: 'Connection refused',
    });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
  await page.goto('/#/inbox');

  const line = page.locator('#mb-sync-line');
  await expect(line).toContainText('2');
  await expect(line).not.toContainText(ERROR_MESSAGE);
});

test('a healthy account says when it last fetched and nothing else', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await stubStatus(page, { error: null });
  await page.goto('/#/inbox');

  const line = page.locator('#mb-sync-line');
  await expect(line).toContainText('Relevé');
  await expect(line).not.toHaveClass(/has-error/);
});
