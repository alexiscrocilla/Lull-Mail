// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(frontendDir, '.tailwind-check.css');
const cli = join(frontendDir, 'node_modules', 'tailwindcss', 'lib', 'cli.js');

try {
  execFileSync(process.execPath, [cli,
    '-c', join(frontendDir, 'tailwind.config.js'),
    '-i', join(frontendDir, 'tailwind-input.css'),
    '-o', output,
    '--minify',
  ], { cwd: frontendDir, stdio: 'inherit' });

  const committed = readFileSync(join(frontendDir, 'tailwind.css'));
  const generated = readFileSync(output);
  if (!committed.equals(generated)) {
    throw new Error('frontend/tailwind.css is stale; run pnpm css:build and commit the result.');
  }
} finally {
  rmSync(output, { force: true });
}
