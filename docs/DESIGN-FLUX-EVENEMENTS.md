# Le serveur dit ce qui change

Réponse au deuxième retour utilisateur : « la page inbox ne charge pas les
nouveaux mails rapidement ». Le lot 1 avait corrigé la moitié serveur — avec
IMAP IDLE, un message arrive en base environ deux secondes après que le
serveur l'annonce. La moitié client n'avait pas été touchée.

## Ce qui était mesuré, et ce qui l'est maintenant

Même serveur de démonstration, même fenêtre, même jeu de données.

| | avant | après |
| --- | ---: | ---: |
| Apparition d'un message déjà en base, médiane | 14 152 ms | **1 913 ms** |
| Au pire sur dix essais | 56 997 ms | **1 929 ms** |
| Écart entre le meilleur et le pire | 56,7 s | **40 ms** |
| Requêtes d'une fenêtre inactive | 23 / minute | **0** |
| Rechargement complet de la liste | toutes les 60 s (21,2 Mo) | **jamais sans raison** |

Le chiffre qui compte n'est pas la médiane, c'est l'écart. Avant, la seule
information dont disposait la fenêtre était un échantillon toutes les trois
secondes d'un booléen vrai uniquement pendant la durée d'une passe de relève.
La moitié des passes réelles étaient trop courtes pour être échantillonnées,
et le message attendait alors le rafraîchissement de soixante secondes. Le
défaut s'aggravait à mesure que la relève devenait plus rapide.

## Trois choses visibles réparées

**Le courrier apparaît quand il arrive.** Le serveur annonce chaque tranche de
vingt messages au moment où elle est écrite, et uniquement les lignes
réellement insérées : une resynchronisation d'identifiants déjà connus ne doit
pas ressembler à une arrivée.

**Un message en cours de téléchargement se remplit tout seul.** Le volet de
lecture affichait trois barres grises, une fois, pour toujours : il y avait
exactement une nouvelle tentative, à 1 200 ms, que la séquence connexion +
authentification + sélection + récupération perd presque toujours face à un
vrai fournisseur — et rien ne la relançait. Le contournement, cliquer ailleurs
puis revenir, ne s'invente pas.

**Un message dont le corps n'arrivera jamais le dit.** Il tombait dans
« (corps du mail vide) », ce qui affirme au lecteur que son message est vide
alors que la raison donnée par le serveur était enregistrée à côté, jamais
lue. Il restait aussi compté dans la file d'attente, pour toujours, sans que
rien ne puisse l'en sortir.

## Et une chose invisible

Vingt-trois requêtes par minute et 21,2 Mo de corps de messages inutilisés
toutes les soixante secondes. Personne ne l'a jamais vu. C'est le mécanisme
qui rend les trois points ci-dessus possibles, pas une fonctionnalité : à
présenter comme tel.

## Les décisions structurantes

**Un générateur asynchrone, pas synchrone.** Starlette itère un générateur
synchrone à travers le pool de threads, une tâche par trame ; un générateur en
attente immobilise donc un des quarante jetons pendant toute l'attente. À
quarante flux ouverts le serveur ne répond plus à rien, sans aucune
dégradation préalable. Les deux flux SSE déjà présents dans l'application ont
cette forme.

**Aucune limitation de débit sur la route.** Une réponse non-2xx place
`EventSource` dans son état fermé, sans aucune nouvelle tentative : un 429 sur
une rafale de reconnexion rendrait la fenêtre définitivement aveugle, ce qui
est strictement pire que le sondage remplacé, lequel se rétablissait toujours
au tic suivant. Le frein est un plafond d'abonnés qui répond 503, que le
client traite comme « bascule en secours ».

**Les instantanés sont construits par un minuteur, jamais à l'endroit du
changement.** La charge utile de statut coûte une lecture de configuration et
une connexion SQLite par compte ; la construire à chaque changement l'aurait
multipliée par le nombre de messages analysés, soit exactement le trafic que
ce travail supprime.

