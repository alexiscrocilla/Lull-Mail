# Trajectoire de durcissement inspirée de Proton

Dernière mise à jour : 25 août 2026.

## Intention

Cette trajectoire utilise les dépôts publics Proton comme référence d'ingénierie,
pas comme cahier de fonctionnalités ni comme identité visuelle à reproduire.

Le périmètre reste volontairement limité à :

- la stabilité et la cohérence de l'interface ;
- la vitesse perçue et le coût réel des synchronisations ;
- la sécurité des mutations et des brouillons ;
- la testabilité et la maintenabilité ;
- l'accessibilité et la qualité des états chargement / vide / erreur.

Sont hors périmètre : ajout de fonctions utilisateur, migration vers React,
reprise du branding Proton et réécriture complète de la stack.

## Références Proton retenues

Le dépôt actuel à étudier est
[ProtonMail/WebClients](https://github.com/ProtonMail/WebClients), et non l'ancien
`proton-mail` archivé en 2021.

Quatre pratiques sont directement transposables sans adopter leur stack :

1. **Découpage par responsabilités.** Le client Mail sépare composants, hooks,
   store, rendu de message et outillage partagé. Les sous-domaines `list`,
   `message`, `composer`, `conversation`, `optimistic` et `mailbox` ont leurs
   propres frontières.
2. **Primitives partagées testables.** Le monorepo contient des paquets dédiés
   au rendu du courrier et aux utilitaires de test, avec mocks et données de
   test réutilisables.
3. **État et effets explicites.** Les mutations optimistes, la persistance et
   les événements ne sont pas dispersés dans les composants de présentation.
4. **Garde-fous automatiques.** Type-checking strict, lint, formatage et tests
   sont des étapes de premier rang, pas une vérification manuelle de fin de lot.

LullMail doit reprendre ces principes à son échelle, en JavaScript natif et
Python, sans introduire la complexité d'un monorepo ou d'un framework.

## Base mesurée

Au début de ce chantier :

- le backend FastAPI / SQLite possède une suite solide : **310 tests passent**,
  1 test MCP optionnel est ignoré quand le SDK n'est pas installé ;
- le frontend ne possédait aucune suite exécutée par la CI ;
- `mailbox.js` concentre encore environ 6 000 lignes et plusieurs cycles de vie
  indépendants dans un seul montage ;
- les jetons monotones empêchaient déjà les réponses tardives de repeindre
  l'état, mais ne stoppaient pas le travail réseau et SQLite devenu inutile ;
- une lecture tardive de brouillon pouvait cibler le shell `#read-pane` déjà
  réutilisé par un autre message ;
- l'autosauvegarde capturait le shell réutilisable plutôt que le sous-arbre de
  composition détachable, ce qui laissait une fenêtre de perte lors d'un
  changement rapide de message.

## Lot 1 appliqué — cycle de vie des requêtes

Ce lot est volontairement petit et transversal.

### Réseau

- `requestJson()` centralise les délais, annulations, erreurs FastAPI,
  `Retry-After`, réponses vides et réponses JSON invalides ;
- le délai et l'annulation restent actifs jusqu'à la lecture complète du corps,
  pas seulement jusqu'à la réception des en-têtes ;
- le listener du signal appelant est retiré à la fin de chaque requête ;
- les méthodes de lecture acceptent maintenant un `AbortSignal` sans modifier
  leurs appels existants.

### Boîte mail

- cinq slots « dernière requête gagnante » couvrent liste, lecture, recherche,
  conversation et brouillon ;
- démarrer une nouvelle requête annule immédiatement la précédente ;
- les jetons monotones restent en place comme deuxième défense d'intégrité ;
- le démontage annule tous les slots ;
- le rendu du panneau de lecture possède une génération explicite ;
- l'autosauvegarde conserve le sous-arbre exact du composeur, même détaché ;
- une lecture de brouillon tardive ne peut plus modifier le message suivant ;
- les contrôleurs des flux SSE refusés ou sans corps ne restent plus retenus.

### Tests et CI

- une suite Node native, sans dépendance npm, teste le client HTTP et la
  primitive d'annulation ;
- la CI Windows exécute désormais les tests Python puis frontend ;
- état actuel : **9 tests frontend passent**.

## Suite priorisée

### P0 — fiabilité avant toute retouche visuelle

1. **Scope de montage commun.** Créer un petit registre de disposables pour les
   routes (`AbortController`, timers, listeners, observers). Si un `mount*`
   échoue avant de retourner son cleanup, le registre doit tout libérer et la
   route doit afficher un état d'erreur réessayable. Cela clôt le reliquat 7.6
   de l'audit UX.
2. **Finaliser la mutation hors ligne en cours.** Le worktree contient déjà un
   chantier `pending_ops`, UIDVALIDITY, hydratation différée des corps et
   backoff. Le terminer avec tests de reprise après crash, coalescence,
   idempotence et changement UIDVALIDITY avant de poursuivre l'UI.
3. **Versionner les migrations SQLite.** Remplacer progressivement la suite de
   `PRAGMA table_info` + `ALTER TABLE` par des migrations numérotées,
   transactionnelles et testées depuis plusieurs versions de base.
4. **Rendre explicite la recherche dégradée.** Quand la recherche serveur
   échoue et repasse au filtrage local, afficher un bandeau discret avec
   « Réessayer ». Aujourd'hui la dégradation est silencieuse.

### P1 — performance et frontières du frontend

1. **Extraire sans réécrire.** Sortir de `mailbox.js`, dans cet ordre :
   `request lifecycle`, `search state`, `message reader`, `draft autosave`,
   `list renderer`. Une extraction doit conserver le DOM et les classes
   existants et ajouter ses tests avant déplacement.
2. **Pagination par curseur.** Remplacer le plafond implicite de 500 lignes par
   des pages stables `date_received_iso + int_id`. Afficher un pied de liste
   quand d'autres messages existent.
3. **Borner le DOM.** Le chargement par lots retarde la création mais ne recycle
   pas les cartes. Mesurer d'abord, puis virtualiser uniquement au-delà d'un
   seuil où le nombre de nœuds et la mémoire deviennent significatifs.
4. **Unifier les tokens visuels.** Terminer les reliquats de l'audit : palettes,
   couleurs littérales, échelles typo / rayon / espacement et génération
   Tailwind vérifiée en CI. Aucun redesign global avant cette consolidation.
5. **États optimistes communs.** Centraliser appliquer / confirmer / annuler / 
   restaurer pour lu, favori, dossier et labels afin que chaque action possède
   le même contrat de rollback et de toast.

### P2 — prévention des régressions

1. **Tests navigateur ciblés.** Couvrir 900, 1024 et 1400 px, clair / sombre,
   clavier, navigation rapide et latence forcée. Prioriser les scénarios de
   données, pas les snapshots décoratifs.
2. **Corpus de rendu MIME.** Isoler `image-blocker.js`, le nettoyage HTML et le
   dimensionnement d'iframe avec un corpus local de messages difficiles :
   tableaux larges, encodages cassés, CID, trackers, HTML invalide et texte
   très long.
3. **Budgets observables.** Journaliser localement, sans télémétrie distante :
   temps de première liste, p50/p95 des endpoints de lecture, durée de sync,
   taille du DOM, nombre de requêtes annulées et temps d'attente SQLite.
4. **Garde de fuite.** Un test doit faire 50 allers-retours Inbox ↔ Réglages et
   vérifier que timers, listeners, observers et contrôleurs reviennent à leur
   niveau initial.

## Critères de sortie

Le chantier « solidification » peut être considéré stable quand :

- aucune réponse périmée ne modifie la vue ou le store ;
- une navigation ou un démontage annule tout travail de lecture non nécessaire ;
- une frappe validée dans un brouillon survit aux changements rapides de vue ;
- toute mutation optimiste possède confirmation ou rollback ;
- le frontend et le backend passent dans la même CI ;
- 50 navigations successives ne font croître ni listeners ni timers ;
- les trois largeurs desktop supportées restent utilisables au clavier ;
- les p95 locaux sont mesurés avant d'engager pagination ou virtualisation.

## Règle de décision

Pour chaque idée issue de Proton : reprendre le **problème résolu** et le
**contrat de qualité**, puis choisir l'implémentation la plus petite compatible
avec LullMail. Ne reprendre ni l'architecture complète ni un composant pour sa
seule apparence.
