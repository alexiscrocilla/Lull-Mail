// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    // Small and absolute, not a ratio. A 0.002 ratio sounded harmless and
    // silently swallowed a real change -- a duplicated date removed and a
    // chip moved across the header -- because on a 568x900 pane that is a
    // thousand pixels of slack. This budget absorbs glyph antialiasing and
    // nothing else. If a CI runner rasterises text differently enough to
    // trip it, regenerate the baselines there once rather than widening it.
    toHaveScreenshot: { maxDiffPixels: 100 },
  },
  fullyParallel: false,
  // One worker, not one-per-file: `fullyParallel: false` only serialises
  // tests INSIDE a file, and every file talks to the same server and the
  // same seeded mailbox. Two files at once had one of them opening a
  // message while the other was asserting the unread count.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL: 'http://127.0.0.1:8765',
    browserName: 'chromium',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    // Unnamed on purpose: a project's name goes into every screenshot file
    // name, and this one owns all the baselines.
    { name: '' },
    // The app also ships on WKWebView and WebKitGTK. What a message frame
    // fetches is where engines differ, so that spec runs on WebKit too; the
    // screenshots stay pinned to Chromium's rasteriser.
    {
      name: 'webkit',
      use: { browserName: 'webkit' },
      testMatch: /remote-content\.spec\.mjs$/,
    },
  ],
  webServer: {
    // CI installs the dependencies into the interpreter on PATH; a local
    // checkout usually keeps them in .venv. PYTHON overrides the choice
    // without editing this file.
    command: `"${process.env.PYTHON || 'python'}" ../scripts/ui_test_server.py`,
    cwd: '.',
    // The app has no health route; the page the tests load is the
    // truest readiness signal anyway.
    url: 'http://127.0.0.1:8765/',
    timeout: 60_000,
    // Never reuse: the seeded mailbox is mutable state, and a test that
    // trashes a message left the next run looking at 17 rows instead of
    // 18. Each run gets its own process and its own temp data dir.
    reuseExistingServer: false,
    env: {
      LULLMAIL_TEST_MODE: '1',
      LULLMAIL_PORT: '8765',
    },
  },
});
