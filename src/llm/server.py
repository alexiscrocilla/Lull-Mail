# SPDX-License-Identifier: GPL-3.0-or-later
"""
Supervisor de subprocess `llama_cpp.server` (un par modèle actif).

Deux serveurs distincts en runtime :
  - `AnalyzerServer` : démarré au boot de `lifecycle.start_email_services`
    si `cfg.llm.provider == "local"`. Reste en RAM en permanence.
  - `DrafterServer`  : lazy. Démarre à la première requête `enrich_draft`,
    déchargé après `cfg.llm.local.drafter_idle_timeout_min` minutes
    d'inactivité (default 5 min). Permet aux machines Light de ne pas
    payer la RAM du Drafter quand il ne sert pas.

Patterns réutilisés :
  - `_pick_ephemeral_port()` copié de `app_gui.py:142-154` (le port LLM
    est interne au process — pas besoin de stabilité entre redémarrages).
  - `_wait_for_port()` copié de `app_gui.py:127-139` (healthcheck TCP +
    HTTP `/v1/models`).
  - `secrets.token_urlsafe(32)` pour générer un token API par session :
    chaque serveur est lancé avec `--api-key <token>`. `LocalLLMProvider`
    récupère le token via `server.api_key` en mémoire — pas de fichier
    sur disque, pas de keyring (cycle de vie = vie du process app).
    Ferme la surface attack sur les autres processus locaux (notamment
    Windows multi-session).

Frozen exe : `python -m llama_cpp.server` ne fonctionne pas dans un
binaire PyInstaller (pas de `-m`). Phase 2D ajoutera un sous-mode au
main de l'exe (`LullMail.exe --serve-llm <model>`) qui re-démarre le
serveur in-process. Phase 2B (ce module) cible le mode dev où on a un
interpréteur Python complet.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.error import URLError
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers TCP — réutilisent volontairement le pattern de app_gui.py pour
# rester homogène avec le supervisor uvicorn principal.
# ─────────────────────────────────────────────────────────────────────────────


def _pick_ephemeral_port() -> int:
    """Demande à l'OS un port TCP libre sur la loopback. Identique à
    `app_gui._pick_ephemeral_port`."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _wait_for_port(host: str, port: int, timeout: float = 60.0) -> bool:
    """Bloque jusqu'à ce que le serveur accepte des connexions TCP."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.5)
                s.connect((host, port))
                return True
        except OSError:
            time.sleep(0.2)
    return False


def _http_get_models(url: str, api_key: str, timeout: float = 5.0) -> Optional[Dict[str, Any]]:
    """Healthcheck HTTP : `GET /v1/models` avec auth.
    Renvoie None si pas de réponse 2xx ou si JSON invalide."""
    req = Request(f"{url}/v1/models",
                  headers={"Authorization": f"Bearer {api_key}"})
    try:
        with urlopen(req, timeout=timeout) as resp:
            if resp.status >= 300:
                return None
            return json.loads(resp.read())
    except (URLError, json.JSONDecodeError, OSError):
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Le supervisor lui-même.
# ─────────────────────────────────────────────────────────────────────────────


class LLMServerError(RuntimeError):
    """Pour signaler une panne du serveur (modèle introuvable, port pris,
    timeout au démarrage). Message destiné à `lifecycle.py` qui décide
    de retomber en mode no-AI ou de propager l'erreur à l'UI."""


@dataclass
class LLMServer:
    """Manager d'un seul subprocess `llama_cpp.server`.

    Usage typique :
        srv = LLMServer(model_path=Path('.../phi-3.5.gguf'), n_ctx=4096, n_threads=6)
        srv.start()                       # bloque jusqu'au healthcheck OK
        url = srv.base_url                # 'http://127.0.0.1:51234'
        token = srv.api_key
        ...
        srv.stop()

    Sous le capot :
      - subprocess.Popen sur `python -m llama_cpp.server ...`
      - chaque serveur écoute sur un port éphémère + génère un token
      - thread daemon qui surveille la sortie stderr/stdout pour les
        logs (sinon llama_cpp.server inonde le terminal en dev)
      - `stop()` envoie SIGTERM puis SIGKILL après 5s si récalcitrant ;
        Windows reçoit `process.terminate()` qui appelle TerminateProcess
    """

    model_path: Path
    n_ctx: int = 4096
    n_threads: int = 6
    host: str = "127.0.0.1"
    # Auto-attribué dans `start()` si laissé à 0
    port: int = 0
    # Auto-généré dans __post_init__ pour ne jamais valoir "" par accident
    api_key: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    # Chemin du Python à utiliser pour `-m llama_cpp.server`. None = sys.executable
    python_exe: Optional[str] = None
    # Préfixe pour les logs (`[analyzer]`, `[drafter]`)
    label: str = "llm"

    _proc: Optional[subprocess.Popen] = field(default=None, init=False, repr=False)
    _log_thread: Optional[threading.Thread] = field(default=None, init=False, repr=False)
    _stop_flag: bool = field(default=False, init=False, repr=False)

    # ── Lifecycle ────────────────────────────────────────────────────

    @property
    def base_url(self) -> str:
        """URL OpenAI-compatible à passer à `OpenAI(base_url=...)`."""
        return f"http://{self.host}:{self.port}/v1"

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def start(self, *, ready_timeout: float = 60.0) -> None:
        """Spawn le serveur et bloque jusqu'au healthcheck OK.

        Raises `LLMServerError` en cas de timeout ou de crash immédiat.
        """
        if self.running:
            logger.debug("[%s] already running on :%d", self.label, self.port)
            return

        if not self.model_path.is_file():
            raise LLMServerError(
                f"GGUF introuvable : {self.model_path}. L'utilisateur "
                "doit le télécharger via Settings → IA → Local."
            )

        if self.port == 0:
            self.port = _pick_ephemeral_port()

        py = self.python_exe or sys.executable
        cmd = [
            py, "-m", "llama_cpp.server",
            "--model", str(self.model_path),
            "--host", self.host,
            "--port", str(self.port),
            "--n_ctx", str(self.n_ctx),
            "--n_threads", str(self.n_threads),
            "--api_key", self.api_key,
        ]
        logger.info("[%s] starting subprocess on :%d (model=%s)",
                    self.label, self.port, self.model_path.name)

        # On capture stdout+stderr pour les router vers le logger principal
        # — sinon llama_cpp.server fait des println debug sur le terminal.
        # Sous PyInstaller --windowed, stdout est None ; on capture quand
        # même, ça évite que les writes du subprocess se perdent dans le
        # vide ou plantent l'appel.
        self._proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,  # ligne par ligne
            # Sur Windows, masquer la console du subprocess (sinon une fenêtre
            # CMD s'ouvre brièvement à chaque démarrage).
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

        # Thread qui draine stdout du subprocess pour ne pas bloquer le
        # pipe quand il est plein. Loggue chaque ligne avec le préfixe.
        self._stop_flag = False
        self._log_thread = threading.Thread(
            target=self._drain_logs, name=f"llm-{self.label}-logs", daemon=True,
        )
        self._log_thread.start()

        # Bloque jusqu'à ce que le port soit ouvert.
        if not _wait_for_port(self.host, self.port, timeout=ready_timeout):
            self.stop()
            raise LLMServerError(
                f"[{self.label}] timeout après {ready_timeout:.0f}s — le "
                "serveur n'a pas démarré. Vérifier les logs."
            )

        # Healthcheck applicatif : /v1/models doit répondre 200 avec le
        # token. Détecte un cas où le port est ouvert mais l'app n'a pas
        # fini de charger (modèle plus gros que la RAM, par ex.).
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            data = _http_get_models(f"http://{self.host}:{self.port}", self.api_key)
            if data and data.get("data"):
                logger.info("[%s] healthcheck OK, model loaded", self.label)
                return
            if not self.running:
                raise LLMServerError(f"[{self.label}] subprocess crashed during model load")
            time.sleep(0.5)
        self.stop()
        raise LLMServerError(
            f"[{self.label}] healthcheck timeout — le modèle a pris "
            f"trop de temps à charger (port OK mais /v1/models n'a "
            f"jamais répondu en 30s)"
        )

    def stop(self, *, timeout: float = 5.0) -> None:
        """Arrêt propre : SIGTERM puis SIGKILL si récalcitrant."""
        self._stop_flag = True
        if self._proc is None:
            return
        proc = self._proc
        if proc.poll() is None:
            logger.info("[%s] stopping subprocess", self.label)
            try:
                proc.terminate()  # SIGTERM sur posix, TerminateProcess sur win
            except OSError:
                pass
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                logger.warning("[%s] subprocess didn't respond to terminate, killing",
                               self.label)
                try:
                    proc.kill()
                except OSError:
                    pass
                try:
                    proc.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    pass
        self._proc = None

    # ── Internals ────────────────────────────────────────────────────

    def _drain_logs(self) -> None:
        """Lit le stdout du subprocess ligne par ligne et le re-loggue.
        Tourne dans un thread daemon, sort quand `_stop_flag` est posé."""
        if self._proc is None or self._proc.stdout is None:
            return
        try:
            for line in self._proc.stdout:
                if self._stop_flag:
                    break
                clean = line.rstrip()
                if not clean:
                    continue
                # llama_cpp.server logge en INFO ; on garde le même niveau
                # pour ne pas mentir sur la sévérité réelle.
                logger.info("[%s] %s", self.label, clean)
        except (OSError, ValueError):
            # ValueError = "I/O operation on closed file" si stop() est
            # appelé pendant qu'on est dans le for. C'est attendu, on sort.
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Wrappers sémantiques : AnalyzerServer (always-on) et DrafterServer (lazy).
# Mêmes mécaniques, juste un label différent pour les logs et la stratégie
# d'idle. Le idle-decharge est géré côté `LocalLLMProvider` (Phase 2C) qui
# stamp `_last_used_at` et déclenche `DrafterServer.stop()` quand le
# timeout est dépassé.
# ─────────────────────────────────────────────────────────────────────────────


class AnalyzerServer(LLMServer):
    """Serveur dédié à la classification (Level-3). Démarré au boot
    `lifecycle.start_email_services`. Reste en RAM tant que l'app vit."""

    def __init__(self, model_path: Path, **kwargs: Any) -> None:
        super().__init__(model_path=model_path, label="analyzer", **kwargs)


class DrafterServer(LLMServer):
    """Serveur dédié à la rédaction de brouillon complet (Level-4).
    Lazy : démarré à la première requête `enrich_draft`, déchargé
    après un délai d'inactivité (LocalLLMProvider gère le timer).

    On expose `last_used_at` que le provider met à jour à chaque appel
    pour que la décision de stop soit prise par lui (cohérence single-
    writer).
    """

    last_used_at: float = field(default=0.0, init=False)  # type: ignore[assignment]

    def __init__(self, model_path: Path, **kwargs: Any) -> None:
        super().__init__(model_path=model_path, label="drafter", **kwargs)
        self.last_used_at = 0.0

    def touch(self) -> None:
        """À appeler avant chaque inférence pour décaler le timeout."""
        self.last_used_at = time.monotonic()

    def is_idle(self, *, timeout_min: int) -> bool:
        """True si le serveur tourne mais n'a pas servi depuis
        `timeout_min` minutes. False quand `timeout_min == 0`
        (mode "garder chargé en permanence" pour tier Heavy)."""
        if timeout_min <= 0:
            return False
        if not self.running or self.last_used_at == 0:
            return False
        return (time.monotonic() - self.last_used_at) >= timeout_min * 60
