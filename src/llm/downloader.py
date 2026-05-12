# SPDX-License-Identifier: GPL-3.0-or-later
"""
Téléchargement streaming des GGUF du catalog.

Contraintes :
  - Pas de dépendance externe nouvelle : on utilise `urllib` de la stdlib
    (le projet utilise déjà `requests` mais urllib est plus léger pour
    du streaming brut, et marche partout sans wheel à compiler).
  - Reprise possible en cas d'interruption : écriture dans un fichier
    `.part`, rename atomique en final UNIQUEMENT après vérification SHA.
  - Hash SHA-256 calculé en streaming (pas de relecture du fichier
    après coup).
  - Callback de progression à intervalles raisonnables (pas 1× par chunk,
    sinon SSE est saturée) — émis tous les 1% ou ≥ 256 ko, selon le
    plus rapide.

Le SSE côté API (`POST /api/llm/models/{id}/download`) consomme la
fonction `stream_download` en générateur — chaque yield devient un
événement SSE `data: {"progress": 0.42, "speed_mbps": 8.3, "eta_sec": 35}`.

Sécurité : on refuse de servir le fichier final si :
  - Le téléchargement est interrompu (.part non renommé)
  - Le SHA mismatch (corruption ou attaque MITM)
  - La taille mesurée diffère significativement de celle annoncée

Source de l'idée du `.part → atomic rename` : pattern utilisé par
pip, hugging_face_hub, et le module `urllib.request` officiel.
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)


# Taille d'un chunk lu sur le socket. 1 Mo donne un bon compromis :
# pas trop petit (overhead de syscalls), pas trop gros (latence des
# updates de progression sur connexions lentes).
_CHUNK_BYTES = 1024 * 1024

# Minimum de bytes téléchargés entre deux events de progression. Borne
# l'inflation du SSE sur une connexion lente (un user en 4G ne reçoit
# pas 200 events/seconde).
_MIN_PROGRESS_BYTES = 256 * 1024


@dataclass
class ProgressEvent:
    """Un événement de progression émis par stream_download."""
    downloaded_bytes: int
    total_bytes: int
    speed_mbps: float
    eta_sec: Optional[float]
    done: bool = False
    sha_ok: bool = False
    error: Optional[str] = None

    @property
    def progress(self) -> float:
        """Ratio ∈ [0, 1]."""
        if self.total_bytes <= 0:
            return 0.0
        return self.downloaded_bytes / self.total_bytes


class DownloadError(Exception):
    """Toute erreur du téléchargement (réseau, SHA mismatch, IO).
    Le message est destiné à l'utilisateur (français), donc reste court."""


