// SPDX-License-Identifier: GPL-3.0-or-later
//
// The multi-account suite. It is a second config rather than a second
// project because the number of mailboxes is decided by the server process,
// before the first request: `LULLMAIL_TEST_ACCOUNTS` shapes config.yaml, and
// config.yaml is read once at boot.
//
// Keeping it separate also keeps the single-account baselines honest. Adding
// a second account to the default server would have moved every screenshot
// in tests/e2e -- the sidebar grows a mailbox, the rows grow an account chip
// -- and a suite whose baselines all moved at once proves nothing.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e-multi',
  timeout: 30_000,
  expect: { timeout: 5_000, toHaveScreenshot: { maxDiffPixels: 100 } },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL: 'http://127.0.0.1:8766',
    browserName: 'chromium',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `"${process.env.PYTHON || 'python'}" ../scripts/ui_test_server.py`,
    cwd: '.',
    url: 'http://127.0.0.1:8766/',
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      LULLMAIL_TEST_MODE: '1',
      LULLMAIL_PORT: '8766',
      // Three, not two: two mailboxes cannot tell "the account I picked"
      // from "the other one", so a filter that leaks looks correct.
      LULLMAIL_TEST_ACCOUNTS: 'demo@lullmail.test,pro@lullmail.test,asso@lullmail.test',
    },
  },
});
