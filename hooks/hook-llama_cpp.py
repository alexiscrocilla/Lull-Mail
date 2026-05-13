# SPDX-License-Identifier: GPL-3.0-or-later
"""
PyInstaller hook for llama-cpp-python.

Captures three layers the default PyInstaller import scanner misses:

  1. Native shared libraries (libllama.dll on Windows, libllama.dylib on
     macOS, libllama.so on Linux) shipped under llama_cpp/lib/. The wheel
     loads them via ctypes at runtime, so the static scanner does not see
     them. `collect_dynamic_libs` walks the package and pulls them in.

  2. Data files. On macOS, the Metal shader source `ggml-metal.metal` is
     looked up by libllama at GPU-init time — without it, Metal silently
     falls back to CPU. `collect_data_files` grabs it (and any future
     resource the upstream wheel adds).

  3. Optional subpackages used by `llama_cpp.server`. PyInstaller only
     sees imports it can statically trace from the smoke entrypoint, so
     anything pulled in lazily by the server (sse_starlette, pydantic-
     settings, starlette_context for streaming + config) must be listed
     explicitly.

Reference:
  - llama-cpp-python PR #709 (community-validated hook pattern)
  - PyInstaller docs §"Understanding PyInstaller Hooks"

This file is enabled by adding `--additional-hooks-dir=hooks` to the
PyInstaller invocation, or `hookspath=['hooks']` in lull_mail.spec.
"""

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_dynamic_libs

# Native libllama + every other dynamic library that ships in the wheel.
binaries = collect_dynamic_libs("llama_cpp")

# ggml-metal.metal on macOS, any future grammar files, etc.
datas = collect_data_files("llama_cpp")

# numpy 2.x renamed its private internals from numpy.core to numpy._core.
# PyInstaller's stock hook for numpy doesn't always pick up the new
# submodule tree (e.g. numpy._core._exceptions), which then crashes the
# frozen app with ImportError at numpy load time. We belt-and-suspender
# with collect_all here so every numpy submodule, native .pyd / .so, and
# data file lands in the bundle. Only triggered when llama_cpp is on
# (i.e., when the local LLM backend is enabled), since the OpenAI-only
# build doesn't import numpy anywhere.
_numpy_datas, _numpy_binaries, _numpy_hidden = collect_all("numpy")
datas += _numpy_datas
binaries += _numpy_binaries

# Lazy imports the server side pulls in. Bundling these keeps the smoke
# test (and the eventual src/llm/server.py) importable in the frozen exe.
#
# numpy is pulled by llama_cpp.llama_chat_format at module import time.
# Declaring it explicitly here belts-and-suspenders the unexclusion in
# lull_mail.spec — if a future refactor drops numpy from excludes by
# accident, the hook still keeps it bundled.
hiddenimports = [
    "llama_cpp",
    "llama_cpp._C",
    "llama_cpp.server",
    "llama_cpp.server.app",
    "llama_cpp.server.settings",
    "uvicorn",
    "fastapi",
    "sse_starlette",
    "sse_starlette.sse",
    "pydantic_settings",
    "starlette_context",
] + _numpy_hidden
