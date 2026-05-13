# Backlog — features à faire plus tard

> **Dev-only.** Ce fichier ne doit PAS partir vers le repo public.
> À exclure du `git filter-repo` au prochain push public, ou à
> supprimer avant filter-repo + le re-créer côté dev après.

Liste des features identifiées comme désirables mais reportées. À traiter
quand le scope d'une release le justifie.

---

## Vue fil / thread dans le read pane

**Contexte** : actuellement quand l'utilisateur envoie une réponse à un email,
le composer se ferme et il revient sur l'email original tel quel. Aucune
indication visuelle de "j'ai répondu" sauf le toast éphémère et l'icône
reply sur la card.

**Comportement souhaité** : à l'instar de Gmail / Outlook, afficher l'email
original suivi de ses réponses (incoming + outgoing) en succession verticale
dans le read pane. La réponse qu'on vient d'envoyer apparaît immédiatement
en bas, marquée "Envoyé à HH:MM par moi", déplie le body au clic.

**Ce qu'il faudrait** :

- **DB** : indexer `Message-ID` + capture du header `In-Reply-To` à
  l'ingest (`email_fetcher.py`). La colonne `in_reply_to` existe
  probablement dans `outbox` mais pas en index sur `emails`.
- **DB** : créer `idx_emails_in_reply_to` pour rendre la requête de
  grouping rapide.
- **Backend** : nouvel endpoint `GET /api/threads/{int_id}` qui renvoie
  l'arbre des messages liés à un email donné (parents + enfants en
  remontant les `in_reply_to`).
- **Backend** : indexer aussi les sent emails dans la même table, OU
  joindre la table `outbox` au moment du grouping.
- **Frontend** : refactor du read pane (`renderEmail` dans
  `mailbox.js`) pour rendre une liste de messages au lieu d'un
  unique body. Chaque message a son meta strip + body collapsible.
- **Frontend** : auto-scroll vers le message le plus récent (souvent la
  réponse qu'on vient d'envoyer).
- **i18n** : nouvelles clés `mb.thread.*` (envoyé/reçu, déplier/replier,
  etc.).

**Risques** :

- Le `In-Reply-To` peut pointer vers un Message-ID qu'on n'a pas en DB
  (l'utilisateur a archivé l'original, ou la chaîne a été cassée par
  un client mail qui réécrit les headers). Gérer le cas où le parent
  n'existe pas → afficher quand même l'email actuel + descendants.
- ProtonMail Bridge a tendance à dupliquer les Message-IDs entre
  envoyé et reçu sur la même conversation → dédupliquer côté DB.
- Performance : threads de 50+ messages doivent rester fluides. Lazy-
  load les bodies des messages anciens, ne render que les méta
  strips au-dessus du fold.

**Effort estimé** : 1-2 jours-personne. Pas dépendant d'autre feature.

**Priorité** : moyenne. La vue actuelle est fonctionnelle ; la vue fil
serait un nice-to-have qui rapprocherait Lull Mail des standards Gmail
/ Outlook.

**Origine** : feedback utilisateur 2026-05-13.
