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

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

# Native libllama + every other dynamic library that ships in the wheel.
binaries = collect_dynamic_libs("llama_cpp")

# ggml-metal.metal on macOS, any future grammar files, etc.
datas = collect_data_files("llama_cpp")

# Lazy imports the server side pulls in. Bundling these keeps the smoke
# test (and the eventual src/llm/server.py) importable in the frozen exe.
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
]
