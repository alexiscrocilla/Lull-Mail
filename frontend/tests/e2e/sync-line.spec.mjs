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
  // Close the stream so the client falls back to the poll these tests stub.
  // That makes the three assertions below the fallback's regression suite
  // for free: if the fallback ever stops working, they go red.
  await page.route('**/api/events', (route) => route.fulfill({ status: 404 }));
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

test('several failing accounts are named, with the reasons on hover', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  await page.route('**/api/events', (route) => route.fulfill({ status: 404 }));
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
  // A bare "2 accounts in error" left the user to work out which two.
  await expect(line).toContainText('Demo');
  await expect(line).toContainText('Second');
  // The reasons do not fit on the line past one failure, so they move to
  // the title -- one per account, not just the first one's.
  await expect(line).toHaveAttribute('title', new RegExp(ERROR_MESSAGE));
  await expect(line).toHaveAttribute('title', /Connection refused/);
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

test('an account in error keeps saying so while a pass is running', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  await page.route('**/api/events', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/sync/status', (route) => {
    const payload = statusPayload({ error: ERROR_MESSAGE });
    // A second, healthy account is being fetched right now. The failure on
    // the first one has not gone anywhere.
    payload.fetching = true;
    payload.running = true;
    payload.accounts.push({
      ...payload.accounts[0],
      email: 'second@lullmail.test',
      name: 'Second',
      error: null,
      phase: 'fetching',
    });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
  await page.goto('/#/inbox');

  const line = page.locator('#mb-sync-line');
  // The error used to live inside the idle branch only, so with several
  // accounts -- where a pass is running most of the time -- it was almost
  // never on screen.
  await expect(line).toHaveClass(/has-error/);
  await expect(line).toContainText('Demo');
});

test('the instant-delivery bolt does not speak for the mailboxes that lack it', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  await page.route('**/api/events', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/sync/status', (route) => {
    const payload = statusPayload({ error: null });
    payload.accounts[0].push = { connected: true, supported: true, error: null };
    payload.accounts.push({
      ...payload.accounts[0],
      email: 'second@lullmail.test',
      name: 'Second',
      push: { connected: false, supported: true, error: null },
    });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
  await page.goto('/#/inbox');

  const line = page.locator('#mb-sync-line');
  await expect(line.locator('.mb-sync-bolt')).toHaveClass(/is-partial/);
  // And the title says which mailbox is actually on IDLE and which is not,
  // instead of claiming instant delivery for both.
  await expect(line).toHaveAttribute('title', /Demo/);
  await expect(line).toHaveAttribute('title', /Second/);
});
