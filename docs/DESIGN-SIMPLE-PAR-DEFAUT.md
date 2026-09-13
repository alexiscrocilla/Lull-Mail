# Simple par défaut

Réponse au troisième retour utilisateur : « l'app est trop compliquée à
utiliser et il y a trop de fonctionnalités inutiles affichées. »

Une décision a été prise avant d'écrire une ligne : **pas d'interrupteur
« mode simple »**. Un mode ajoute un réglage, double les états à tester, et
laisse en place tout ce qu'il masque. Ce qui est en double ou inatteignable
est supprimé ; ce qui est utile mais rare passe derrière une affordance
native, à l'endroit où on le cherche.

## Ce que ça donne

Mesuré sur le même serveur de démonstration, même fenêtre (900x700, la taille
minimale autorisée par `app_gui.py`), IA activée, un compte, dix-huit
messages. Le « avant » est l'arbre à `9b32bd3`, servi côte à côte.

| | avant | après |
| --- | ---: | ---: |
| Contrôles visibles dans la vue | 29 | 22 |
| Entrées du rail | 9 | 8 |
| Éléments rendus dans une ligne de courrier | 13 | 9 |
| Boutons de la barre d'outils du volet de lecture | 10 | 6 |

## Les décisions, et pourquoi

**La ligne de courrier.** Elle portait quinze emplacements. Le commentaire de
la feuille de style appelait lui-même le résultat « truncated soup », et elle
en retirait déjà cinq dès que le volet de lecture était ouvert — une version
réduite que personne sous 1024 px n'avait jamais vue, puisque à cette largeur
le volet recouvre la liste. Cette réduction est devenue la ligne elle-même.
Elle répond à quatre questions : de qui, est-ce nouveau, est-ce que ça attend
quelque chose de moi, quand. Le reste, le volet le dit en entier.

L'étoile de favori part avec. C'est le marqueur qui protège un message du
Nettoyage : la question « lequel est protégé » se répond maintenant par le
dossier Favoris, en un clic, accessible au clavier. C'est exactement pourquoi
ce dossier est conservé alors que le bouton de filtre `is:starred` est
supprimé.

**Le volet de lecture.** Dix boutons plus un menu débordant dont
« Ré-analyser » était identique au bouton situé trois pixels à sa gauche, et
dont « Déplacer » était identique au bouton Supprimer hors corbeille. Six
survivent, en deux groupes. Le bouton Supprimer connaît son dossier : dans la
corbeille il restaure. Cette action n'existait auparavant que dans un menu
sans gestion du focus, sans Échap et sans flèches — restaurer un message
supprimé était la seule chose qu'un clavier ne pouvait pas faire.

**Le badge d'authentification.** Quatre états, trois inutiles. « Non vérifié »
signifie que le fournisseur n'a posé aucun en-tête. « Authentifié » est le cas
ordinaire. L'orange se déclenchait sur une politique DMARC absente, le défaut
de tout domaine qui n'en a jamais publié, donc le courrier des petits
expéditeurs était orange en permanence et la couleur s'est apprise à
elle-même à être ignorée. Un seul état reste, et il s'écrit en toutes lettres
sous l'expéditeur, pas dans une infobulle.

**La deuxième barre de filtres.** Trois contrôles qui ne filtraient rien :
deux insérant un opérateur littéral dans le champ de recherche, un troisième
ajoutant une date. Une barre de macros clavier occupant une bande permanente.
Elle est remplacée par un « ? » dans le champ de recherche qui documente les
onze opérateurs que l'analyseur accepte réellement — pas les quatre que citait
le texte indicatif, à côté d'une date de l'année précédente.

**Ce qui disparaît parce qu'on ne pouvait pas l'atteindre.** Les onglets
épinglés ne se créaient qu'au clic milieu : aucun clavier, aucun menu, aucun
lien — et une fois créés ils étaient utilisables au clavier, soit exactement
la règle d'accessibilité inversée. Le réordonnancement de la barre latérale
avait déjà perdu sa poignée dans un correctif de mise en page antérieur, et
n'était expliqué dans aucune langue : la fonctionnalité ne possédait aucune
chaîne de traduction.

**Le basculement en conversations.** Ouvrir un message charge toujours son
fil ; le basculement ne changeait que la requête de liste, et ce chemin ne
prend qu'un compte, donc il élargissait silencieusement un filtre
multi-comptes, et il s'évaporait à chaque recherche. Sa valeur stockée est
effacée, sans quoi quiconque l'avait activé une fois restait enfermé dedans
sans plus aucun contrôle pour en sortir.

