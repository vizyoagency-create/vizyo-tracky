/**
 * BASE DE CONNAISSANCES de l'assistance IA — ce que l'agent sait de Vizyo Tracky.
 *
 * ── Pourquoi ce fichier existe ───────────────────────────────────────────────────────
 * L'assistance répond en direct via l'API : contrairement à un agent qui tournerait la nuit
 * sur le poste, elle NE PEUT PAS lire le code source pour comprendre une fonctionnalité. Sa
 * connaissance de l'app doit donc être ÉCRITE, ici, et tenue à jour. C'est un travail de fond,
 * pas un effet de bord du prompt : une fonctionnalité livrée sans passer par ce fichier est une
 * fonctionnalité sur laquelle l'agent répondra à côté, ou inventera.
 *
 * ── Deux règles d'écriture, non négociables ──────────────────────────────────────────
 *
 * 1. **VOCABULAIRE CLIENT, JAMAIS INTERNE.** Aucun chemin de fichier, aucun nom de classe ou de
 *    service, aucune variable d'environnement, aucun détail d'infrastructure. Ce texte finit
 *    dans une réponse lue par un utilisateur ; tout ce qui est écrit ici est réputé divulgable.
 *    C'est la vraie barrière contre la fuite de secrets : on ne compte pas sur le modèle pour
 *    taire ce qu'on lui a donné, on ne le lui donne pas.
 *
 * 2. **LES LIMITES SONT DU CONTENU, PAS DES AVEUX.** « La coupure est marquée non vérifiable si
 *    le véhicule était déjà à l'arrêt » vaut mieux qu'un silence : sans cette phrase, l'agent
 *    invente une panne. L'essentiel des questions d'assistance porte précisément sur ces
 *    frontières-là.
 *
 * ── Fraîcheur ────────────────────────────────────────────────────────────────────────
 * Rédigé le 19/08/2026 à partir de l'inventaire produit du 08/07/2026 (audit du code), avec
 * revérification dans le schéma courant des points qui avaient bougé depuis — les rôles, par
 * exemple, sont passés de 5 à 7 entre les deux dates. Un inventaire n'est vrai qu'à sa date :
 * ce qui est recopié sans revérification finit par se tromper poliment.
 */

export interface KnowledgeTopic {
  /** Identifiant stable — c'est LUI que l'étape de classement renvoie. Ne jamais le renommer. */
  key: string;
  titre: string;
  /**
   * Les mots que les CLIENTS emploient, pas ceux du code. C'est sur cette liste que l'étape de
   * classement s'appuie : « pourquoi ma voiture est grise sur la carte » doit tomber sur la
   * connectivité, pas sur un terme technique que personne ne tape.
   */
  motsCles: string[];
  /** Le contenu, tel qu'il pourra être lu par un utilisateur. */
  contenu: string;
}

