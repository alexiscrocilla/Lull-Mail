// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, test } from '@playwright/test';

/*
 * The wizard used to open on a 4.3-7.1 GB model download, before the app
 * knew whose mail it was fetching, so the number of messages visible during
 * that six-to-forty-seven minute wait was zero. The account comes first now,
 * and the fetch starts when the user leaves that screen, so the AI choice
 * overlaps the download instead of preceding it.
 */

test.beforeEach(async ({ page }) => {
  await page.route('**/api/brand-logo/**', (route) => route.abort());
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto('/onboarding');
});

test('three screens, and the account is the first', async ({ page }) => {
  await expect(page.locator('.step-dot')).toHaveCount(3);
  const visible = await page.$$eval('.panel:not(.hidden)', (n) => n.map((e) => e.id));
  expect(visible).toEqual(['step-2']);
  await expect(page.locator('#step-2 h2')).toContainText('comptes');
});

test('the notifications step is gone and the last screen says where they live', async ({ page }) => {
  await expect(page.locator('#step-3')).toHaveCount(0);
  await expect(page.locator('#ntfy-topic')).toHaveCount(0);
  const hint = await page.locator('#step-4 [data-i18n="ob.step4.notif_hint"]').textContent();
  expect(hint).toContain('Notifications push');
});

test('the model picker is a real select, not a bespoke listbox', async ({ page }) => {
  const tag = await page.$eval('#openai-model', (e) => e.tagName);
  expect(tag).toBe('SELECT');
  await expect(page.locator('#openai-model-drop')).toHaveCount(0);
  await expect(page.locator('#openai-model option')).toHaveCount(3);
});

test('the local option downloads one model, not two', async ({ page }) => {
  // The AI screen is the second one.
  await page.evaluate(() => window.goToStep(2));
  await expect(page.locator('#step-1')).toBeVisible();
  await expect(page.locator('#ob-models-pills .role-pill')).toHaveCount(1);
});
