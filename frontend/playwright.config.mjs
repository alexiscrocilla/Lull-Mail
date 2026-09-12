// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
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
    command: 'python ../scripts/ui_test_server.py',
    cwd: '.',
    url: 'http://127.0.0.1:8765/api/health',
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: {
      LULLMAIL_TEST_MODE: '1',
      LULLMAIL_PORT: '8765',
    },
  },
});
