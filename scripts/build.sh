#!/usr/bin/env bash
# =============================================================================
# Lull Mail — build script for macOS and Linux
#
# Usage:
#   bash scripts/build.sh
#
# Produces dist/LullMail/ (PyInstaller onedir).
# On macOS, lull_mail.spec also emits dist/LullMail.app automatically.
#
# Environment variables (same contract as build.bat):
#   LULLMAIL_VERSION    Force the version string (used by CI).
#                       When unset, falls back to the latest git tag.
#   LULLMAIL_NOINTERACT Set to 1 to skip the interactive pause at the end
#                       (used by CI and release workflow).
# =============================================================================

set -euo pipefail

# ── Working directory ─────────────────────────────────────────────────────────
# Always run from the project root, regardless of where the script is invoked.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo ""
echo "=== Lull Mail — Build ($(uname -s)) ==="
echo ""

# ── Venv check ────────────────────────────────────────────────────────────────
if [[ ! -d ".venv" ]]; then
    echo "[ERREUR] Environnement virtuel introuvable."
    echo "Lancez d'abord : python -m venv .venv && .venv/bin/pip install -r requirements.txt"
    exit 1
fi

PYTHON=".venv/bin/python"
PIP=".venv/bin/pip"
PYINSTALLER=".venv/bin/pyinstaller"

# ── Version resolution ────────────────────────────────────────────────────────
if [[ -n "${LULLMAIL_VERSION:-}" ]]; then
    _VER="$LULLMAIL_VERSION"
else
    _GIT_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
    if [[ -n "$_GIT_TAG" ]]; then
        _VER="${_GIT_TAG#v}"   # strip leading 'v'
    else
        _VER="0.0.0-dev"
    fi
fi

echo "__version__ = \"$_VER\"" > src/_version.py
echo "[version] $_VER baked into src/_version.py"

# ── Install / update deps ─────────────────────────────────────────────────────
echo "[1/3] Updating dependencies..."
"$PIP" install -r requirements.txt -q
"$PIP" install pyinstaller==6.11.1 -q

# ── PyInstaller build ─────────────────────────────────────────────────────────
echo "[2/3] Building with PyInstaller (may take 1-2 min)..."
rm -rf build dist
"$PYINSTALLER" lull_mail.spec --noconfirm --clean

# ── Verify output ─────────────────────────────────────────────────────────────
echo "[3/3] Verifying output..."
if [[ ! -f "dist/LullMail/LullMail" ]]; then
    echo "[ERREUR] dist/LullMail/LullMail not found after build."
    exit 1
fi

# Clean up the intermediate build/ dir so a stale build/LullMail/ binary
# can never be accidentally launched (it doesn't have its shared libs).
rm -rf build

echo ""
echo "=== Build complete ==="
echo ""
echo "Executable : dist/LullMail/LullMail"
if [[ "$(uname -s)" == "Darwin" ]]; then
    echo "App bundle : dist/LullMail.app"
fi
echo ""

if [[ "${LULLMAIL_NOINTERACT:-0}" != "1" ]]; then
    read -rp "Press Enter to continue..." _
fi