export const KNOWLEDGE: KnowledgeTopic[] = [
  {
    key: 'carte-live',
    titre: 'Carte en direct et état des véhicules',
    motsCles: ['carte', 'live', 'temps reel', 'direct', 'position', 'marqueur', 'gris', 'hors ligne', 'deconnecte', 'ne bouge pas', 'calques', 'heatmap'],
    contenu: `La carte affiche la position de chaque véhicule en direct, sans rafraîchir la page. À
l'ouverture, la dernière position connue de chaque véhicule s'affiche immédiatement, puis le direct
prend le relais.

Chaque véhicule porte un état de connectivité, identique partout dans l'application :
- En ligne : le boîtier communique et la position est fraîche.
- Recherche GPS : le boîtier est connecté mais n'a pas encore accroché les satellites. C'est normal
  au démarrage à froid, ou en sous-sol. Le véhicule n'est pas perdu, sa position n'est simplement
  pas encore fiable.
- À l'arrêt : le véhicule est stationné, contact coupé.
- Hors ligne : plus aucune trame reçue depuis plus de 15 minutes.
- Non configuré : aucun boîtier n'est encore rattaché à ce véhicule.

Un véhicule qui reste "hors ligne" longtemps est le plus souvent dans un parking couvert, un tunnel,
une zone sans réseau mobile, ou avec un boîtier débranché.

La carte propose des calques activables : zones, trajets, plaques, arrêts de plus de 5 minutes sur
24 h, stations-service fréquentées, et une carte de densité. Un badge indique combien de calques
sont actifs.

Si le lien temps réel se coupe plus de 45 secondes, un bandeau le signale et un incident est tracé.
La reconnexion est automatique.`,
  },

  {
    key: 'trajets',
    titre: 'Trajets : détection, découpage et recalcul',
    motsCles: ['trajet', 'coupe en deux', 'decoupe', 'segmentation', 'recalcul', 'recalculer', 'historique', 'replay', 'rejouer', 'distance', 'kilometrage'],
    contenu: `Un trajet est détecté automatiquement : il démarre quand le véhicule roule de façon
confirmée (environ 30 secondes), et se termine à la coupure du contact, sur un arrêt prolongé, ou
après un délai sans donnée.

Pourquoi un déplacement apparaît parfois coupé en deux ou plus :
- le contact a été coupé puis remis (arrêt livraison, pause, plein) ;
- le boîtier a perdu le réseau au milieu du parcours, et la reprise a été comptée comme un nouveau
  départ ;
- l'arrêt a dépassé le seuil de clôture.

C'est corrigeable : un recalcul repasse sur la période et reconstruit le découpage à partir de
toutes les positions reçues, y compris celles arrivées en désordre. Un recalcul automatique tourne
en continu sur les données récentes ; un administrateur peut aussi en déclencher un sur une période
précise. Après recalcul, les trajets sont recréés : les analyses sont refaites, et une note écrite
sur un trajet peut ne plus être rattachée au même segment.

Chaque trajet garde sa distance, sa durée, ses vitesses moyenne et maximale, et son tracé. Le tracé
est calé sur le réseau routier quand c'est possible, ce qui explique qu'il ne suive pas exactement
les points bruts.

Un mode replay rejoue le trajet sur la carte, coloré par vitesse, avec les arrêts et les excès
superposés. Une note libre et un conducteur peuvent être attachés à chaque trajet.`,
  },

  {
    key: 'analyse-trajet',
    titre: 'Analyse d\'un trajet, éco-score et excès de vitesse',
    motsCles: ['analyse', 'eco score', 'ecoscore', 'exces', 'vitesse', 'limite', 'a-coups', 'ralenti', 'arrets', 'trust score', 'confiance', 'recit', 'conseils'],
    contenu: `Chaque trajet peut être analysé. L'analyse est CALCULÉE, pas devinée : distance, temps
roulant, vitesses, arrêts de 4 minutes ou plus, qualité du signal GPS, excès, à-coups (freinages et
accélérations brusques), temps de ralenti, éco-score sur 100, consommation et CO2 estimés. Elle est
enregistrée une fois et réutilisée partout.

Les excès de vitesse sont confrontés à la limite légale réelle de la route empruntée, récupérée
depuis la cartographie ouverte OpenStreetMap.

Point important : quand la limite d'une portion n'est pas connue, AUCUN excès n'est affirmé sur
cette portion. L'analyse indique alors que les limites ne sont pas toutes connues. "Aucun excès
signalé" ne veut donc pas dire "aucun excès commis" : cela peut vouloir dire que la référence
manquait. Ces limites manquantes se complètent progressivement.

L'indice de confiance (Trust Score) note de 0 à 100 la fiabilité de la donnée GPS du trajet : peu de
points, gros écarts entre deux positions ou signal dégradé font baisser cette note. Un trajet avec un
indice faible doit être lu avec prudence.

Un récit peut être généré : il met en mots les chiffres de l'analyse et propose des conseils
d'éco-conduite. Ce récit ne recalcule rien, il commente l'analyse existante. Il n'est disponible que
si l'assistance intelligente est activée pour la société.`,
  },

  {
    key: 'scores-conduite',
    titre: 'Scores de conduite A à E et classement',
    motsCles: ['score', 'note', 'classement', 'podium', 'rang', 'conduite', 'eco conduite', 'competition', 'a b c d e'],
    contenu: `Les éco-scores des trajets sont agrégés par véhicule, par conducteur et par groupe, puis
traduits en note lettrée : A à partir de 85, puis B, C, D et E. Le détail montre le nombre de trajets,
les kilomètres, les excès, les à-coups, les litres et le CO2.

Un classement compare les entités entre elles : note, rang, et écart à la moyenne de la flotte.

Trois causes fréquentes de score qui semble injuste :
- des trajets très courts, où un seul freinage pèse lourd dans la moyenne ;
- des limites de vitesse inconnues sur le parcours, qui empêchent de créditer une conduite conforme ;
- des trajets non analysés : un trajet sans analyse n'entre pas dans le score.

Le score se recalcule quand les trajets sous-jacents sont réanalysés.`,
  },

  {
    key: 'carburant',
    titre: 'Carburant : consommation réelle, pleins et stations',
    motsCles: ['carburant', 'essence', 'gazole', 'plein', 'consommation', 'litres', 'station', 'prix', 'cout', 'conso'],
    contenu: `La consommation est d'abord estimée à partir du type de véhicule et de son usage. Elle
devient RÉELLE dès que les pleins sont saisis : en enregistrant les pleins (litres, montant, plein
complet ou non, compteur, station), l'application calcule la consommation vraie entre deux pleins
complets. La valeur réelle prime alors partout sur l'estimation, avec un indice de confiance qui
monte avec le nombre de pleins enregistrés.

Les passages en station sont détectés automatiquement : quand un arrêt correspond à une
station-service connue, il est enregistré avec le prix du carburant relevé à cette date. Les prix
proviennent du service public français des prix à la pompe, et couvrent gazole, SP95, SP98, E10, E85
et GPL.

Le rapport carburant par véhicule montre les passages, leur fréquence, les stations classées, les
prix minimum, maximum, moyen et dernier constaté, ainsi que le coût au prix réel comparé au prix
négocié de la flotte.

La détection de station est un service au mieux : une station très récente, mal référencée, ou un
arrêt à plus de 160 mètres de la borne peut ne pas être reconnu.`,
  },

  {
    key: 'zones',
    titre: 'Zones et couloirs (géofences)',
    motsCles: ['zone', 'geofence', 'geofencing', 'perimetre', 'cercle', 'polygone', 'couloir', 'corridor', 'entree', 'sortie'],
    contenu: `Trois formes de zones existent : le cercle (un centre et un rayon), le polygone (une forme
libre d'au moins trois points), et le couloir (un itinéraire tracé avec une largeur, pour surveiller
un parcours plutôt qu'un lieu).

Chaque zone déclenche à l'entrée, à la sortie, ou aux deux. Elle peut s'appliquer à toute la flotte
ou à une liste de véhicules choisis. Une couleur peut lui être attribuée pour la repérer sur la carte.

Un franchissement génère une alerte nommant la zone, en direct.

Pour éviter les fausses alertes quand un véhicule stationne pile sur une frontière, un même
franchissement (même véhicule, même zone, même sens) n'est compté qu'une fois par minute. Si des
allers-retours d'alertes persistent, c'est généralement que la zone est trop petite par rapport à la
précision GPS du lieu : élargir légèrement le rayon suffit.

Des zones peuvent être importées en masse depuis un fichier de cartographie.`,
  },

  {
    key: 'alertes',
    titre: 'Alertes : types, acquittement et escalade',
    motsCles: ['alerte', 'alarme', 'notification', 'sos', 'acquitter', 'accuser', 'critique', 'batterie', 'choc', 'remorquage', 'escalade'],
    contenu: `Le centre d'alertes rassemble 24 types d'événements sur trois niveaux : information,
avertissement et critique. On y trouve notamment le SOS, la coupure d'alimentation, l'accident et la
collision, le remorquage, le retrait du boîtier, le démarrage non autorisé, la batterie faible,
l'excès de vitesse, l'entrée et la sortie de zone, le mouvement moteur éteint, l'ouverture de capot ou
de porte, la vibration, le freinage, l'accélération et le virage brusques, la fatigue, la perte de
signal GPS, l'arrêt prolongé, l'échéance de maintenance et le déclenchement d'une surveillance.

Les alertes qui arrivent en rafale sur un même véhicule et de même type sont regroupées en une seule
carte, avec le détail dépliable, pour éviter de noyer l'écran.

Une alerte s'acquitte individuellement ou en bloc. Un compteur distingue les non lues des critiques.

Les alertes critiques non acquittées sont réémises automatiquement vers un contact d'escalade après
un délai réglé (10 minutes par défaut). C'est la raison la plus fréquente d'une notification reçue
deux fois : la première n'avait pas été acquittée.

Les alertes se filtrent par type, niveau, véhicule et état d'acquittement.`,
  },

  {
    key: 'notifications',
    titre: 'Notifications : canaux et règles',
    motsCles: ['notification', 'push', 'email', 'mail', 'sms', 'whatsapp', 'recevoir', 'ne recois pas', 'canal', 'regle'],
    contenu: `Les notifications partent sur plusieurs canaux : dans l'application (toujours), notification
push sur le navigateur ou le téléphone, e-mail, SMS et WhatsApp.

Des règles définissent qui reçoit quoi : par type d'alerte (ou tous les types) et éventuellement pour
un véhicule précis, avec les canaux choisis. Les règles se cumulent.

Les notifications push fonctionnent sur plusieurs appareils à la fois. Une alerte critique reste
affichée jusqu'à consultation et fait vibrer l'appareil.

Raisons habituelles de ne rien recevoir :
- les notifications du navigateur n'ont pas été autorisées sur cet appareil, ou l'ont été puis
  refusées ensuite ;
- aucune règle ne couvre ce type d'alerte, ou elle est limitée à d'autres véhicules ;
- pour le SMS, une protection limite les envois à un message par type et par destinataire toutes les
  5 minutes, afin d'éviter les rafales ;
- le numéro de téléphone du profil n'est pas renseigné au format international.

Un rapport hebdomadaire est envoyé par e-mail chaque lundi matin, avec le PDF de la semaine écoulée
en pièce jointe. Il n'est pas envoyé si la période ne contient aucun trajet.`,
  },

  {
    key: 'surveillance',
    titre: 'Surveillance antivol',
    motsCles: ['surveillance', 'antivol', 'vol', 'armer', 'desarmer', 'vibration', 'choc', 'sensibilite', 'nuit'],
    contenu: `Chaque véhicule peut recevoir un profil de surveillance : mode, sensibilité, déclencheurs,
plage horaire et destinataires.

Trois modes : désactivée, permanente (24h/24), ou sur plage horaire (avec jours choisis, la plage
pouvant passer minuit).

La sensibilité se règle en trois niveaux et pilote le seuil de choc du boîtier. Les déclencheurs
possibles sont la vibration, le mouvement et l'ouverture de porte. Sur un véhicule armé, l'événement
correspondant lève une alerte critique.

L'armement et le désarmement peuvent être manuels ou automatiques selon la plage horaire. Un armement
manuel échoue si le boîtier est hors ligne à cet instant : la commande doit lui parvenir.

Chaque déclenchement est journalisé avec sa position et sa vitesse, puis qualifié : en attente,
acquitté, vol confirmé, ou fausse alerte, avec des notes. Des destinataires supplémentaires peuvent
être ajoutés par véhicule.`,
  },

  {
    key: 'moteur',
    titre: 'Coupure et remise du moteur à distance',
    motsCles: ['couper', 'coupure', 'moteur', 'bloquer', 'demarrer', 'rallumer', 'redemarrer', 'coupe circuit', 'non verifiable', 'refus'],
    contenu: `Le moteur peut être coupé et rétabli à distance depuis la carte, la liste des véhicules ou
la fiche véhicule.

Garde-fous, volontaires et non contournables :
- la coupure n'est autorisée qu'à faible vitesse (20 km/h maximum) et avec une position récente et
  valide. Au-delà, elle est refusée : on ne coupe jamais un véhicule en circulation ;
- le rétablissement, lui, est toujours possible ;
- une seule coupure peut être en cours à la fois sur un véhicule, pour éviter les doubles envois.

Sur la confirmation : le boîtier ne renvoie pas d'accusé électrique fiable. La preuve qu'une coupure a
pris effet est la chute du contact. Si le véhicule était DÉJÀ à l'arrêt au moment de la commande,
celle-ci est marquée "non vérifiable" — ce n'est pas un échec, c'est l'absence de preuve. L'ordre a
été transmis, mais rien ne permet d'affirmer qu'il a agi. Ce choix évite d'annoncer un succès qui
n'en est peut-être pas un.

Si la commande ne peut pas passer par la liaison directe du boîtier, elle est retentée par SMS. Si
les deux échouent, la commande est marquée en échec et une alerte est levée.

Une coupure peut aussi venir d'un planning horaire ou du rôle veilleur de nuit. Une commande manuelle
neutralise le planning pendant une heure.

Tout l'historique des coupures est conservé, avec l'auteur : un utilisateur, le planning, le boîtier
ou le système.`,
  },

  {
    key: 'boitier',
    titre: 'Boîtier GPS : commandes, fréquence de position, installation',
    motsCles: ['boitier', 'tracker', 'traceur', 'imei', 'commande', 'redemarrer boitier', 'fix', 'frequence', 'batterie', 'installation', 'pose', 'sim'],
    contenu: `Un catalogue de commandes permet d'agir sur le boîtier : demander son statut ou une position
immédiate, le redémarrer, régler la fréquence de position, activer l'économie d'énergie, régler les
alarmes de vitesse et de mouvement, la détection de choc et sa sensibilité, le fuseau horaire, les
paramètres réseau. Les commandes moteur sont volontairement exclues de ce catalogue : elles passent
par le coupe-circuit dédié, avec ses propres garde-fous.

Une commande peut être programmée pour plus tard, et annulée tant qu'elle n'est pas partie. Chaque
commande attend un accusé du boîtier, avec un délai maximum. En cas d'échec, un diagnostic concret est
proposé : boîtier hors ligne, problème de réseau mobile, version du boîtier, antenne.

La fréquence de position peut s'adapter automatiquement à l'état du véhicule : rapprochée en
mouvement, espacée à l'arrêt prolongé. Cela économise la batterie et les données mobiles. C'est ce qui
explique qu'un véhicule stationné remonte moins souvent sa position — ce n'est pas une panne.

Un boîtier qui échoue plusieurs fois d'affilée est signalé comme défaillant. Les boîtiers inconnus qui
tentent de se connecter sont listés pour être rattachés en un clic.

L'installation physique se planifie : un planning de poses par client, avec les tâches ordonnées
(date, plaque, boîtier, carte SIM). À la fin d'une pose, le véhicule et son boîtier sont créés
automatiquement. Un lien public permet à un client de choisir lui-même son créneau de rendez-vous.`,
  },

  {
    key: 'agenda',
    titre: 'Agenda, maintenance et réservations',
    motsCles: ['agenda', 'calendrier', 'reservation', 'reserver', 'maintenance', 'entretien', 'vidange', 'controle technique', 'incident', 'immobilise', 'proposition'],
    contenu: `L'agenda regroupe trois types d'événements : maintenance, incident et réservation. Un
événement peut immobiliser le véhicule, qui devient alors indisponible à la réservation.

Des plans de maintenance récurrents gèrent les échéances du type "tous les X mois" ou "tous les X
kilomètres". Le kilométrage est estimé à partir de la distance GPS cumulée. Un rappel part
automatiquement au préavis choisi. Une fois l'entretien fait, il s'enregistre et l'échéance suivante
se recale.

Les réservations suivent deux états : demandée (n'immobilise pas le véhicule) puis confirmée
(immobilise). Deux réservations ne peuvent pas se chevaucher sur le même véhicule : la seconde est
refusée, y compris si les deux partent au même instant. L'application peut proposer les véhicules
libres correspondant au besoin (nombre de places, sièges enfant, équipements), en privilégiant les
véhicules peu utilisés.

Un lien public permet à un tiers de demander une réservation sans compte. Il décrit son besoin ; c'est
l'application qui choisit les véhicules libres, sans jamais lui révéler la composition de la flotte.
Le besoin peut être dicté à la voix, l'application en extrait le créneau, la destination et le nombre
de places.

Un agent d'optimisation observe les trajets récurrents sur dix semaines et projette les prochaines
occurrences sur quinze jours. Selon le réglage, il propose des créneaux à valider, ou crée
directement les réservations au-dessus d'un seuil de confiance. La détection des habitudes est
entièrement calculée, sans intelligence artificielle. Les propositions restent en attente tant que
personne ne les valide ou ne les refuse.`,
  },

  {
    key: 'vehicules',
    titre: 'Véhicules, groupes, capacités et conducteurs',
    motsCles: ['vehicule', 'voiture', 'camion', 'plaque', 'immatriculation', 'groupe', 'places', 'conducteur', 'chauffeur', 'affecter'],
    contenu: `La fiche véhicule regroupe plaque, type, marque, modèle, année, couleur, énergie, nombre de
places, sièges enfant et équipements. Les types disponibles sont voiture, camion, fourgon, moto, vélo,
bus, engin de chantier et autre. Les énergies sont diesel, essence, électrique, hybride et autre. Une
plaque ne peut exister qu'une fois par société.

Les véhicules peuvent être rassemblés en groupes. Un véhicule appartient à un seul groupe à la fois.
Les groupes servent aussi à donner des accès : un utilisateur peut être limité à un groupe.

L'onglet des capacités permet de renseigner en masse les places, sièges enfant, énergie et
équipements — ce sont ces informations qui permettent de proposer le bon véhicule lors d'une
réservation.

Les conducteurs se gèrent séparément : nom, téléphone, e-mail, numéro de permis, couleur et notes. Un
conducteur peut être désigné comme conducteur courant d'un véhicule ; il est alors attribué
automatiquement aux trajets de ce véhicule, et reste modifiable à la main sur chaque trajet.

À savoir : il n'existe pas d'identification du conducteur par code, badge ou clé à bord. L'attribution
du conducteur est une affectation faite depuis l'application, pas une reconnaissance automatique de la
personne au volant.

Un conducteur archivé n'est pas supprimé : son historique reste consultable.`,
  },

  {
    key: 'horaires',
    titre: 'Horaires de service et coupure automatique',
    motsCles: ['horaire', 'plage', 'planning', 'weekend', 'ferie', 'coupure automatique', 'autorise', 'interdit'],
    contenu: `Chaque véhicule peut recevoir des plages horaires d'utilisation autorisée, jour par jour, avec
jusqu'à trois plages quotidiennes. En dehors de ces plages, le moteur est coupé automatiquement, puis
rendu au retour dans la plage.

Les plages gèrent les nuits qui passent minuit, les jours entièrement désactivés, les jours fériés du
pays et des dates particulières.

La coupure automatique respecte les mêmes précautions que la coupure manuelle : jamais un véhicule en
mouvement, ni un véhicule arrêté depuis trop peu de temps (10 minutes par défaut). Si le véhicule roule
encore à l'heure prévue, la coupure est reportée et l'écran l'indique avec le motif de l'attente. Si le
boîtier est hors ligne, la coupure est reportée aussi.

Une page dédiée montre l'état de toute la flotte : la fenêtre horaire en cours et un compte à rebours
avant coupure ou remise. Des horaires peuvent être posés en masse sur toute la flotte, avec un aperçu
préalable de ce que cela couperait immédiatement.

Une commande manuelle prend le pas sur le planning pendant une heure.`,
  },

  {
    key: 'rapports',
    titre: 'Rapports et exports',
    motsCles: ['rapport', 'pdf', 'excel', 'csv', 'export', 'telecharger', 'imprimer', 'hebdomadaire', 'statistiques'],
    contenu: `Plusieurs formats de sortie existent :

- Un rapport de flotte en PDF : période, indicateurs (véhicules actifs, trajets, kilomètres, durées,
  vitesses, consommation, coût carburant estimé et constaté), alertes, meilleurs véhicules et trajets
  récents. Les sections et le nombre de trajets sont paramétrables.
- Un export Excel mis en forme par véhicule, avec jusqu'à quatre feuilles : synthèse, trajets, jour par
  jour, et passages en station avec les prix relevés.
- Un export CSV brut pour les positions, trajets, alertes et commandes, au format lisible par Excel en
  français.

Les exports volumineux sont plafonnés pour rester exploitables. Quand la limite est atteinte, le
fichier porte la mention "PARTIEL" dans son nom : c'est un signal, pas une erreur, et il faut réduire la
période demandée.

Un rapport d'analyse de vitesse existe pour les dossiers à valeur juridique : couverture, profil de
vitesse, chronologie point par point, appréciation de la fiabilité GPS et rappel du cadre légal.

Le rapport PDF hebdomadaire part automatiquement par e-mail chaque lundi matin.`,
  },

  {
    key: 'roles-permissions',
    titre: 'Rôles, permissions et périmètre d\'accès',
    motsCles: ['role', 'permission', 'droit', 'acces', 'ne vois pas', 'grise', 'interdit', 'refuse', 'administrateur', 'gestionnaire', 'observateur', 'veilleur', 'depot'],
    contenu: `Sept rôles existent :

- Administrateur plateforme : tout, sur toutes les sociétés. Réservé à l'éditeur.
- Administrateur de flotte : tout, dans sa propre société uniquement.
- Gestionnaire de flotte : gère les véhicules, les groupes, les zones ; consulte et acquitte les
  alertes ; consulte et exporte les rapports, les trajets et les scores ; saisit les pleins ; gère les
  conducteurs et les horaires. Par défaut il n'a ni la coupure moteur, ni la configuration des alertes,
  ni la gestion des utilisateurs, ni les réservations. Ces droits peuvent lui être accordés au cas par cas.
- Observateur : lecture seule.
- Veilleur de nuit : voit les véhicules et coupe ou redémarre le moteur, rien d'autre. Il ne peut
  jamais désactiver un planning horaire.
- Conducteur : voit ses véhicules, et selon son périmètre peut débloquer le moteur ou activer le mode
  vie privée.
- Dépôt : rôle latéral, en lecture seule, borné par une mission. Il voit un camion pendant la durée de
  la mission qui le désigne, et rien en dehors.

En plus du rôle, chaque utilisateur a un PÉRIMÈTRE : tous les véhicules, un groupe, ou une liste de
véhicules précis. Le plus spécifique l'emporte.

C'est l'explication la plus fréquente d'un écran vide ou d'un bouton grisé : le droit existe mais le
périmètre ne couvre pas ce véhicule, ou l'inverse. Un utilisateur qui n'est rattaché à aucune société
ne voit rien du tout — c'est volontaire.

Les invitations portent le rôle, le périmètre et les permissions dès l'envoi. Personne ne peut donner
plus de droits qu'il n'en possède lui-même.`,
  },

  {
    key: 'vie-privee',
    titre: 'Mode vie privée et données personnelles',
    motsCles: ['vie privee', 'rgpd', 'donnees personnelles', 'masquer', 'confidentialite', 'suppression', 'conservation'],
    contenu: `Un mode vie privée peut être activé véhicule par véhicule. Il agit à deux niveaux : plus
aucune position n'est enregistrée tant qu'il est actif, et l'historique existant est masqué partout dans
l'application.

Ce masquage est RÉVERSIBLE : les données ne sont pas détruites, elles sont rendues invisibles. Désactiver
le mode redonne accès à l'historique. Chaque activation et désactivation est tracée, avec un motif
facultatif.

Les journaux d'activité des utilisateurs sont conservés 90 jours. Les traces des actions de modification
sont conservées un an.

L'application n'enregistre aucun mot de passe : l'authentification est déléguée à un service dédié.`,
  },

  {
    key: 'compte',
    titre: 'Connexion, mot de passe et profil',
    motsCles: ['connexion', 'connecter', 'mot de passe', 'oublie', 'reinitialiser', 'profil', 'compte', 'deconnecte', 'session', 'invitation'],
    contenu: `La connexion se fait par e-mail et mot de passe. L'application ne stocke jamais le mot de
passe : il est vérifié par un service d'authentification séparé.

En cas d'oubli, la procédure de réinitialisation envoie un lien par e-mail. Par sécurité, l'écran affiche
toujours le même message, que l'adresse existe ou non. Un administrateur peut également déclencher une
réinitialisation.

Une session se prolonge automatiquement. Une déconnexion inattendue survient si le compte a été suspendu
ou supprimé : la coupure intervient alors en moins d'une minute.

Le profil permet de renseigner prénom, nom, téléphone au format international et contact d'escalade. Le
téléphone est nécessaire pour recevoir les alertes par SMS.

Une invitation reçue par e-mail est valable 24 heures. Passé ce délai, il faut en demander une nouvelle ;
renvoyer une invitation annule automatiquement la précédente.`,
  },

  {
    key: 'ia',
    titre: 'Fonctions intelligentes et leur activation',
    motsCles: ['ia', 'intelligence artificielle', 'assistant', 'recit', 'automatique', 'desactive', 'indisponible', 'copilote'],
    contenu: `Plusieurs fonctions font appel à une intelligence artificielle : le récit d'un trajet et ses
conseils, l'explication des propositions de l'agenda, l'aide au remplissage des caractéristiques des
véhicules, le classement des véhicules pour un besoin donné, et la compréhension d'une demande de
réservation dictée à la voix.

Ces fonctions sont un COMPLÉMENT. Tout ce qui est chiffré — analyse de trajet, éco-score, excès,
consommation, détection des habitudes de l'agenda — est calculé sans intelligence artificielle et reste
disponible même quand celle-ci est coupée. L'application fonctionne entièrement sans.

Un interrupteur, réglé par société, active ou coupe ces fonctions. Quand elles sont coupées, les boutons
correspondants disparaissent au lieu d'échouer. C'est l'explication habituelle d'un bouton de récit
absent.

Le principe appliqué partout : l'intelligence artificielle PROPOSE, l'application VALIDE. Une suggestion
n'est jamais appliquée sans contrôle, les valeurs hors bornes sont ignorées, et une réponse incomplète est
rejetée plutôt que devinée.`,
  },

  {
    key: 'assistance-limites',
    titre: 'Ce que cette assistance peut et ne peut pas faire',
    motsCles: ['assistance', 'aide', 'support', 'contacter', 'humain', 'conseiller', 'urgent', 'rappel'],
    contenu: `Cette assistance RÉPOND, elle n'AGIT PAS. Elle ne peut rien modifier : ni couper un moteur, ni
créer une réservation, ni changer un réglage, ni supprimer une donnée. Elle explique comment faire, et
c'est à l'utilisateur d'agir depuis l'écran correspondant.

Elle consulte uniquement les données de la personne qui pose la question, dans le périmètre qui est déjà
le sien. Elle ne voit jamais les données d'une autre société, ni celles d'un collègue auquel cette
personne n'a pas accès.

Elle ne traite pas les urgences. Un vol en cours, un véhicule accidenté ou toute situation critique doivent
passer par un contact humain : une demande de rappel urgent prévient directement les responsables.

Pour tout ce qui touche à la facturation, aux contrats et aux conditions commerciales, il faut passer par
un conseiller.`,
  },
];

