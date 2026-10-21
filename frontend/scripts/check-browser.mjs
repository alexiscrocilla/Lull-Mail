// SPDX-License-Identifier: GPL-3.0-or-later
//
// Prove the browsers Playwright will launch are actually on disk: Chromium
// for the whole suite, WebKit for the remote-content spec.
//
// CI's install step once ended without running `playwright install` at all —
// `pnpm` is a .cmd shim on Windows, and a batch script that calls one without
// `call` never comes back — and the step still exited 0. The absence only
// surfaced later, as every single test failing with "Executable doesn't exist
// at …\chromium_headless_shell-1187\…", which reads like a Playwright bug
// rather than a missing install.
//
// `playwright install --dry-run` does not help: it prints what WOULD be
// downloaded whether or not anything is there. Launching is the only check
// that answers the question the tests are about to ask.
import { chromium, webkit } from '@playwright/test';

for (const [label, type] of [['Chromium', chromium], ['WebKit', webkit]]) {
  const browser = await type.launch();
  const version = browser.version();
  await browser.close();
  console.log(`${label} ${version} launches from this install.`);
}