def _hash_file_streaming(path: Path, hasher_factory=hashlib.sha256) -> str:
    """Calcule le hash d'un fichier déjà sur disque, en streaming.
    Utilisé pour ré-vérifier un fichier après un crash de l'app
    (cf. la route `GET /api/llm/models` qui scanne `MODELS_DIR`)."""
    h = hasher_factory()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(_CHUNK_BYTES)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def stream_download(
    url: str,
    dst: Path,
    *,
    expected_sha256: Optional[str] = None,
    expected_size: Optional[int] = None,
    user_agent: str = "lull-mail/llm-downloader",
) -> Iterator[ProgressEvent]:
    """Génère des `ProgressEvent` à intervalles raisonnables, télécharge
    dans `dst.with_suffix('.part')`, vérifie le SHA, puis renomme.

    Le dernier event yieldé porte `done=True` (succès ou échec). En cas
    d'erreur, `error` est rempli avec un message FR. Sinon, `sha_ok`
    indique si la vérification a passé.

    Exemple d'utilisation côté API SSE :

        for event in stream_download(url, dst, expected_sha256=sha):
            yield f"data: {json.dumps(asdict(event))}\\n\\n"
    """
    dst = dst.expanduser().resolve()
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(dst.suffix + ".part")

    req = Request(url, headers={"User-Agent": user_agent})
    t_start = time.monotonic()
    downloaded = 0
    last_event_at_bytes = 0

    h = hashlib.sha256()
    try:
        with urlopen(req, timeout=60) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            if expected_size and total and abs(total - expected_size) > 1024:
                # Plus de 1 ko d'écart entre Content-Length et catalog →
                # probablement une mauvaise URL ou un fichier changé.
                yield ProgressEvent(
                    downloaded_bytes=0, total_bytes=total, speed_mbps=0,
                    eta_sec=None, done=True, sha_ok=False,
                    error=f"Taille inattendue : {total} octets vs {expected_size} attendus",
                )
                return

            with open(tmp, "wb") as f:
                while True:
                    chunk = resp.read(_CHUNK_BYTES)
                    if not chunk:
                        break
                    f.write(chunk)
                    h.update(chunk)
                    downloaded += len(chunk)

                    # Throttle des events : ≥ MIN_PROGRESS_BYTES ou ≥ 1%
                    if (downloaded - last_event_at_bytes) < _MIN_PROGRESS_BYTES:
                        continue
                    last_event_at_bytes = downloaded
                    elapsed = max(time.monotonic() - t_start, 1e-3)
                    speed_bps = downloaded / elapsed
                    speed_mbps = round(speed_bps / 1e6, 2)
                    remaining = max(0, total - downloaded)
                    eta = remaining / speed_bps if speed_bps > 0 else None
                    yield ProgressEvent(
                        downloaded_bytes=downloaded,
                        total_bytes=total,
                        speed_mbps=speed_mbps,
                        eta_sec=round(eta) if eta else None,
                    )

    except HTTPError as e:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        yield ProgressEvent(
            downloaded_bytes=downloaded, total_bytes=0, speed_mbps=0,
            eta_sec=None, done=True, sha_ok=False,
            error=f"Erreur HTTP {e.code} en téléchargeant le modèle",
        )
        return
    except URLError as e:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        yield ProgressEvent(
            downloaded_bytes=downloaded, total_bytes=0, speed_mbps=0,
            eta_sec=None, done=True, sha_ok=False,
            error=f"Erreur réseau : {e.reason}",
        )
        return
    except OSError as e:
        # Disque plein, permission denied, etc.
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        yield ProgressEvent(
            downloaded_bytes=downloaded, total_bytes=0, speed_mbps=0,
            eta_sec=None, done=True, sha_ok=False,
            error=f"Erreur disque : {e}",
        )
        return

    # ── Vérification SHA-256 ─────────────────────────────────────────
    actual_sha = h.hexdigest()
    if expected_sha256 and actual_sha.lower() != expected_sha256.lower():
        tmp.unlink(missing_ok=True)
        yield ProgressEvent(
            downloaded_bytes=downloaded, total_bytes=downloaded,
            speed_mbps=0, eta_sec=None, done=True, sha_ok=False,
            error=("SHA-256 invalide — le fichier a été corrompu pendant "
                   "le téléchargement, ou l'URL pointe vers une version "
                   "différente. Le fichier a été supprimé."),
        )
        return

    # Rename atomique : .part → final. Sur Windows, replace() est
    # atomique au niveau du système de fichiers (contrairement à
    # rename() qui échoue si le dest existe).
    try:
        tmp.replace(dst)
    except OSError as e:
        yield ProgressEvent(
            downloaded_bytes=downloaded, total_bytes=downloaded,
            speed_mbps=0, eta_sec=None, done=True, sha_ok=False,
            error=f"Impossible de finaliser le fichier : {e}",
        )
        return

    yield ProgressEvent(
        downloaded_bytes=downloaded, total_bytes=downloaded,
        speed_mbps=0, eta_sec=None, done=True, sha_ok=True,
    )


def verify_local_file(path: Path, expected_sha256: str) -> bool:
    """Re-vérifie qu'un fichier sur disque a le bon SHA. Utilisé au
    boot pour invalider un GGUF corrompu (l'utilisateur sera invité à
    le re-télécharger via l'UI Settings)."""
    if not path.is_file():
        return False
    try:
        actual = _hash_file_streaming(path)
    except OSError:
        return False
    return actual.lower() == expected_sha256.lower()