/**
 * Sommaire compact des sujets — c'est ce qui est envoyé à l'étape de CLASSEMENT.
 *
 * On n'envoie jamais toute la base : elle pèse plusieurs dizaines de milliers de caractères, et
 * la facturer à chaque question pour n'en utiliser qu'un ou deux sujets serait absurde. Le
 * classement voit uniquement les clés, les titres et les mots-clés ; seuls les sujets retenus
 * sont ensuite chargés en entier.
 */
export function sommaireConnaissances(): string {
  return KNOWLEDGE.map((t) => `- ${t.key} : ${t.titre} (${t.motsCles.slice(0, 8).join(', ')})`).join('\n');
}

/** Vrai si la clé désigne un sujet connu. Les clés inventées sont ignorées, jamais interprétées. */
export function estSujetConnu(key: unknown): boolean {
  return typeof key === 'string' && KNOWLEDGE.some((t) => t.key === key);
}

/**
 * Assemble le contenu des sujets demandés, dans l'ordre de la base (stable, donc mise en cache
 * possible côté fournisseur). Les clés inconnues sont ignorées silencieusement — un sujet inventé
 * par le modèle ne doit pas produire une section vide qu'il commenterait quand même.
 */
export function contenuSujets(keys: readonly string[]): KnowledgeTopic[] {
  const demandes = new Set(keys.filter(estSujetConnu));
  return KNOWLEDGE.filter((t) => demandes.has(t.key));
}
