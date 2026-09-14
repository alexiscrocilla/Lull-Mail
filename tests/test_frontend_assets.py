# SPDX-License-Identifier: GPL-3.0-or-later
"""What goes inside the installer, and what must never.

The spec used to be `datas += [("frontend", "frontend")]`. That was right
until frontend/ grew a package manager's tree; then every installer carried
52 MB of node_modules, a Playwright package and a set of PNG baselines, and
the app served them at /static/.

The replacement is a deny list, so the risk inverts: instead of silently
shipping tooling, it could silently DROP a runtime asset nobody remembered
to add. Both directions are pinned here.
"""

from __future__ import annotations

import os
import re
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from scripts.frontend_assets import frontend_datas  # noqa: E402


@pytest.fixture(scope="module")
def shipped():
    return frontend_datas(ROOT)


@pytest.fixture(scope="module")
def shipped_names(shipped):
    return {os.path.basename(src) for src, _ in shipped}


def test_no_tooling_reaches_the_installer(shipped):
    leaked = [src for src, _ in shipped
              if any(part in ("node_modules", "tests", "test-results",
                              "playwright-report", ".pnpm-store")
                     for part in src.replace("\\", "/").split("/"))]
    assert leaked == [], f"{len(leaked)} tooling files would be shipped, e.g. {leaked[:3]}"


def test_every_module_the_page_loads_is_shipped(shipped_names):
    """index.html names its entry points; missing one is a blank app."""
    html = open(os.path.join(ROOT, "frontend", "index.html"), encoding="utf-8").read()
    referenced = set(re.findall(r'(?:src|href)="\.?/?([\w./-]+\.(?:js|css|mjs))"', html))
    assert referenced, "could not read any asset reference out of index.html"
    for name in referenced:
        assert os.path.basename(name) in shipped_names, f"index.html loads {name}, not shipped"


def test_every_module_imported_by_another_is_shipped(shipped, shipped_names):
    """A deny list must not drop a module added later.

    This is the case the audit raised about search-query.js: a new frontend
    module that nothing in the build enumerates.
    """
    missing = []
    for src, _ in shipped:
        if not src.endswith(".js"):
            continue
        text = open(src, encoding="utf-8").read()
        for imported in re.findall(r"from\s+'/static/([\w./-]+)'", text):
            if os.path.basename(imported) not in shipped_names:
                missing.append((os.path.basename(src), imported))
    assert missing == [], f"imported but not shipped: {missing}"


def test_the_built_stylesheet_ships_and_its_input_does_not(shipped_names):
    assert "tailwind.css" in shipped_names        # the output the page loads
    assert "tailwind-input.css" not in shipped_names
    assert "tailwind.config.js" not in shipped_names
    assert "package.json" not in shipped_names


def test_the_vendored_library_and_its_licence_ship(shipped_names):
    # Shipping the code without the licence file is the one omission here
    # that is a legal problem rather than a broken page.
    assert "dompurify.es.mjs" in shipped_names
    assert "DOMPURIFY-LICENSE" in shipped_names


def test_the_collection_is_small_enough_to_be_obviously_right(shipped):
    total = sum(os.path.getsize(src) for src, _ in shipped)
    # ~2 MB today. The point is the order of magnitude: if this ever passes
    # 20 MB again, something like node_modules is back in the installer.
    assert total < 20_000_000, f"frontend payload is {total / 1e6:.0f} MB"
