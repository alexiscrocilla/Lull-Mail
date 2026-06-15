# SPDX-License-Identifier: GPL-3.0-or-later
"""
Backend LLM local — `llama_cpp.server` + Phi-3.5-mini + score dérivé.

Branché quand `cfg.llm.provider == "local"` via `src.llm.registry.get_provider`.

Architecture validée en Phase 0 bis (cf. `data/phase0_bis_summary.md`) :
  - 70% des emails absorbés par `src.local_classifier` (rules) avant
    d'atteindre ce provider. Cette part est gérée côté `scheduler.py`
    qui appelle `local_classify(em)` AVANT `process_email(em)`.
  - Les 30% restants passent par ce provider : prompt sans CoT
    + JSON Schema strict + logprobs activés + score dérivé côté Python.
  - `enrich_draft` utilise un second serveur (DrafterServer) chargé à
    la demande, déchargé après idle timeout.

Latence observée en Phase 0 bis : ~13 s/email sur i5-13600K 14-cœurs
avec Phi-3.5-mini Q4 + n_ctx=4096. Acceptable pour une sync de fond
(les emails atterrissent dans la DB en quelques secondes après
réception ; le traitement IA peut être asynchrone).
"""

from __future__ import annotations

import json
import logging
import math
import time
from pathlib import Path
from typing import Any, Dict, Optional

from openai import OpenAI

from src import paths
from src.llm import catalog as _catalog
from src.llm import prompts_local as plocal
from src.llm.base import LLMProvider, validate_classification_result
from src.llm.server import AnalyzerServer, DrafterServer, LLMServerError

logger = logging.getLogger(__name__)


