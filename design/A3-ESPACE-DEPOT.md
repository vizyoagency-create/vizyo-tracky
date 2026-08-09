# A3 — L'espace dépôt : les écrans

## Pages concernées

Nouvelle route `/depot`, 4 onglets, 3 déclinaisons.

| Onglet | Route | Maquette |
|---|---|---|
| Carte live | `/depot` | `Espace Depot Refonte.dc.html` § 01 (PC), § 04 (iOS), § 05 (Android) |
| Missions | `/depot/missions` | § 01 panneau gauche, § 04–05 |
| Historique | `/depot/history` | § 06 (PC), § 07 (iOS + Android) |
| Documents | `/depot/documents` | § 06 rail droit, § 07 |
| Modales | — | § 02 (trajet, camion, partage), § 03 (onboarding, incident, export) |

Fichiers à créer : `apps/web/src/app/features/depot/`.

---

## 1. Carte live — l'écran d'accueil

### Structure PC (1600 × 1000)

Trois zones : menu latéral 244 px · panneau missions 384 px · carte.

**En-tête** — titre « Missions du jour », date, dépôt. Puis une pastille verte pulsée : « 4 camions en mission ». À droite : Signaler · Exporter · **Partager un suivi** (bouton accent).

**Panneau missions** — filtres En cours / Planifiées / Terminées, puis les cartes de mission. Chacune porte : référence, statut, trajet, créneau, plaque, conducteur avec bouton d'appel, et distance restante pour la mission sélectionnée.

En bas du panneau, un encart tireté qui **nomme ce qui est absent** :

> Les 3 autres camions de votre transporteur ne sont pas sur vos missions : ils ne vous sont pas visibles.

Cette phrase est importante. Sans elle, un dépôt qui sait que le transporteur a 7 camions se demande si l'outil est cassé. Avec elle, l'absence devient une garantie — et c'est exactement l'argument qui a permis au transporteur d'ouvrir l'accès.

**Carte** — tuiles CartoDB clair/sombre selon le thème, comme `Carte Refonte`. Marqueurs de camion avec halo pulsé pour les missions en cours, rouge pour les retards. Marqueur tireté violet pour le dépôt de départ.

**Barre basse** — le camion sélectionné : plaque, mission, conducteur, vitesse, arrivée estimée avec l'avance ou le retard. Deux boutons : « Le camion » et « Voir le trajet ».

### iPhone (390 × 844)

Carte plein écran. Barre d'onglets basse à 4 entrées (Carte · Missions · Historique · Compte). En-tête flottant avec le monogramme du transporteur et un bouton de partage. Puces de filtre horizontales. Feuille basse à 330 px avec les missions, redimensionnable.

### Android (412 × 915)

