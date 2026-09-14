// SPDX-License-Identifier: GPL-3.0-or-later
//
// Prove the browser Playwright will launch is actually on disk.
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
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const version = browser.version();
await browser.close();
console.log(`Chromium ${version} launches from this install.`);