**Deux états d'erreur, jamais confondus.** Quand le navigateur abandonne, il
ne réessaiera jamais, donc le secours démarre immédiatement. Quand il a
seulement perdu la connexion, il réessaie déjà tout seul, et sonder par-dessus
ferait payer les deux canaux à une application en parfait état ; un minuteur
pose seulement un plancher de vingt secondes sur la durée d'aveuglement.

**Le sondage reste.** C'est ce que le secours interroge, et le flux construit
sa charge utile avec la même fonction, pour que les deux ne puissent pas
décrire deux mondes différents.

## Défauts trouvés en chemin

- **La réservation des corps n'était pas atomique.** Mesuré à deux threads :
  460 réservations pour 400 lignes, 60 lignes remises aux deux. Un message
  dupliqué est téléchargé deux fois et son second fichier joint est écrit puis
  jamais servi. Rien ne l'atteignait avant ce lot, qui ajoute un second
  réserveur : le correctif est donc le premier commit.
- **Aucun message n'était classé avant que toute la file de téléchargement ne
  soit vidée.** La passe alterne téléchargement et tri dans une boucle, mais
  le téléchargement vidait le compte entièrement avant de rendre la main, et
  l'ensemble analysable ne contient que des lignes dont le corps est déjà
  arrivé. Sur une première synchronisation, pas une catégorie avant le dernier
  message.
- **Le message ouvert ne passait pas devant.** Une primitive écrite exactement
  pour cela — ne rien rendre si la ligne est déjà en cours — n'avait aucun
  appelant dans tout le dépôt.
- **Le délai de nouvelle tentative était plat**, donc les cinq essais étaient
  consommés en cinq minutes : une coupure de six les épuisait définitivement.
- **La tâche d'analyse n'avait pas de tolérance de retard**, donc chaque
  réveil de veille en perdait un tic.
- **L'envoi ne rafraîchissait la liste que si le dossier Brouillons était
  ouvert**, laissant le message envoyé et tous les compteurs périmés.
- **L'assistant d'installation avait son propre sondeur** de trois secondes,
  sur le seul écran où le serveur est le plus occupé.

## Ce qui reste délibérément à faire

- **La recherche dans la corbeille** ne renvoie jamais rien : la clause qui
  exclut les supprimés précède celle du dossier. Antérieur à ce lot.
- **Le `SELECT *` de la liste**, qui fait peser 21,2 Mo à une réponse. La
  suppression du rechargement périodique retire l'essentiel du coût ; réduire
  la projection est un changement plus large et plus risqué.
- **Une connexion partagée pour toute une tournée de téléchargement** : 67
  authentifications pour 2 000 messages deviendraient une seule. Mais deux
  tests remplacent la fabrique de connexion par une fonction à un argument,
  et resteraient verts en cessant silencieusement de couvrir le chemin réel —
  ce qui est pire qu'une rupture franche.
- **Le danger UIDVALIDITY pendant un téléchargement en vol** : le changement
  efface les identifiants du compte sur le fil de relève pendant qu'une
  tournée en garde en mémoire. Réel, et une garde par lot ne le referme pas.
- **Les points M8 à M14 de l'audit** (dégradation silencieuse de la recherche,
  états vides indifférenciés, animation de sortie avant l'appel réseau). Ils
  sont rangés sous le même lot que ce travail dans l'audit ; ils ne sont pas
  faits. Le dire au moment de la revue plutôt que de laisser « lot 4 terminé »
  le sous-entendre.

## La question de positionnement

Elle ne produit aucun commit et reste ouverte : voir la section dédiée du
mémo de conception. Elle demande si l'application doit rester un client de
messagerie capable de composer, répondre, transférer, étiqueter et classer, ou
devenir une surface de tri qui passe la main. Les options, ce que chacune
garde et perd, leur coût et ce qui est irréversible sont chiffrés là.
