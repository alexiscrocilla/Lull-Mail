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
echo "[1/4] Updating dependencies..."
"$PIP" install -r requirements.txt -q
"$PIP" install pyinstaller==6.11.1 -q

# Local LLM backend. Without this wheel, the spec's `try: import llama_cpp`
# falls through to `_local_llm_available = False` and the installer ships
# unable to run Local mode (ModuleNotFoundError, observed in v0.7.0). Always
# install unless LULLMAIL_SKIP_LOCAL=1 explicitly opts into an OpenAI-only build.
if [[ "${LULLMAIL_SKIP_LOCAL:-0}" != "1" ]]; then
    echo "[2/4] Local backend llama-cpp-python (CPU wheel)..."
    "$PIP" install -r requirements-local.txt -q \
        --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu
else
    echo "[2/4] LULLMAIL_SKIP_LOCAL=1, skipping local backend."
fi

# ── PyInstaller build ─────────────────────────────────────────────────────────
echo "[3/4] Building with PyInstaller (may take 1-2 min)..."
rm -rf build dist
# Unless explicit opt-out, force the spec to abort if llama_cpp is missing.
# Avoids shipping another broken installer like v0.7.0.
if [[ "${LULLMAIL_SKIP_LOCAL:-0}" != "1" ]]; then
    export LULLMAIL_REQUIRE_LOCAL=1
fi
"$PYINSTALLER" lull_mail.spec --noconfirm --clean

# ── Verify output ─────────────────────────────────────────────────────────────
echo "[4/4] Verifying output..."
if [[ ! -f "dist/LullMail/LullMail" ]]; then
    echo "[ERREUR] dist/LullMail/LullMail not found after build."
    exit 1
fi
# Guard against the silent-skip failure mode that produced the broken v0.7.0
# installer: if local backend was requested, llama_cpp MUST be in the bundle.
if [[ "${LULLMAIL_SKIP_LOCAL:-0}" != "1" ]]; then
    if [[ ! -d "dist/LullMail/_internal/llama_cpp" \
       && ! -d "dist/LullMail.app/Contents/Frameworks/llama_cpp" ]]; then
        echo "[ERREUR] llama_cpp absent du bundle."
        echo "Verifie que requirements-local.txt a bien installe llama-cpp-python."
        exit 1
    fi
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
