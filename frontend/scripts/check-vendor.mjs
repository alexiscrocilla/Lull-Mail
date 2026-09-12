// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(frontendDir, 'vendor', 'manifest.json'), 'utf8'));

for (const entry of manifest.files) {
  const bytes = readFileSync(join(frontendDir, 'vendor', entry.path));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== entry.sha256) {
    throw new Error(`Vendor integrity failure for ${entry.path}: ${actual}`);
  }
}
