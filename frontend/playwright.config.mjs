// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    // The baselines are rasterised on whichever Windows build generated
    // them, and glyph antialiasing differs between builds. A few hundred
    // edge pixels must not fail the run; anything structural -- a removed
    // glyph, a collapsed row, a shifted column -- is far larger than this,
    // and the count and visibility assertions in the spec are exact.
    toHaveScreenshot: { maxDiffPixelRatio: 0.002 },
  },
  fullyParallel: false,
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
    reuseExistingServer: !process.env.CI,
    env: {
      LULLMAIL_TEST_MODE: '1',
      LULLMAIL_PORT: '8765',
    },
  },
});
