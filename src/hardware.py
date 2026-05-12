# SPDX-License-Identifier: GPL-3.0-or-later
"""
Détection du matériel local pour dimensionner le LLM embarqué.

Renvoie un dict normalisé que `src/api.py` expose via `GET /api/llm/hardware`
et que `frontend/settings.js` affiche dans le bandeau "Détecté: 16 Go RAM,
pas de GPU → Medium recommandé".

Toutes les détections sont **best-effort** : si `psutil` n'est pas
installé, si `nvidia-smi` n'existe pas, si on est dans une VM bizarre,
on retombe sur des valeurs conservatives. Aucune dépendance n'est dure
— le module se charge même quand le local LLM est désactivé.

Les seuils de tier sont calibrés sur les findings de Phase 0 bis :
  - Light : 8 Go RAM CPU-only — peut faire tourner Phi-3.5-mini Q4
    (~2.4 Go disk, ~4 Go RAM) mais swappe si on charge un Drafter 7B
    en parallèle. → Drafter on-demand uniquement, déchargé après idle.
  - Medium : 12-24 Go RAM — peut garder Analyzer + Drafter 7B chargés
    en alternance sans swap.
  - Heavy : ≥ 24 Go OU Apple Silicon ≥ 16 Go (mémoire unifiée +
    accélération Metal). Drafter 7B peut rester résident en permanence.
"""

from __future__ import annotations

import logging
import platform
import re
import subprocess
import sys
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Cache module-level. La détection est strictement read-only et le matériel
# ne change pas en cours d'exécution — un seul appel suffit pour la vie
# du process. `_reset_for_tests` permet aux tests unitaires de remocker.
_cache: Optional[Dict[str, Any]] = None


def _detect_ram_gb() -> float:
    """RAM totale en Go (binaire, 1024**3). Retombe sur 8.0 conservatif
    si psutil n'est pas dispo (jamais le cas en prod — psutil est dans
    requirements.txt — mais permet d'importer ce module en tests sans
    installer la dep)."""
    try:
        import psutil
    except ImportError:
        logger.warning("psutil indisponible — RAM estimée à 8 Go (default)")
        return 8.0
    return round(psutil.virtual_memory().total / (1024 ** 3), 1)


def _detect_cpu_cores() -> int:
    """Nombre de cœurs logiques (physiques + hyperthreading).

    `psutil.cpu_count(logical=True)` est plus fiable que `os.cpu_count()`
    sur certaines plateformes virtualisées.
    """
    try:
        import psutil
        n = psutil.cpu_count(logical=True)
        if n:
            return int(n)
    except ImportError:
        pass
    import os
    return max(1, os.cpu_count() or 1)


def _detect_nvidia_gpu() -> Optional[Dict[str, Any]]:
    """Interroge `nvidia-smi` pour récupérer le nom + VRAM du premier GPU.
    Retourne None si nvidia-smi n'existe pas, retourne >=1 erreur, ou ne
    liste aucun GPU. Pas de dépendance Python : on parle au binaire système.
    """
    try:
        proc = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    if proc.returncode != 0:
        return None
    line = proc.stdout.strip().splitlines()[0] if proc.stdout.strip() else ""
    if not line:
        return None
    # Format attendu : "NVIDIA GeForce RTX 4090, 24576"
    parts = [p.strip() for p in line.split(",")]
    if len(parts) < 2:
        return None
    name = parts[0]
    try:
        vram_mb = int(parts[1])
    except ValueError:
        # Certains drivers renvoient "[N/A]" en virtualisation
        return {"name": name, "vram_gb": 0}
    return {"name": name, "vram_gb": round(vram_mb / 1024, 1)}


def _detect_apple_silicon() -> bool:
    """True si macOS sur architecture ARM (M1/M2/M3/M4). Metal y est
    automatiquement activé par llama.cpp — gros gain de latence sans
    config additionnelle."""
    return sys.platform == "darwin" and platform.machine().lower() in ("arm64", "aarch64")


def _classify_platform() -> str:
    if sys.platform == "win32":
        return "win"
    if sys.platform == "darwin":
        return "mac"
    return "linux"


def _recommended_tier(ram_gb: float, has_nvidia: bool, vram_gb: float,
                      is_apple_silicon: bool) -> str:
    """Mappe la config détectée → tier d'exécution recommandé.

    En v1, l'inférence tourne en CPU-only par défaut (`gpu_layers=0`
    dans `LocalLLMConfig` ; la wheel CUDA est opt-in v2). Donc un GPU
    NVIDIA détecté ne contribue PAS à la capacité réelle — la RAM
    système est la seule contrainte qui compte. Recommander "heavy"
    à un user avec 8 Go RAM + RTX 4090 reviendrait à le pousser vers
    un modèle 7B qui swappera à mort sur sa RAM système.

    Exception Apple Silicon : Metal est activé automatiquement par
    llama.cpp + la mémoire est unifiée CPU/GPU. Un M2 16 Go peut donc
    réellement faire tourner un 7B sans saturer la RAM.

    Logique :
      - Apple Silicon ≥ 16 Go (mémoire unifiée + Metal gratuit)        → heavy
      - 24 Go RAM système ou plus                                       → heavy
      - 12-23 Go RAM système                                            → medium
      - < 12 Go RAM système (le cas typique laptop 8 Go)                → light

    Le champ `gpu` (nom du GPU NVIDIA) reste exposé dans le snapshot
    de `detect()` pour information — le frontend peut afficher
    "RTX 4060 Ti détectée (mode CPU)" mais ne doit PAS s'en servir
    pour pousser un modèle plus gros.
    """
    if is_apple_silicon and ram_gb >= 16:
        return "heavy"
    if ram_gb >= 24:
        return "heavy"
    if ram_gb < 12:
        return "light"
    return "medium"


def detect(*, force: bool = False) -> Dict[str, Any]:
    """Renvoie un snapshot complet de la config hardware.

    Forme du dict (champs stables — exposés à l'API frontend) :
      ram_gb              : float, total RAM en Go
      cpu_cores           : int, cœurs logiques
      gpu                 : str ou None, nom du GPU NVIDIA si présent
      vram_gb             : float, VRAM en Go (0 si pas de GPU)
      platform            : "win" | "mac" | "linux"
      is_apple_silicon    : bool
      recommended_tier    : "light" | "medium" | "heavy"

    `force=True` ignore le cache (utile en tests). En prod, la détection
    est cachée pour la durée du process : la RAM ou le GPU ne changent
    pas en cours d'exécution.
    """
    global _cache
    if _cache is not None and not force:
        return _cache

    ram_gb = _detect_ram_gb()
    cpu_cores = _detect_cpu_cores()
    apple_silicon = _detect_apple_silicon()
    gpu_info = _detect_nvidia_gpu()
    gpu_name = gpu_info["name"] if gpu_info else None
    vram_gb = gpu_info["vram_gb"] if gpu_info else 0.0
    tier = _recommended_tier(
        ram_gb=ram_gb,
        has_nvidia=gpu_info is not None,
        vram_gb=vram_gb,
        is_apple_silicon=apple_silicon,
    )

    _cache = {
        "ram_gb": ram_gb,
        "cpu_cores": cpu_cores,
        "gpu": gpu_name,
        "vram_gb": vram_gb,
        "platform": _classify_platform(),
        "is_apple_silicon": apple_silicon,
        "recommended_tier": tier,
    }
    return _cache


def _reset_for_tests() -> None:
    """Vide le cache. Utilisé exclusivement par les tests unitaires."""
    global _cache
    _cache = None
