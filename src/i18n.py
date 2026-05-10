# SPDX-License-Identifier: GPL-3.0-or-later
"""
Backend i18n for user-visible strings.

Mirrors the contract of the frontend `t(key, vars)` helper:

    tr("key.name", locale, var=value)

Locale resolution lives in `get_locale(request)` — a FastAPI dependency
that reads the `Accept-Language` header sent by the frontend (set from
`window.LULLMAIL_LOCALE` in `frontend/i18n.js`). Falls back to French,
which matches the FR-first design of the rest of the app.

Scope: this module covers strings the user can SEE — HTTPException
detail messages, success toasts, validation errors that surface in the
UI. Deep-internal logger output stays French (engineers reading logs
already speak French).
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import Request


# ── Translation table ────────────────────────────────────────────────────────
# Keys are dot-namespaced by feature area. When adding a new error, prefer
# extending an existing namespace (e.g. `email.*`, `account.*`) so the FR
# and EN sections stay grep-able and balanced.

_STRINGS: dict[str, dict[str, str]] = {
    "fr": {
        # ── Generic ──────────────────────────────────────────────────────────
        "err.unexpected":               "Erreur inattendue : {msg}",
        "err.not_found":                "Élément introuvable",

        # ── Emails ───────────────────────────────────────────────────────────
        "email.not_found":              "Email introuvable",
        "email.ai_disabled.draft":      "IA désactivée. Activez-la dans Réglages > Intelligence artificielle pour générer des brouillons.",
        "email.ai_disabled.reanalyze":  "IA désactivée. Activez-la dans Réglages > Intelligence artificielle pour ré-analyser cet email.",
        "email.reanalyze_failed":       "Échec de la ré-analyse IA",
        "email.send.from_required":     "Compte expéditeur requis.",
        "email.send.to_required":       "Au moins un destinataire est requis.",
        "email.send.unexpected":        "Erreur d'envoi inattendue : {msg}",
        "email.category_invalid":       "Catégorie invalide : {category}",
        "email.folder_invalid":         "Dossier invalide : {folder}",
        "email.smtp.refused_body":      "Le serveur SMTP a refusé le contenu du message.",

        # ── Drafts ───────────────────────────────────────────────────────────
        "draft.insert_failed":          "Échec de l'insertion du brouillon.",
        "draft.not_found":              "Brouillon introuvable",
        "draft.from_required":          "Compte expéditeur requis pour créer un brouillon.",

        # ── Labels / folders ─────────────────────────────────────────────────
        "label.name_required":          "Nom d'étiquette requis.",
        "label.name_empty":             "Nom d'étiquette vide.",
        "label.not_found":              "Étiquette introuvable",
        "label.exists":                 "Une étiquette portant ce nom existe déjà.",
        "label.name_too_long":          "Nom d'étiquette trop long (max 60 caractères).",
        "label.named_exists":           "Une étiquette nommée « {name} » existe déjà.",
        "label.id_not_found":           "Étiquette {id} introuvable.",
        "folder.name_required":         "Nom de dossier requis.",
        "folder.name_empty":            "Nom de dossier vide.",
        "folder.not_found":             "Dossier introuvable",
        "folder.builtin_protected":     "Ce dossier est protégé.",
        "folder.exists":                "Un dossier portant ce nom existe déjà.",
        "folder.name_reserved":         "« {name} » est un nom réservé.",
        "folder.name_invalid":          "Caractères interdits dans le nom (lettres, chiffres, espaces, tiret et underscore uniquement, max 40).",
        "folder.named_exists":          "Un dossier nommé « {name} » existe déjà.",

        # ── Sync / queue ─────────────────────────────────────────────────────
        "sync.started":                 "Synchronisation lancée",
        "sync.already_running":         "Sync déjà en cours",

        # ── Setup / accounts ─────────────────────────────────────────────────
        "setup.openai.bad_format":      "Format de clé OpenAI inattendu (devrait commencer par sk-).",
        "setup.ntfy.topic_required":    "Topic ntfy requis quand activé.",
        "setup.account.exists":         "Un compte avec l'adresse {email} existe déjà.",
        "setup.account.password_required": "Mot de passe requis pour créer un compte.",
        "setup.account.email_invalid":  "Adresse email invalide.",
        "setup.account.imap_required":  "Serveur de réception manquant.",
        "setup.account.not_found":      "Compte introuvable.",
        "setup.account.not_found_email": "Compte {email} introuvable.",
        "setup.account.password_empty": "Mot de passe vide.",
        "setup.account.password_missing_test": "Mot de passe manquant pour le test.",
        "setup.imap.login_rejected":    "Identifiants refusés par le serveur.",
        "setup.services.start_failed":  "Démarrage des services email échoué : {msg}",
        "setup.services.start_failed_logs": "Démarrage des services email échoué — voir les logs.",
        "setup.confirm_missing":        "Confirmation manquante.",
        "setup.open_dir_failed":        "Impossible d'ouvrir le dossier : {msg}",

        # ── Rate limit ───────────────────────────────────────────────────────
        "rate_limited":                 "Trop de requêtes en peu de temps. Patientez quelques secondes avant de réessayer.",

        # ── Cleanup / unsubscribe ────────────────────────────────────────────
        "cleanup.job_not_found":        "Tâche introuvable",
        "cleanup.rule.invalid":         "Règle invalide.",
        "cleanup.no_field_to_update":   "Aucun champ à mettre à jour",
        "unsub.no_link":                "Aucun lien de désabonnement connu pour cet expéditeur",

        # ── Attachments ──────────────────────────────────────────────────────
        "attachment.not_found":         "Pièce jointe introuvable",
        "attachment.dangerous_blocked": "Cette pièce jointe est marquée comme dangereuse. Confirmez pour la télécharger.",
        "attachment.too_large":         "Fichier trop volumineux ({size}). Limite : {limit}.",
        "attachment.fingerprint_mismatch": "Empreinte de fichier altérée — accès refusé",
        "attachment.blocked_policy":    "Pièce jointe bloquée par la politique de sécurité — aucune donnée stockée.",
        "attachment.file_missing":      "Fichier physiquement absent",
        "attachment.read_error":        "Lecture impossible",

        # ── Uploads (outbound) ───────────────────────────────────────────────
        "upload.filename_missing":      "Nom de fichier manquant.",
        "upload.type_blocked":          "Type de fichier interdit pour l'envoi : {ext}. Compressez-le dans une archive avant d'attacher.",
        "upload.too_large":             "Fichier trop volumineux (max {max_mb} Mo).",
        "upload.failed":                "Échec de l'upload : {msg}",
        "upload.not_found":             "Upload introuvable",
        "upload.delete_failed":         "Suppression impossible : {msg}",

        # ── Safe-link interstitial ───────────────────────────────────────────
        "safe_link.url_missing":        "URL manquante ou trop longue",
        "safe_link.scheme_unsupported": "Schéma non supporté : {scheme}",
        "safe_link.url_malformed":      "URL malformée",

        # Page — hero & footer
        "safe_link.page.title_danger":  "Lien dangereux",
        "safe_link.page.title_warning": "Lien à vérifier",
        "safe_link.page.lead":          "Lull Mail a détecté plusieurs signaux qui suggèrent que ce lien pourrait être trompeur. Consultez les détails ci-dessous avant de continuer.",
        "safe_link.page.btn_cancel":    "Annuler",
        "safe_link.page.btn_continue":  "Continuer quand même",
        "safe_link.page.footer":        "Cet écran apparaît uniquement pour les liens identifiés comme suspects. Les liens légitimes sont ouverts directement, sans avertissement.",

        # Threat: homoglyph
        "safe_link.threat.homoglyph.title": "Caractères trompeurs",
        "safe_link.threat.homoglyph.body":  "Ce nom de domaine contient un ou plusieurs caractères Cyrilliques ou Grecs visuellement identiques aux lettres latines. C'est la technique d'attaque par homographe : vous croyez aller sur paypal.com mais le navigateur ouvre un domaine totalement différent appartenant à un attaquant.",

        # Threat: punycode (pre-encoded)
        "safe_link.threat.punycode_pre.body": "Ce domaine est livré pré-encodé en punycode (préfixe « xn-- »). Cet encodage est légitime pour les noms internationalisés mais aussi très utilisé par les attaques de phishing pour masquer un nom trompeur.",
        # Threat: punycode (will be encoded)
        "safe_link.threat.punycode_enc.body": "Le navigateur convertira ce nom de domaine en sa forme technique (préfixe « xn-- ») avant de résoudre. Cette conversion automatique est l'un des mécanismes que les attaquants exploitent pour faire passer un domaine homographe pour le vrai site.",
        "safe_link.threat.punycode.title": "Encodage IDN punycode",

        # Threat: userinfo (@-trick)
        "safe_link.threat.userinfo.title": "Astuce du « @ »",
        "safe_link.threat.userinfo.body":  "Tout ce qui est avant le « @ » dans une URL n'est pas le domaine — c'est un identifiant ignoré par le serveur. L'adresse réelle est celle qui suit le « @ ». Cette technique est utilisée pour faire passer un domaine malveillant pour un site connu.",

        # Threat: raw IP
        "safe_link.threat.ip_host.title": "Adresse IP brute",
        "safe_link.threat.ip_host.body":  "Le lien pointe vers une adresse IP numérique au lieu d'un nom de domaine. Les sites légitimes (banques, services publics, e-commerce) utilisent toujours un vrai domaine. Les liens vers une IP nue dans un email sont presque systématiquement frauduleux.",

        # Threat: shortener
        "safe_link.threat.shortener.title": "Lien raccourci",
        "safe_link.threat.shortener.body":  "Ce service raccourcit les URLs et masque la destination réelle. Tant que vous n'avez pas cliqué, impossible de savoir où vous arrivez. À éviter quand le mail vient d'un expéditeur inconnu.",

        # Threat: suspicious TLD
        "safe_link.threat.suspicious_tld.title": "Extension à risque",
        "safe_link.threat.suspicious_tld.body":  "Le domaine se termine par « .{tld} », une extension peu coûteuse fréquemment utilisée pour le spam et le phishing. Les sites légitimes en .com/.fr/.org existent bien plus rarement avec ces extensions.",

        # Threat: typosquat
        "safe_link.threat.typosquat.title": "Imitation d'un domaine connu",
        "safe_link.threat.typosquat.body":  "Le nom de domaine ressemble énormément à « {brand} » à un caractère près (substitution, ajout, suppression ou inversion). C'est la signature classique du typosquatting : un attaquant a enregistré un domaine presque identique à une marque connue pour piéger les fautes de frappe et les regards distraits.",

        # Threat: subdomain spoof
        "safe_link.threat.subdomain_spoof.title": "Marque détournée en sous-domaine",
        "safe_link.threat.subdomain_spoof.body":  "Ce lien contient « {brand} » au début mais le vrai domaine est « {registrable} », qui n'a rien à voir. Tout ce qui se trouve à gauche du dernier point n'est qu'un sous-domaine que le propriétaire du domaine réel peut nommer comme il veut — y compris pour vous faire croire que vous arrivez sur un site de confiance.",

        # Visual labels
        "safe_link.visual.real_domain":  "domaine réel",
        "safe_link.visual.imitates":     "imite",

        # ── Notifier ─────────────────────────────────────────────────────────
        "notifier.reply_expected":      "réponse attendue",
        "notifier.no_subject":          "(Sans objet)",

        # ── Update ──────────────────────────────────────────────────────────
        "update.downloading":           "Téléchargement en cours…",
    },
    "en": {
        # ── Generic ──────────────────────────────────────────────────────────
        "err.unexpected":               "Unexpected error: {msg}",
        "err.not_found":                "Item not found",

        # ── Emails ───────────────────────────────────────────────────────────
        "email.not_found":              "Email not found",
        "email.ai_disabled.draft":      "AI is off. Enable it in Settings > AI to generate draft replies.",
        "email.ai_disabled.reanalyze":  "AI is off. Enable it in Settings > AI to re-analyse this email.",
        "email.reanalyze_failed":       "AI re-analysis failed",
        "email.send.from_required":     "Sender account required.",
        "email.send.to_required":       "At least one recipient is required.",
        "email.send.unexpected":        "Unexpected send error: {msg}",
        "email.category_invalid":       "Invalid category: {category}",
        "email.folder_invalid":         "Invalid folder: {folder}",
        "email.smtp.refused_body":      "The SMTP server rejected the message body.",

        # ── Drafts ───────────────────────────────────────────────────────────
        "draft.insert_failed":          "Could not save the draft.",
        "draft.not_found":              "Draft not found",
        "draft.from_required":          "Sender account required to create a draft.",

        # ── Labels / folders ─────────────────────────────────────────────────
        "label.name_required":          "Label name required.",
        "label.name_empty":             "Label name is empty.",
        "label.not_found":              "Label not found",
        "label.exists":                 "A label with this name already exists.",
        "label.name_too_long":          "Label name too long (max 60 characters).",
        "label.named_exists":           'A label named "{name}" already exists.',
        "label.id_not_found":           "Label {id} not found.",
        "folder.name_required":         "Folder name required.",
        "folder.name_empty":            "Folder name is empty.",
        "folder.not_found":             "Folder not found",
        "folder.builtin_protected":     "This folder is protected.",
        "folder.exists":                "A folder with this name already exists.",
        "folder.name_reserved":         '"{name}" is a reserved name.',
        "folder.name_invalid":          "Invalid characters in folder name (letters, digits, spaces, hyphens and underscores only, max 40).",
        "folder.named_exists":          'A folder named "{name}" already exists.',

        # ── Sync / queue ─────────────────────────────────────────────────────
        "sync.started":                 "Sync started",
        "sync.already_running":         "Sync already running",

        # ── Setup / accounts ─────────────────────────────────────────────────
        "setup.openai.bad_format":      "Unexpected OpenAI key format (should start with sk-).",
        "setup.ntfy.topic_required":    "ntfy topic required when push is on.",
        "setup.account.exists":         "An account with the address {email} already exists.",
        "setup.account.password_required": "Password required to create an account.",
        "setup.account.email_invalid":  "Invalid email address.",
        "setup.account.imap_required":  "IMAP host missing.",
        "setup.account.not_found":      "Account not found.",
        "setup.account.not_found_email": "Account {email} not found.",
        "setup.account.password_empty": "Password is empty.",
        "setup.account.password_missing_test": "Password missing for this test.",
        "setup.imap.login_rejected":    "Login rejected by the server.",
        "setup.services.start_failed":  "Could not start email services: {msg}",
        "setup.services.start_failed_logs": "Could not start email services. Check the logs.",
        "setup.confirm_missing":        "Confirmation missing.",
        "setup.open_dir_failed":        "Could not open the folder: {msg}",

        # ── Rate limit ───────────────────────────────────────────────────────
        "rate_limited":                 "Too many requests. Wait a few seconds before retrying.",

        # ── Cleanup / unsubscribe ────────────────────────────────────────────
        "cleanup.job_not_found":        "Job not found",
        "cleanup.rule.invalid":         "Invalid rule.",
        "cleanup.no_field_to_update":   "No field to update",
        "unsub.no_link":                "No unsubscribe link known for this sender",

        # ── Attachments ──────────────────────────────────────────────────────
        "attachment.not_found":         "Attachment not found",
        "attachment.dangerous_blocked": "This attachment is flagged as dangerous. Confirm to download.",
        "attachment.too_large":         "File too large ({size}). Limit: {limit}.",
        "attachment.fingerprint_mismatch": "File fingerprint changed — access denied",
        "attachment.blocked_policy":    "This attachment was blocked by the security policy and was never stored.",
        "attachment.file_missing":      "File not found on disk",
        "attachment.read_error":        "Could not read the file",

        # ── Uploads (outbound) ───────────────────────────────────────────────
        "upload.filename_missing":      "Filename missing.",
        "upload.type_blocked":          "File type not allowed for sending: {ext}. Compress it into an archive first.",
        "upload.too_large":             "File too large (max {max_mb} MB).",
        "upload.failed":                "Upload failed: {msg}",
        "upload.not_found":             "Upload not found",
        "upload.delete_failed":         "Could not delete the upload: {msg}",

        # ── Safe-link interstitial ───────────────────────────────────────────
        "safe_link.url_missing":        "URL missing or too long",
        "safe_link.scheme_unsupported": "Unsupported scheme: {scheme}",
        "safe_link.url_malformed":      "Malformed URL",

        # Page — hero & footer
        "safe_link.page.title_danger":  "Suspicious link",
        "safe_link.page.title_warning": "Link to verify",
        "safe_link.page.lead":          "Lull Mail detected signals that suggest this link may be deceptive. Review the details below before continuing.",
        "safe_link.page.btn_cancel":    "Cancel",
        "safe_link.page.btn_continue":  "Continue anyway",
        "safe_link.page.footer":        "This screen appears only for links flagged as suspicious. Legitimate links open directly, without any warning.",

        # Threat: homoglyph
        "safe_link.threat.homoglyph.title": "Deceptive characters",
        "safe_link.threat.homoglyph.body":  "This domain contains one or more Cyrillic or Greek characters that look identical to Latin letters. This is a homograph attack: you think you are going to paypal.com, but the browser opens a completely different domain owned by an attacker.",

        # Threat: punycode (pre-encoded)
        "safe_link.threat.punycode_pre.body": "This domain is delivered pre-encoded in punycode (prefix \"xn--\"). That encoding is legitimate for internationalised names but is also widely used in phishing to hide a deceptive hostname.",
        # Threat: punycode (will be encoded)
        "safe_link.threat.punycode_enc.body": "The browser will convert this domain to its technical punycode form (prefix \"xn--\") before resolving it. Attackers exploit this automatic conversion to make a homograph domain appear identical to the real site.",
        "safe_link.threat.punycode.title": "IDN punycode encoding",

        # Threat: userinfo (@-trick)
        "safe_link.threat.userinfo.title": "The @ trick",
        "safe_link.threat.userinfo.body":  "Everything before the @ in a URL is not the domain — it is a credential field that servers ignore. The real destination is what comes after the @. This technique makes a malicious domain look like a trusted site.",

        # Threat: raw IP
        "safe_link.threat.ip_host.title": "Raw IP address",
        "safe_link.threat.ip_host.body":  "This link points to a numeric IP address instead of a domain name. Legitimate sites (banks, public services, online shops) always use a real domain. Links to a bare IP in email are almost always fraudulent.",

        # Threat: shortener
        "safe_link.threat.shortener.title": "Shortened link",
        "safe_link.threat.shortener.body":  "This service shortens URLs and hides the real destination. There is no way to know where you will land before clicking. Avoid shortened links from unknown senders.",

        # Threat: suspicious TLD
        "safe_link.threat.suspicious_tld.title": "High-risk extension",
        "safe_link.threat.suspicious_tld.body":  "The domain ends in .{tld}, an extension that is cheap to register and heavily over-represented in spam and phishing. Legitimate sites rarely use these extensions.",

        # Threat: typosquat
        "safe_link.threat.typosquat.title": "Known domain impersonation",
        "safe_link.threat.typosquat.body":  "This domain name closely resembles \"{brand}\" with a single-character difference (substitution, insertion, deletion or transposition). This is the classic typosquatting pattern: an attacker registered a domain nearly identical to a well-known brand to catch typos and inattentive eyes.",

        # Threat: subdomain spoof
        "safe_link.threat.subdomain_spoof.title": "Brand hijacked as subdomain",
        "safe_link.threat.subdomain_spoof.body":  "This link contains \"{brand}\" near the start, but the real domain is \"{registrable}\", which is unrelated. Everything to the left of the final dot is just a subdomain that the actual domain owner can name however they like, including to make you believe you are reaching a trusted site.",

        # Visual labels
        "safe_link.visual.real_domain":  "real domain",
        "safe_link.visual.imitates":     "imitates",

        # ── Notifier ─────────────────────────────────────────────────────────
        "notifier.reply_expected":      "reply expected",
        "notifier.no_subject":          "(No subject)",

        # ── Update ──────────────────────────────────────────────────────────
        "update.downloading":           "Downloading…",
    },
}


# ── Public API ──────────────────────────────────────────────────────────────


def tr(key: str, locale: Optional[str] = None, **vars: Any) -> str:
    """Translate `key` into the target locale, then interpolate `{name}`
    placeholders with `vars`.

    Falls back to the French string when the locale is unknown or the key
    is missing in that locale; falls back to the key itself when the key
    doesn't exist anywhere (loud-and-visible failure mode).
    """
    loc = (locale or "fr").lower()
    if loc.startswith("en"):
        loc = "en"
    else:
        loc = "fr"

    table = _STRINGS.get(loc) or _STRINGS["fr"]
    s = table.get(key) or _STRINGS["fr"].get(key) or key

    if vars:
        for name, value in vars.items():
            s = s.replace("{" + name + "}", str(value))
    return s


def get_locale(request: Request) -> str:
    """FastAPI dependency: pick the request locale from `Accept-Language`.

    The frontend sets this header from `window.LULLMAIL_LOCALE` on every
    fetch (see `frontend/api.js`). Defaults to French — matches the
    browser-side default in `frontend/i18n.js:detectLocale`.
    """
    raw = request.headers.get("accept-language") or ""
    # Accept-Language can be a list ("fr-FR,en-US;q=0.7"). We only care
    # about the leading tag.
    primary = raw.split(",", 1)[0].strip().lower()
    if primary.startswith("en"):
        return "en"
    return "fr"