class LocalLLMProvider(LLMProvider):
    """Implémentation locale du `LLMProvider`. Délègue les inférences à
    deux serveurs `llama_cpp.server` subprocessus séparés.

    Public state :
      - `analyzer_server` : `AnalyzerServer` ou None tant que `init()`
                            n'a pas été appelé avec succès.
      - `drafter_server`  : `DrafterServer` ou None. Lazy : créé à la
                            première `enrich_draft`.
      - `analyzer_model_id` / `drafter_model_id` : id du catalog actif.

    Les clients OpenAI sont créés à la volée parce que le port d'un
    serveur n'est connu qu'après `server.start()`.
    """

    name = "local"

    def __init__(self) -> None:
        self.analyzer_server: Optional[AnalyzerServer] = None
        self.drafter_server: Optional[DrafterServer] = None
        self.analyzer_model_id: Optional[str] = None
        self.drafter_model_id: Optional[str] = None
        self._drafter_idle_timeout_min: int = 5
        self._analyzer_client: Optional[OpenAI] = None
        self._drafter_client: Optional[OpenAI] = None

    # ── Lifecycle ────────────────────────────────────────────────────

    def init(self, **kwargs: Any) -> None:
        """Idempotent. Lit la config et démarre l'analyzer si nécessaire.

        Le drafter reste lazy — il sera démarré au premier
        `enrich_draft`. Le démarrage de l'analyzer peut prendre 15-30 s
        (chargement du modèle en RAM) : c'est volontairement bloquant
        pour que `lifecycle.start_email_services` puisse signaler une
        panne propre à l'UI (vs. un sync qui plante 2 min plus tard).

        Si l'analyzer GGUF n'est pas téléchargé, lève `LLMServerError` —
        `lifecycle.py` doit retomber sur le mode no-AI dans ce cas.
        """
        # Lazy import pour éviter le cycle config → llm → config.
        from src import config as cfg

        conf = cfg.get()
        local_cfg = (conf.get("llm") or {}).get("local") or {}
        analyzer_id = local_cfg.get("analyzer_model_id", "phi-3.5-mini-q4")
        drafter_id = local_cfg.get("drafter_model_id", "mistral-7b-v03-q4")
        ctx = local_cfg.get("context_size", 4096)
        n_threads = local_cfg.get("n_threads", 6)
        self._drafter_idle_timeout_min = int(local_cfg.get("drafter_idle_timeout_min", 5))

        # ── Analyzer : démarrage immédiat ────────────────────────────
        analyzer_meta = _catalog.get_model(analyzer_id)
        if analyzer_meta is None:
            raise LLMServerError(
                f"Modèle analyzer inconnu : {analyzer_id!r}. "
                "Vérifier `src/llm/catalog.py`."
            )
        analyzer_path = paths.MODELS_DIR / analyzer_meta["filename"]
        if not analyzer_path.is_file():
            raise LLMServerError(
                f"Le GGUF de l'analyzer n'est pas téléchargé "
                f"({analyzer_path}). Aller dans Settings → IA → Local."
            )

        # Si déjà initialisé sur le même modèle, no-op.
        if (self.analyzer_server and self.analyzer_server.running
                and self.analyzer_model_id == analyzer_id):
            logger.info("[LocalLLM] analyzer déjà démarré sur %s", analyzer_id)
        else:
            # Reload : on arrête l'ancien si modèle différent.
            if self.analyzer_server is not None:
                self.analyzer_server.stop()
            # gpu_layers > 0 nécessite la wheel CUDA de llama-cpp-python
            # installée séparément (`--extra-index-url .../whl/cu121`).
            # Avec la wheel CPU, le flag est ignoré sans casser.
            gpu_layers = int(local_cfg.get("gpu_layers", 0))
            self.analyzer_server = AnalyzerServer(
                model_path=analyzer_path,
                n_ctx=ctx,
                n_threads=n_threads,
                n_gpu_layers=gpu_layers,
            )
            self.analyzer_server.start()
            self.analyzer_model_id = analyzer_id

        self._analyzer_client = OpenAI(
            base_url=self.analyzer_server.base_url,
            api_key=self.analyzer_server.api_key,
        )

        # ── Drafter : on mémorise juste le modèle voulu, pas démarré ──
        self.drafter_model_id = drafter_id

    def chat_endpoint(self) -> tuple:
        """The always-on analyzer server is OpenAI-compatible — reuse it for
        the extras (injection scan, draft verify, agent) so they run locally."""
        if self._analyzer_client is None:
            return None, None
        return self._analyzer_client, (self.analyzer_model_id or "local")

    def stop(self) -> None:
        """Arrête les deux serveurs proprement. Appelé par
        `lifecycle.stop_email_services` au shutdown app."""
        if self.analyzer_server is not None:
            self.analyzer_server.stop()
            self.analyzer_server = None
        if self.drafter_server is not None:
            self.drafter_server.stop()
            self.drafter_server = None
        self._analyzer_client = None
        self._drafter_client = None

    # ── Classification (Level-3) ─────────────────────────────────────

    def process_email(self, data: Dict[str, Any], model: str = "local") -> Optional[Dict[str, Any]]:
        """Classification avec Phi-3.5-mini-q4 (ou autre selon catalog).

        Renvoie le dict normalisé attendu par `db.update_email_ai` :
          category, importance_score, importance_reason, summary,
          needs_reply, draft_response (None à ce stade), tokens_in/out,
          analyzed_by.

        Renvoie None en cas d'échec récupérable — le scheduler retentera
        jusqu'à 3 fois avant d'abandonner.
        """
        if not self._analyzer_client or not self.analyzer_server:
            logger.error("[LocalLLM] analyzer non initialisé — appel ignoré")
            return None
        if not self.analyzer_server.running:
            logger.error("[LocalLLM] analyzer crashed — tentative de redémarrage")
            try:
                self.analyzer_server.start()
            except LLMServerError as e:
                logger.error("[LocalLLM] redémarrage analyzer échoué : %s", e)
                return None

        payload = plocal.build_classification_request(data, model=self.analyzer_model_id or "local")
        try:
            resp = self._analyzer_client.chat.completions.create(**payload)
            raw = resp.choices[0].message.content or "{}"
            parsed = json.loads(raw)
        except (json.JSONDecodeError, Exception) as e:
            logger.error("[LocalLLM] inférence ou parse JSON échoué : %s", e)
            return None

        category = parsed.get("category", "other")
        confidence = self._extract_category_confidence(resp, category)
        score = plocal.derive_score(category, confidence)

        # `validate_classification_result` clamp + defaults — bien que le
        # JSON Schema strict garantisse déjà la cohérence, on garde le
        # garde-fou pour le jour où le schéma est ignoré côté serveur
        # (vieille version llama_cpp) ou où le modèle se rebelle.
        # `importance_reason` reste vide en mode local : on ne fait pas
        # générer de phrase d'explication par le modèle (pas dans le
        # schema JSON pour rester court côté CPU), et le précédent
        # template "Classifié X par Phi-3.5-mini (confiance 0.70)"
        # était du jargon que personne ne veut lire. La catégorie +
        # le summary suffisent à comprendre la classification ; le
        # frontend masque la ligne quand la reason est vide.
        result: Dict[str, Any] = {
            "category": category,
            "importance_score": score,
            "importance_reason": "",
            "summary": parsed.get("summary", ""),
            "needs_reply": bool(parsed.get("needs_reply", False)),
            "draft_response": None,
        }
        result = validate_classification_result(result)
        # On RE-écrit le score après validate (qui clampe à [1,10] mais
        # ne re-dérive pas — la formule est notre source de vérité).
        result["importance_score"] = score

        usage = getattr(resp, "usage", None)
        result["tokens_in"] = getattr(usage, "prompt_tokens", 0) if usage else 0
        result["tokens_out"] = getattr(usage, "completion_tokens", 0) if usage else 0
        result["analyzed_by"] = f"local-{self.analyzer_model_id}"
        return result

    # ── Génération de brouillon (Level-4) ────────────────────────────

    def enrich_draft(
        self, data: Dict[str, Any], existing_result: Dict[str, Any],
        model: str = "local",
    ) -> Dict[str, Any]:
        """Génération de brouillon par le Drafter. Lazy : démarre le
        DrafterServer à la 1ère invocation, le garde tant qu'il y a de
        l'activité, le décharge après `drafter_idle_timeout_min`."""
        if existing_result.get("draft_response"):
            return existing_result

        client = self._ensure_drafter_running()
        if client is None or self.drafter_server is None:
            # Pas pu démarrer le drafter — pas de draft mais on ne casse
            # rien : l'utilisateur verra juste "Pas de brouillon dispo".
            return existing_result

        self.drafter_server.touch()
        payload = plocal.build_draft_request(data, model=self.drafter_model_id or "local")
        try:
            resp = client.chat.completions.create(**payload)
            raw = resp.choices[0].message.content or "{}"
            parsed = json.loads(raw)
            existing_result["draft_response"] = parsed.get("draft_response") or ""
            usage = getattr(resp, "usage", None)
            if usage:
                existing_result["tokens_in"] = existing_result.get("tokens_in", 0) + getattr(usage, "prompt_tokens", 0)
                existing_result["tokens_out"] = existing_result.get("tokens_out", 0) + getattr(usage, "completion_tokens", 0)
        except (json.JSONDecodeError, Exception) as e:
            logger.error("[LocalLLM] draft inférence échouée : %s", e)
        return existing_result

    def stream_draft(
        self, data: Dict[str, Any],
    ):
        """Variante streaming d'`enrich_draft`. Yield des chunks de texte
        au fur et à mesure que le modèle les produit.

        Utilité : sur Phi-3.5 / Qwen 3B CPU, une réponse complète prend
        10-15 s. Avec ce stream le user voit les tokens arriver dans le
        composer comme dans ChatGPT — la perception passe de "ça rame"
        à "ça écrit". La latence brute est identique mais la latence
        ressentie chute drastiquement.

        Yield (str) : chaque chunk de texte (un token ou plus). Le
        dernier yield est suivi de StopIteration ; l'appelant doit
        cumuler les chunks pour avoir le texte final.

        Pas de retour explicite : la persistance en DB est gérée par
        l'appelant (api.py) parce que c'est lui qui possède le contexte
        de la requête HTTP et qui décide quand le client a tout reçu.
        """
        client = self._ensure_drafter_running()
        if client is None or self.drafter_server is None:
            # Drafter indispo — le générateur est vide. L'endpoint API
            # détectera et renverra une erreur HTTP claire.
            return

        self.drafter_server.touch()
        payload = plocal.build_draft_stream_request(
            data, model=self.drafter_model_id or "local",
        )
        try:
            # client.chat.completions.create avec stream=True renvoie un
            # itérable de ChatCompletionChunk. Chaque chunk a
            # `.choices[0].delta.content` qui contient le texte nouveau
            # depuis le chunk précédent (souvent 1-3 tokens).
            stream = client.chat.completions.create(**payload)
            for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                content = getattr(delta, "content", None)
                if content:
                    yield content
        except Exception as e:
            logger.error("[LocalLLM] streaming draft échoué : %s", e)
            # Le générateur s'arrête. L'endpoint a déjà reçu ce qui a
            # été streamé avant l'erreur et peut décider de garder ou
            # ignorer ce préfixe partiel.
            return

    # ── Idle management ──────────────────────────────────────────────

    def maybe_unload_drafter(self) -> None:
        """À appeler périodiquement (depuis le scheduler) pour libérer
        la RAM si le drafter est inactif. No-op si timeout=0 (config
        "always-on" pour tier Heavy) ou pas démarré."""
        if self.drafter_server is None:
            return
        if self.drafter_server.is_idle(timeout_min=self._drafter_idle_timeout_min):
            logger.info("[LocalLLM] drafter idle depuis "
                        "%dmin — déchargement", self._drafter_idle_timeout_min)
            self.drafter_server.stop()
            self.drafter_server = None
            self._drafter_client = None

    # ── Internals ────────────────────────────────────────────────────

    def _ensure_drafter_running(self) -> Optional[OpenAI]:
        """Démarre le drafter si nécessaire, renvoie le client OpenAI
        prêt à l'emploi. Retourne None si le GGUF est introuvable ou
        si le démarrage échoue (l'appelant gracieusement skip le draft)."""
        if (self.drafter_server is not None and self.drafter_server.running
                and self._drafter_client is not None):
            return self._drafter_client

        if not self.drafter_model_id:
            logger.error("[LocalLLM] drafter_model_id non configuré")
            return None
        meta = _catalog.get_model(self.drafter_model_id)
        if meta is None:
            logger.error("[LocalLLM] drafter %s inconnu dans le catalog",
                         self.drafter_model_id)
            return None
        path = paths.MODELS_DIR / meta["filename"]
        if not path.is_file():
            logger.warning("[LocalLLM] drafter GGUF %s non téléchargé "
                           "(%s) — draft skip", self.drafter_model_id, path)
            return None

        try:
            from src import config as cfg
            local_cfg = (cfg.get().get("llm") or {}).get("local") or {}
            ctx = local_cfg.get("context_size", 4096)
            n_threads = local_cfg.get("n_threads", 6)
            # Le drafter prend la même config gpu_layers que l'analyzer
            # — il n'y a qu'un seul GPU à partager (ou pas de GPU).
            gpu_layers = int(local_cfg.get("gpu_layers", 0))
            self.drafter_server = DrafterServer(
                model_path=path, n_ctx=ctx, n_threads=n_threads,
                n_gpu_layers=gpu_layers,
            )
            self.drafter_server.start()
        except LLMServerError as e:
            logger.error("[LocalLLM] drafter start failed : %s", e)
            self.drafter_server = None
            return None

        self._drafter_client = OpenAI(
            base_url=self.drafter_server.base_url,
            api_key=self.drafter_server.api_key,
        )
        return self._drafter_client

    @staticmethod
    def _extract_category_confidence(resp: Any, category_value: str) -> float:
        """Extrait `exp(logprob)` du token correspondant à la catégorie.

        Parcourt les tokens de la réponse. Au premier token qui matche
        (préfixe-de ou égal à) la valeur de catégorie (ex. "important"),
        on prend son logprob et on renvoie exp(logprob) ∈ ]0, 1].

        Fallback à 0.7 si on ne trouve pas — c'est la valeur médiane
        observée en Phase 0 bis, suffisamment basse pour que la formule
        quadratique de `derive_score` pénalise l'incertitude.
        """
        target = (category_value or "").lower()
        if not target:
            return 0.7
        try:
            choice = resp.choices[0]
            lp = getattr(choice, "logprobs", None)
            if not lp or not getattr(lp, "content", None):
                return 0.7
            for tok in lp.content:
                t = (tok.token or "").strip().strip('"').lower()
                if not t:
                    continue
                # Match préfixe (le tokenizer peut découper "important"
                # en plusieurs sub-tokens — on prend le premier qui
                # commence la valeur).
                if target.startswith(t) and len(t) >= 3:
                    return math.exp(tok.logprob)
                if target == t:
                    return math.exp(tok.logprob)
        except Exception:  # noqa: BLE001
            pass
        return 0.7
