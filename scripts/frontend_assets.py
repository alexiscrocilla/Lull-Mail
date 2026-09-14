# SPDX-License-Identifier: GPL-3.0-or-later
"""Which files under ``frontend/`` belong inside a release build.

The spec used to ship the directory wholesale — one line, and correct for
as long as ``frontend/`` held nothing but what the app serves. It now also
holds a package manager's tree: 52 MB of node_modules, a Playwright package,
screenshot baselines and a test runner, none of which the running app can
reach and all of which ended up inside every installer and served at
/static/.

Deliberately a DENY list, not an allow list. A new stylesheet, font or module
added next year ships because nothing has to remember to add it; only the
tooling directories, which are named and few, are dropped. The failure mode
of an allow list here is a missing asset at runtime, which is worse than a
slightly larger build.
"""

from __future__ import annotations

import os
from typing import List, Tuple

# Package managers, test tooling and their output.
SKIP_DIRS = {
    "node_modules",
    "tests",             # unit + e2e specs and their PNG baselines
    "test-results",      # Playwright failure artefacts
    "playwright-report",
    "scripts",           # the css/vendor checkers, run from CI only
    ".pnpm-store",
    "__pycache__",
}

# Build inputs and configuration. tailwind.css (the OUTPUT) is kept.
SKIP_FILES = {
    "package.json",
    "pnpm-lock.yaml",
    "jsconfig.json",
    "playwright.config.mjs",
    "playwright.multi.config.mjs",
    "tailwind.config.js",
    "tailwind-input.css",
    ".gitignore",
}


def frontend_datas(root: str) -> List[Tuple[str, str]]:
    """``[(source, dest_dir)]`` for PyInstaller's ``datas``.

    ``root`` is the repo root. Paths are emitted with forward slashes so the
    same spec produces the same layout on all three platforms.
    """
    base = os.path.join(root, "frontend")
    out: List[Tuple[str, str]] = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        rel = os.path.relpath(dirpath, base)
        dest = "frontend" if rel == "." else os.path.join("frontend", rel)
        for name in sorted(filenames):
            if name in SKIP_FILES:
                continue
            out.append((os.path.join(dirpath, name), dest.replace("\\", "/")))
    return out