Menu latéral (pas de barre d'onglets — les 3 boutons système occupent déjà le bas). Top app bar avec hamburger. Puces filtres M3. Feuille basse 28 dp, poignée 32 × 4. **FAB étendu « Partager »**, remonté à 100 px quand un snackbar est affiché.

### Rafraîchissement

WebSocket sur `depot:mission:<missionId>`, une room par mission en cours. Repli en polling toutes les 20 s si le socket tombe.

L'indicateur « rafraîchie il y a 12 s » est un vrai compteur, pas un texte fixe. Au-delà de 60 s sans message : « Connexion perdue · nouvelle tentative ».

---

## 2. Missions

Même liste que le panneau de la carte, en pleine largeur, avec le détail de chaque mission accessible.

**Tri** : en cours d'abord (les retards en tête), puis planifiées par heure de départ, puis terminées.

**État vide** — le plus important à soigner, c'est le premier écran d'un nouveau dépôt :

> **Aucune mission pour l'instant**
> Votre transporteur vous assignera des missions depuis son espace. Vous recevrez un e-mail à chaque nouvelle mission.
> [Comment ça marche]

---

## 3. Historique

Maquette § 06 (PC), § 07 (mobile).

**Filtres** : 7 jours / 30 jours / Ce mois · camion · destination.

**4 KPI** : missions livrées · % à l'heure · durée moyenne · retard moyen avec le nombre de cas.

Le « % à l'heure » est l'indicateur que le dépôt regarde vraiment : c'est la note de son transporteur. Il se calcule sur les missions `DONE` de la période : `actualEndAt <= endAt`.

**Tableau** : Réf. · Trajet · Date · Créneau réel · Camion · Conducteur · Distance · Arrêts · Ponctualité · actions (voir, PDF).

Pied de tableau : « 6 trajets sur 23 · les trajets hors de vos missions ne figurent pas dans cet historique. » — même principe que l'encart de la carte.

**Mobile** : cartes plutôt que tableau. 3 cartes visibles sur iPhone, 4 sur Android, le reste au défilement.

**Conservation** : 12 mois. Passé ce délai les trajets sortent de l'espace dépôt. Écrit dans l'interface, pas seulement dans les CGU.

---

## 4. Documents

Rail droit sur PC, onglet plein écran sur mobile.

| Type | Origine | Format |
|---|---|---|
| Rapport hebdomadaire | Généré tous les lundis 08:00 | PDF |
| Bon de livraison | Par mission terminée | PDF |
| Export de période | À la demande | PDF ou CSV |

**Rapport automatique** — interrupteur activé par défaut, « chaque lundi à 08:00 », par e-mail. Le dépôt peut le couper.

---

## 5. Les modales

### Détail d'un trajet (§ 02)

4 tuiles : distance · durée · arrêts · arrivée estimée (en accent).
Mini-carte avec le tracé et la position actuelle.
**Déroulé horodaté** : chaque étape avec son heure réelle et le temps passé sur place. L'étape à venir en tireté avec l'heure estimée.

Le temps passé sur place est ce qui distingue « le camion est parti à 8h15 » de « le camion a attendu 14 minutes au premier point ». C'est l'information qui permet au dépôt de comprendre un retard sans appeler.

Pied : Exporter ce trajet · Signaler un incident · **Partager le suivi**.

### Détail d'un camion (§ 02)

Plaque, modèle, transporteur, conducteur, téléphone masqué, mission en cours, missions du mois avec le taux de ponctualité.

Encart de fermeture, avec l'icône cadenas :

> Hors fenêtre de mission, la position de ce camion vous est masquée. Vous ne voyez ni ses trajets privés ni les autres véhicules du transporteur.

### Signaler un incident (§ 03)

Mission concernée (pré-remplie) · motif en puces (Retard / Marchandise / Accès dépôt / Autre) · texte libre.

`POST /depot/incidents` → notification au transporteur + e-mail. L'incident apparaît dans l'agenda du transporteur comme un événement, pas comme un simple message : il doit atterrir là où le gestionnaire regarde.

### Export (§ 03)

Période en puces · format PDF (rapport) ou CSV (données brutes) · le nombre de trajets concernés affiché avant de générer.

Sur mobile, ajouter le poids estimé (« ≈ 1,2 Mo ») — un export lancé en 4G sans avertissement est une mauvaise surprise. Règle déjà posée pour `pdf-export-modal` dans le kit partagé.

### Onboarding première connexion (§ 03)

Animation HTML/CSS en 3 étapes : la mission est créée → le camion roule → la livraison est tracée. Boucle de 12 s, arrêtée sous `prefers-reduced-motion`.

Deux sorties : « Commencer » et « Revoir plus tard ». Un lien discret vers `decouvrir-depot.html`.

Affichée une fois, à la première connexion. Réaccessible par « Comment ça marche » dans le menu.

---

## 6. États et cas particuliers

| Cas | Écran | Comportement |
|---|---|---|
| Aucune mission | Carte | Carte centrée sur le dépôt, encart « Aucune mission en cours » |
| Mission planifiée non démarrée | Carte | Dans la liste, pas sur la carte. « Le suivi démarrera à 08:15 » |
| Position indisponible | Carte | Dernière position grisée + « indisponible depuis 14 min ». Jamais présentée comme actuelle |
| Socket perdu | Carte | Bandeau « Connexion perdue · nouvelle tentative » |
| Mission terminée pendant la consultation | Carte | Le marqueur disparaît avec une transition, un toast explique |
| Historique vide | Historique | « Vos missions terminées apparaîtront ici » |
| Moins de 3 missions terminées | Historique | Les KPI affichent un tiret expliqué : « 2 missions seulement, un taux demande 5 missions » |
| Export en cours | Export | État de chargement, puis téléchargement. Au-delà de 8 s : « le réseau est lent · Annuler » |
| Accès retiré | Toutes | Déconnexion + « Votre accès a été retiré par votre transporteur » |

---

## 7. Règles d'interface

1. **Aucun compteur de flotte.** Tout chiffre affiché se calcule sur les missions du dépôt.
2. **Aucune donnée de coût, de score, de consommation.** Ce sont les données d'exploitation du transporteur.
3. **La plaque est la clé.** Jamais d'identifiant interne visible ni dans l'URL.
4. **Le téléphone reste masqué** à l'écran (`06 12 •• •• 47`). Le bouton d'appel passe par un endpoint qui journalise.
5. **Marque du transporteur en tête**, Vizyo Tracky en pied de menu à 12 px.
6. **Lecture seule partout.** Aucun bouton qui écrit sur un véhicule. Les deux seules écritures d'un dépôt : signaler un incident, générer un lien de partage.

---

## 8. Impacts

### Backend

Endpoints listés en A1 § 4. Trois points d'attention :

- `GET /depot/history` renvoie les KPI **calculés côté serveur**. Un calcul côté client obligerait à servir toutes les missions.
- `POST /depot/exports` génère le fichier borné aux missions du dépôt. Ne pas réutiliser le générateur de `/reports` : ses colonnes exposent des données d'exploitation.
- `GET /depot/documents` : les bons de livraison sont produits à la clôture de mission. Si le transporteur n'en produit pas, l'onglet affiche son état vide sans erreur.

### Frontend

- `features/depot/` : shell, 4 pages, 6 modales
- Réutiliser `mini-map`, `bottom-sheet`, `confirm-modal`, `toast`, `skeleton`, `pdf-export-modal` du kit partagé
- Le composant de carte se réutilise depuis `/map` **avec une configuration restreinte** : pas de calques géofences, pas de lieux clés, pas de sélecteur de véhicules

---

## 9. Critères de recette

| # | Scénario | Attendu |
|---|---|---|
| 1 | Connexion d'un dépôt sans mission | État vide expliqué, pas de carte muette |
| 2 | Mission en cours | Camion sur la carte, position rafraîchie |
| 3 | Mission d'un autre dépôt | Absente de la carte et de l'API |
| 4 | Fin de mission pendant la consultation | Marqueur retiré, toast explicatif |
| 5 | Coupure réseau | Bandeau, puis reprise automatique |
| 6 | Export 7 jours PDF | Fichier borné aux missions du dépôt |
| 7 | Signalement d'incident | Événement créé dans l'agenda du transporteur |
| 8 | iPhone 390 px | Aucun débordement, cibles ≥ 44 px |
| 9 | Android 412 px | Menu latéral, pas de barre d'onglets, FAB présent |
| 10 | Thème clair et sombre | Contrastes ≥ 4,5:1 sur le texte |
