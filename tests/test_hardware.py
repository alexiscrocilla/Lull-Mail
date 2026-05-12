# SPDX-License-Identifier: GPL-3.0-or-later
"""Unit tests for `src.hardware`. Mocks psutil + nvidia-smi to verify
the tier-recommendation logic doesn't drift."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from src import hardware


@pytest.fixture(autouse=True)
def _reset_cache():
    """Vide le cache module-level entre chaque test pour éviter les
    interférences."""
    hardware._reset_for_tests()
    yield
    hardware._reset_for_tests()


# ─────────────────────────────────────────────────────────────────────────────
# Tier mapping — cas attendus issus du plan (data/hazy-nibbling-sphinx.md)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("ram_gb, has_nvidia, vram_gb, apple_silicon, expected", [
    # Light tier
    (8, False, 0, False, "light"),       # laptop modeste Windows
    (8, False, 0, True, "light"),        # M1 8 Go — Apple Silicon mais peu de RAM
    (11.9, False, 0, False, "light"),    # juste sous le seuil 12 Go
    # Medium tier
    (12, False, 0, False, "medium"),     # pile au seuil
    (16, False, 0, False, "medium"),
    (23.9, False, 0, False, "medium"),
    # Heavy tier
    (24, False, 0, False, "heavy"),      # gros desktop CPU-only
    (32, False, 0, False, "heavy"),
    (16, False, 0, True, "heavy"),       # M2 16 Go — mémoire unifiée
    (32, True, 24, False, "heavy"),      # RTX 4090
    (16, True, 8, False, "heavy"),       # RAM medium mais GPU costaud → Heavy
    (8, True, 12, False, "heavy"),       # même RAM faible : GPU 12 Go porte le 7B
])
def test_recommended_tier_mapping(ram_gb, has_nvidia, vram_gb, apple_silicon, expected):
    assert hardware._recommended_tier(ram_gb, has_nvidia, vram_gb, apple_silicon) == expected


# ─────────────────────────────────────────────────────────────────────────────
# Full detect() — patch psutil + subprocess + platform
# ─────────────────────────────────────────────────────────────────────────────


def _fake_psutil(ram_bytes, cpu_count):
    """Construit un faux module psutil pour le monkey-patcher dans `_detect_*`."""
    fake = MagicMock()
    fake.virtual_memory.return_value = MagicMock(total=ram_bytes)
    fake.cpu_count.return_value = cpu_count
    return fake


def test_detect_full_windows_16gb_no_gpu(monkeypatch):
    """Cas Windows 16 Go CPU-only → tier Medium."""
    fake = _fake_psutil(ram_bytes=16 * 1024**3, cpu_count=8)
    monkeypatch.setitem(__import__("sys").modules, "psutil", fake)
    monkeypatch.setattr(hardware, "_detect_nvidia_gpu", lambda: None)
    monkeypatch.setattr(hardware.sys, "platform", "win32")
    monkeypatch.setattr(hardware.platform, "machine", lambda: "AMD64")

    snap = hardware.detect(force=True)
    assert snap["ram_gb"] == 16.0
    assert snap["cpu_cores"] == 8
    assert snap["gpu"] is None
    assert snap["vram_gb"] == 0.0
    assert snap["platform"] == "win"
    assert snap["is_apple_silicon"] is False
    assert snap["recommended_tier"] == "medium"


def test_detect_full_apple_silicon_m2_16gb(monkeypatch):
    """M2 16 Go → Heavy (mémoire unifiée + Metal automatique)."""
    fake = _fake_psutil(ram_bytes=16 * 1024**3, cpu_count=8)
    monkeypatch.setitem(__import__("sys").modules, "psutil", fake)
    monkeypatch.setattr(hardware, "_detect_nvidia_gpu", lambda: None)
    monkeypatch.setattr(hardware.sys, "platform", "darwin")
    monkeypatch.setattr(hardware.platform, "machine", lambda: "arm64")

    snap = hardware.detect(force=True)
    assert snap["platform"] == "mac"
    assert snap["is_apple_silicon"] is True
    assert snap["recommended_tier"] == "heavy"


def test_detect_full_nvidia_rtx_4090(monkeypatch):
    """Linux + RTX 4090 24 Go → Heavy peu importe la RAM."""
    fake = _fake_psutil(ram_bytes=32 * 1024**3, cpu_count=16)
    monkeypatch.setitem(__import__("sys").modules, "psutil", fake)
    monkeypatch.setattr(
        hardware, "_detect_nvidia_gpu",
        lambda: {"name": "NVIDIA GeForce RTX 4090", "vram_gb": 24.0},
    )
    monkeypatch.setattr(hardware.sys, "platform", "linux")
    monkeypatch.setattr(hardware.platform, "machine", lambda: "x86_64")

    snap = hardware.detect(force=True)
    assert snap["gpu"] == "NVIDIA GeForce RTX 4090"
    assert snap["vram_gb"] == 24.0
    assert snap["recommended_tier"] == "heavy"


def test_detect_full_light_tier_8gb_cpu(monkeypatch):
    """Laptop modeste 8 Go CPU-only → Light."""
    fake = _fake_psutil(ram_bytes=8 * 1024**3, cpu_count=4)
    monkeypatch.setitem(__import__("sys").modules, "psutil", fake)
    monkeypatch.setattr(hardware, "_detect_nvidia_gpu", lambda: None)
    monkeypatch.setattr(hardware.sys, "platform", "win32")
    monkeypatch.setattr(hardware.platform, "machine", lambda: "AMD64")

    snap = hardware.detect(force=True)
    assert snap["recommended_tier"] == "light"


def test_detect_returns_cached_result(monkeypatch):
    """Deuxième appel sans `force` doit retourner le cache, pas re-mesurer."""
    fake = _fake_psutil(ram_bytes=16 * 1024**3, cpu_count=8)
    monkeypatch.setitem(__import__("sys").modules, "psutil", fake)
    monkeypatch.setattr(hardware, "_detect_nvidia_gpu", lambda: None)

    snap1 = hardware.detect(force=True)
    # Change le mock après le premier appel — un cache fonctionnel doit
    # ignorer ce changement.
    fake.virtual_memory.return_value = MagicMock(total=32 * 1024**3)
    snap2 = hardware.detect()
    assert snap1 is snap2  # même objet, prouve le cache


# ─────────────────────────────────────────────────────────────────────────────
# Robustesse — pas de psutil installé, pas de nvidia-smi
# ─────────────────────────────────────────────────────────────────────────────


def test_detect_ram_fallback_when_psutil_missing(monkeypatch):
    """Si psutil ne s'importe pas, retombe sur 8 Go conservatif."""
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "psutil":
            raise ImportError("simulated")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    assert hardware._detect_ram_gb() == 8.0