**Les Paramètres.** Trois cartes restent : Comptes, Intelligence
artificielle, Notifications push. Synchronisation et Stockage passent derrière
un dépliant. L'intervalle de relève est un filet de sécurité depuis que IDLE
existe, pas une cadence ; et cinq des six contrôles de Stockage étaient déjà
un clic plus loin, derrière un mécanisme maison qui ne déplaçait pas le
focus. Le dépliant ne retient pas son état : une page qui diffère pour des
raisons invisibles est précisément ce que ce travail existe pour arrêter.

**L'onboarding.** Il s'ouvrait sur un téléchargement de 4,3 à 7,1 Go, avant
que l'app sache de quelle boîte il s'agissait — donc zéro message visible
pendant six à quarante-sept minutes d'attente. Le compte passe en premier et
la relève démarre en quittant cet écran. L'option locale ne télécharge plus
que l'analyseur, 2,4 Go ; le second modèle ne sert qu'à la rédaction
automatique, désactivée par défaut. Deux décisions, deux champs saisis, trois
écrans, zéro octet avant de voir arriver du courrier.

## Ce qui a été délibérément conservé

- **Le dossier Favoris** et la **liste des catégories**. Avec la pastille de
  catégorie retirée de la ligne, cette liste est le seul chemin vers le spam
  et les newsletters — et ces catégories viennent de règles qui tournent sans
  aucun modèle.
- **Les étiquettes personnelles.** Les masquer rendrait les deux affordances
  d'étiquetage sans issue : la fenêtre d'étiquetage ne sait pas créer une
  étiquette et renvoie vers la barre latérale.
- **Les trois tuiles de fournisseur IA**, y compris Ollama. Le changement de
  fournisseur n'a lieu qu'au clic sur la tuile ; un panneau replié serait
  configurable mais jamais activable.
- **Les champs SMTP.** Ils servent aussi aux utilisateurs dont le fournisseur
  a changé de serveur d'envoi, pas seulement aux serveurs personnalisés.
- **L'impression.** Le bouton part, la capacité reste : Ctrl/Cmd+P et une
  entrée dans la palette, tous deux uniquement quand un message est ouvert.

## Défauts trouvés en chemin, et corrigés

- La suite Playwright n'avait jamais exécuté une seule assertion : son serveur
  ne démarrait pas, sa sonde de disponibilité visait une route inexistante, et
  son test clavier interrogeait une classe que le volet de lecture n'utilise
  pas. Chaque avatar allait chercher le favicon du domaine de l'expéditeur sur
  Internet, ce qui rendait toute capture non reproductible.
- Le drapeau IA restait indéfini pour toujours si la sonde répondait autre
  chose qu'un 2xx, et trois des quatre façons d'activer l'IA ne prévenaient
  pas l'interface — qui restait en mode sans IA jusqu'au redémarrage du
  processus, dans une application sans bouton de rechargement.
- Chaque lancement à froid chargeait la liste deux fois, parce que la ligne
  qui fixe la route par défaut écrivait dans `location.hash`.
- Enregistrer la carte Synchronisation écrasait le mode d'analyse d'injection
  par sa valeur par défaut dès que le contrôle n'était pas affiché.
- Couper les notifications détruisait le sujet ntfy, et les Paramètres
  n'avaient aucun générateur pour en refaire un.
- La puce « réinitialiser les filtres » était transparente plutôt que masquée,
  donc présente dans l'ordre de tabulation.
- À 900x600, la page Paramètres comprimait la carte Comptes à zéro et la
  grille, qui coupe son débordement, la faisait disparaître sans ascenseur.

## Laissé pour plus tard

- **La recherche dans la corbeille** ne renvoie jamais rien : `search_emails`
  ouvre sur `folder != 'deleted'` avant la clause de dossier. L'aide n'en
  parle pas ; le correctif appartient à son propre changement.
- **La remise en file après activation de l'IA** compare une chaîne exacte, ce
  qui laisse sans résumé toute ligne classée par les règles. Le symptôme
  visible a beaucoup diminué maintenant que la ligne ne montre plus de résumé.
- **Un téléchargement de modèle en tâche de fond**, avec un crochet de fin.
  Tant qu'il n'existe pas, le téléchargement de l'onboarding bloque son écran
  — mais il est désormais recouvert par la relève du courrier.
- **La création d'étiquette dans la fenêtre d'étiquetage**, seule chose qui
  permettrait de masquer la section ÉTIQUETTES.
- **Le clavier dans les fenêtres surgissantes restantes** (déplacer, étiqueter,
  trier) : pas de déplacement du focus, pas d'Échap, pas de flèches.
- **Les quatre en-têtes de section de la barre latérale**, qui écoutent le clic
  sur un `<div>` sans `tabindex` ni `role`.
- **Les quatre aides dupliquées** entre le formulaire de l'assistant et celui
  des Paramètres.