def test_detect_nvidia_gpu_returns_none_when_smi_missing(monkeypatch):
    """`nvidia-smi` absent → None, pas d'exception."""
    monkeypatch.setattr(
        hardware.subprocess, "run",
        MagicMock(side_effect=FileNotFoundError("nvidia-smi not found")),
    )
    assert hardware._detect_nvidia_gpu() is None


def test_detect_nvidia_gpu_parses_output(monkeypatch):
    """Format attendu : `name, vram_mb` séparés par virgule."""
    fake_proc = MagicMock(returncode=0, stdout="NVIDIA GeForce RTX 3060, 12288\n")
    monkeypatch.setattr(hardware.subprocess, "run", MagicMock(return_value=fake_proc))
    gpu = hardware._detect_nvidia_gpu()
    assert gpu == {"name": "NVIDIA GeForce RTX 3060", "vram_gb": 12.0}


def test_detect_nvidia_gpu_handles_na_vram(monkeypatch):
    """Driver virtualisé peut renvoyer `[N/A]` → vram_gb=0 et name préservé."""
    fake_proc = MagicMock(returncode=0, stdout="vGPU shared, [N/A]\n")
    monkeypatch.setattr(hardware.subprocess, "run", MagicMock(return_value=fake_proc))
    gpu = hardware._detect_nvidia_gpu()
    assert gpu == {"name": "vGPU shared", "vram_gb": 0}
