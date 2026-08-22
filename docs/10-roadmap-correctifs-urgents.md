# 10 — Roadmap correctifs urgents (UX & fiabilite)

> ✅ **Historique — livré** *(bandeau posé le 2026-08-22)*. La fin du fichier consigne la
> livraison (tests 90/90 + 119/119, vérification preview). Les cases non cochées datent
> du plan. L'impératif « avant déploiement, exécuter `prisma migrate deploy` » ne vaut
> plus : les migrations sont appliquées par l'entrypoint.

> **Statut :** Draft — 2026-04-26
> **Perimetre :** 4 chantiers UX/fiabilite remontes par l'utilisateur final apres mise en production V1. Ces chantiers sont prioritaires sur la roadmap V2 (`09-roadmap-v2.md`) car ils touchent au coeur de la promesse produit (suivi temps reel fluide, fiabilite des donnees).
> **Source :** retours utilisateur 2026-04-26 (4 points : chargement post-login, experience carte, traces live, rapports/replays).

---

## 0. Synthese executive

| # | Chantier | Severite | Effort MVP | Effort total | Impact UX |
| - | --- | --- | --- | --- | --- |
| 1 | Hydratation immediate des positions au login | 🔴 Critique | ~6h | ~6h | 30s d'attente -> < 1s |
| 2 | Refonte experience carte (la meilleure carte de suivi flotte sur stack mahlem-now) | 🟠 Eleve | ~37h30 (P0) | ~50h (P0+P1+P2) | Multi-fonds, modes camera (follow/heading-up/chase), markers enrichis, interactions metier |
| 3 | Lissage des traces live (interpolation 30s) | 🟠 Eleve | ~9h | ~9h | Traces realistes en virage |
| 4 | Correctifs rapports & replays (km negatifs, tracts aberrants) | 🔴 Critique | ~6h | ~6h | Donnees fiables en reporting |

**Total estime (MVP) :** ~58h30 (~7-8 jours dev pur). Le chantier 2 represente l'essentiel de l'effort car il s'agit d'une refonte profonde : migration Leaflet -> MapLibre GL JS **plus** ajout de toutes les fonctionnalites manquantes pour un produit de suivi flotte de classe pro (multi-fonds, modes camera, popover actions metier, calques, recherche adresse, clustering, mobile bottom-sheet).

Stack et patterns repris de mahlem-now (`D:/www/mahlem-now/libs/platform/src/lib/map.service.ts`) ; le perimetre fonctionnel est specifique a Tracky et va bien au-dela de mahlem-now (qui est une carte de recherche, pas de suivi). Aucun chantier ne casse la base existante : ajouts additifs (colonnes denormalisees, hooks, filtres defensifs) ou migration ciblee (carte) avec API publique des composants conservee.

### Legende statut (alignee §3.1 du roadmap principal)

- ✅ Fait
- 🚧 En cours
- 📋 Planifie
- 💭 Backlog
- ❌ Hors scope

---

## 1. Chantier 1 — Chargement post-connexion (~30s -> < 1s)

### 1.1 Probleme observe

Apres login, l'utilisateur attend ~30 secondes avant de voir apparaitre les vehicules sur la carte. Les vehicules deja a l'arret (donc sans nouvelle trame imminente) ne s'affichent **jamais** tant qu'une nouvelle position GPS n'est pas recue par le serveur TCP.

### 1.2 Cause racine identifiee

L'analyse du code montre une **dependance totale du frontend aux evenements WebSocket "live"** pour peupler la carte, sans aucun mecanisme d'hydratation initiale :

| Couche | Fichier | Constat |
| --- | --- | --- |
| DB | [schema.prisma:152-169](apps/api/prisma/schema.prisma#L152) | Le modele `Tracker` n'a **aucune** colonne denormalisee `lastLat / lastLng / lastTimestamp`. Seule `lastSeenAt: DateTime?` existe. Les positions vivent dans la table `Position` (append-only). |
| API | [realtime.gateway.ts:26-51](apps/api/src/realtime/realtime.gateway.ts#L26) | `handleConnection()` rejoint la room `fleet:{id}` mais n'emet **rien** au client : ni positions historiques, ni snapshot des derniers etats trackers. |
| API | (manquant) | Aucun endpoint REST type `GET /vehicles/last-positions` ou `GET /fleets/:id/snapshot` qui retournerait en bulk les dernieres positions connues. |
| Web | [realtime.service.ts:38-51](apps/web/src/app/core/services/realtime.service.ts#L38) | Au `connect`, seul `loadInitialAlerts()` est appele. Le signal `positions` reste vide tant que des `POSITION_UPDATE` n'arrivent pas. |
| Web | [map.component.ts:123-130](apps/web/src/app/features/map/map.component.ts#L123) | L'effet de mise a jour des markers depend exclusivement de `realtime.positionsList()`. |

**Resultat :** la carte attend la prochaine trame Coban, qui peut tarder jusqu'a 30s (intervalle `fix030s***n` du protocole, cf. [03-protocol-coban-gps403d.md](docs/03-protocol-coban-gps403d.md) §1.3) voire indefiniment si le boitier est en veille moteur.

### 1.3 Solution proposee

Approche hybride en trois temps :

#### A. Denormaliser la derniere position sur le tracker

Ajouter sur le modele `Tracker` les colonnes suivantes (migration Prisma) :

```prisma
model Tracker {
  // ... champs existants
  lastLat        Float?
  lastLng        Float?
  lastSpeedKmh   Float?
  lastHeading    Float?
  lastIgnition   Boolean?
  lastValid      Boolean?
  lastPositionAt DateTime?  // != lastSeenAt (qui est tout contact TCP, login/heartbeat inclus)
}
```

Mettre a jour ces colonnes en une seule transaction dans `PositionsService.ingest()` ([positions.service.ts:62-65](apps/api/src/positions/positions.service.ts#L62)) au moment de l'update existant `lastSeenAt + status`.

> **Pourquoi denormaliser ?** Eviter un `position.findFirst({ orderBy: { timestamp: 'desc' } })` par tracker au moment du snapshot bulk : sur 200 vehicules, c'est 200 requetes ou un sous-select correle. La denormalisation rend la lecture O(1) par tracker.

#### B. Endpoint de snapshot bulk

Nouveau endpoint REST :

```
GET /api/vehicles/snapshot
  -> 200 { items: Array<VehicleSnapshotDto> }

VehicleSnapshotDto = {
  vehicleId, plate, type,
  trackerId, trackerStatus, lastSeenAt,
  lastLat?, lastLng?, lastSpeedKmh?, lastHeading?,
  lastIgnition?, lastPositionAt?, lastValid?
}
```

Retourne tous les vehicules de la flotte (filtre RBAC reutilise depuis `VehiclesService.list`) avec leur derniere position connue. Une seule requete Prisma avec `include: { tracker: true }`.

#### C. Hydratation cote front

Dans `RealtimeService.connect()` ([realtime.service.ts:29](apps/web/src/app/core/services/realtime.service.ts#L29)) ou dans un nouveau `bootstrap(token)` appele depuis `LoginComponent.onSubmit()` :

1. Apres reception du token, **avant** d'ouvrir la socket, faire `GET /api/vehicles/snapshot`.
2. Pour chaque vehicule dont `lastLat/lastLng/lastPositionAt` sont presents, peupler immediatement `realtime.positions` avec un `PositionUpdateEvent` synthetique (flag `hydrated: true` pour distinction debug).
3. Ouvrir la socket en parallele : les vrais `POSITION_UPDATE` ecraseront la position hydratee des leur arrivee.

> **Note :** la condition utilisateur "voiture arretee depuis plus de 10 minutes -> enregistrer ce point comme derniere position connue" est automatiquement satisfaite par cette approche : la derniere position cachee est **toujours** la position d'arret (le boitier transmet meme a l'arret au moins une trame tant que ACC=ON), donc plus besoin d'attendre une nouvelle trame pour afficher la position.

#### D. (Optionnel) Push-bootstrap WS

Pour les **reconnexions** (navigation dans l'app, perte de reseau), enrichir `RealtimeGateway.handleConnection()` ([realtime.gateway.ts:42](apps/api/src/realtime/realtime.gateway.ts#L42)) pour emettre apres le `client.join(...)` un evenement `positions:bootstrap` contenant le snapshot fleet. Le frontend ecoute cet evenement et reapplique l'hydratation.

Avantage : un seul code-path d'hydratation (WS), plus besoin du REST si on accepte d'attendre la handshake socket (~200-500ms).

### 1.4 Taches & estimations

| # | Tache | Fichier(s) | Estimation |
| - | --- | --- | --- |
| 1.A | Migration Prisma (ajout colonnes `last*` sur `Tracker`) | `apps/api/prisma/schema.prisma` + migration | 1h |
| 1.B | MAJ `PositionsService.ingest()` pour ecrire les `last*` | `apps/api/src/positions/positions.service.ts` | 30min |
| 1.C | Endpoint `GET /vehicles/snapshot` + DTO | `apps/api/src/vehicles/vehicles.controller.ts` + service | 2h |
| 1.D | Hydratation cote frontend dans `RealtimeService` | `apps/web/src/app/core/services/realtime.service.ts` | 1h30 |
| 1.E | Tests unitaires (snapshot RBAC, ingestion last\*) | `*.spec.ts` | 1h |
| 1.F | (optionnel) Bootstrap WS sur connexion | `apps/api/src/realtime/realtime.gateway.ts` | 1h |

**Total :** ~6h (sans 1.F), ~7h avec.

### 1.5 Criteres d'acceptation

- [ ] Apres login sur une flotte de 50 vehicules, la carte affiche tous les vehicules en moins de 1.5s (mesure DevTools).
- [ ] Un vehicule arrete depuis 24h apparait immediatement avec son timestamp affiche en grise (UI a prevoir : pastille "il y a X min/h").
- [ ] Les `POSITION_UPDATE` recus pendant l'hydratation sont bien preserves (pas d'ecrasement par snapshot stale).
- [ ] Test E2E : login -> carte peuplee < 1.5s.

---

## 2. Chantier 2 — Refonte experience carte (la meilleure carte de suivi flotte)

### 2.1 Probleme observe

L'experience carte actuelle est jugee "trop basique". L'utilisateur souhaite **la meilleure carte possible pour suivre des vehicules** : differents fonds de carte, modes de camera (suivi, vue d'ensemble, chase 3D), interactions avancees, controles riches. Le projet **mahlem-now** (`D:/www/mahlem-now/`) sert de **reference technique** (stack, patterns d'animation, abstraction `MapService`) mais le perimetre fonctionnel doit etre **adapte au metier flotte**, qui est tres different d'un usage "carte de recherche d'artisan".

### 2.2 Reference technique mahlem-now

L'audit du repo mahlem-now confirme les choix d'architecture a reprendre :

| Element a reprendre | Implementation mahlem-now | Fichier |
| --- | --- | --- |
| Librairie | **MapLibre GL JS 5.24.0** | `D:/www/mahlem-now/package.json` |
| Abstraction | `MapService` (API Leaflet-like sur MapLibre) | `D:/www/mahlem-now/libs/platform/src/lib/map.service.ts` |
| Tuiles OSM | Subdomain expansion `{a,b,c}.tile.openstreetmap.org` | idem |
| Bouton compass | Apparait si `bearing !== 0 \|\| pitch !== 0`, reset via `easeTo({bearing:0,pitch:0}, 400)` | `SearchMapComponent:49-72` |
| Animations | `flyTo({speed:1.4, curve:1.4})`, `panTo` 600ms, `easeTo` 400ms | `MapService` |
| Sub-pixel | `subpixelPositioning: true` | idem |
| Markers SVG viewport-aligned | Restent verticaux quand carte pivote/tilte | idem |
| CSS frosted-glass controls | Frosted backdrop, rounded 12px | `apps/client/src/styles.css:194-222` |

**Ce que mahlem-now n'a PAS et que Tracky doit construire :**

- Pas de **multi-fonds de carte** (uniquement OSM raster).
- Pas de **mode follow / chase / overview / cinema** (carte fixe, l'utilisateur deplace lui-meme).
- Pas de **clustering** (40-50 markers max).
- Pas de **trail / polyline historique** (positions statiques, pas de mouvement).
- Pas de **filtre temps-reel** (pas de signal "online/offline/idle/parked").
- Pas de **drawing tools** (pas de geofences, pas de mesures).
- Pas d'**actions sur marker** (mahlem-now ouvre un drawer ; Tracky doit pouvoir CUT/RESTORE moteur depuis le popup).

### 2.3 Etat des lieux Tracky

| Aspect | Implementation actuelle | Fichier |
| --- | --- | --- |
| Librairie | Leaflet 1.9.4 | [package.json](apps/web/package.json) |
| Tuiles | OpenStreetMap raster unique | [map.component.ts:150](apps/web/src/app/features/map/map.component.ts#L150) |
| Markers | `L.divIcon` SVG, couleurs vitesse | [shared/utils/leaflet-markers.ts](apps/web/src/app/shared/utils/leaflet-markers.ts) |
| Rotation marker | **Uniquement type `OTHER`** (ignoree pour les autres types) | idem |
| Animation | Aucune (`setLatLng` jump direct) | [map.component.ts:202](apps/web/src/app/features/map/map.component.ts#L202) |
| Rotation/pitch carte | ❌ | n/a |
| Modes camera | Free uniquement | n/a |
| Clustering | ❌ | n/a |
| Trail | Polyline brute, capee a 20 points | [map.component.ts:212-238](apps/web/src/app/features/map/map.component.ts#L212) |
| Composants impactes | `MapComponent`, `MiniMapComponent`, `TripReplayComponent`, `GeofenceDialogComponent` | apps/web/src/app/features/{map,reports,geofences}/, apps/web/src/app/shared/ui/mini-map/ |

### 2.4 Specification cible — "la meilleure carte pour suivre une flotte"

Cette section liste l'ensemble des fonctionnalites cibles, structurees par axe. Chaque feature porte un tag de priorite : **P0** (MVP refonte), **P1** (V1.4 immediate), **P2** (iteration suivante).

#### 2.4.1 Stack & fondations (P0)

- **MapLibre GL JS 5.24.0** comme moteur de rendu (WebGL).
- **`MapService`** porte de mahlem-now, etendu pour Tracky (markers heading-rotatifs, sources GeoJSON polylignes, layer cercles geofences, layers polygones).
- **OSM raster** comme fond par defaut (zero changement backend).
- **API publique stable** des composants Tracky : `MapComponent`, `MiniMapComponent`, `TripReplayComponent`, `GeofenceDialogComponent` conservent leurs inputs/outputs.

#### 2.4.2 Fonds de carte multiples (P0)

Selecteur "Couches" dans un panneau lateral droit, persiste dans `PreferencesService` :

| Style | Source | Cas d'usage |
| --- | --- | --- |
| **Plan (defaut)** | OSM raster | Vue route classique |
| **Plan sombre** | CartoDB Dark Matter (free) | Conduite de nuit, dashboards |
| **Plan clair** | CartoDB Positron (free) | Lecture rapide, contraste markers |
| **Satellite** | Esri World Imagery (free, API key non requise) | Verifier un acces, voir un parking |
| **Hybride** | Esri Imagery + OSM Streets overlay | Combinaison adresses + visuel |
| **Topographique** | OpenTopoMap (free) | Zones rurales, reliefs |
| **Trafic** (P2) | Mapbox Traffic ou TomTom (payant) | Estimer ETA en zone urbaine |

Implementation : MapLibre `setStyle()` ou switch de `source.tiles` selon le choix.

#### 2.4.3 Modes camera (P0 sauf indication)

Toggle dans une barre flottante haut-droite :

| Mode | Comportement | Priorite |
| --- | --- | --- |
| **Free** | Utilisateur deplace/zoome librement (defaut) | P0 |
| **Follow vehicle** | La carte pan auto pour garder le vehicule selectionne au centre. Bearing/pitch libres. Sortie automatique si l'utilisateur drag manuellement. | P0 |
| **Heading-up** | Sous-mode de Follow : la carte pivote pour que le heading du vehicule pointe toujours vers le haut. Activable independamment. | P0 |
| **Chase 3D** | Sous-mode de Follow : pitch fige a 60deg + bearing aligne sur heading + zoom proche (17). Effet "cockpit GPS auto". | P1 |
| **Overview / Fit all** | Bouton "Vue d'ensemble" : auto-fit sur tous les markers actifs (existe deja partiellement via `centerAll`). | P0 |
| **Cinema** (P2) | Cycle automatique sur chaque vehicule en mouvement, 8s par vehicule. Utile pour les murs d'affichage TV. | P2 |
| **Locked** (P2) | Carte centree sur un point (depot, siege), zoom/rotation libres, pas de pan. | P2 |

Le mode actif est visible dans une pastille top-center (ex : "Mode : Suivi 3D — Renault Trafic AB-123-CD").

#### 2.4.4 Markers vehicule enrichis (P0)

Reutilise et etend `createTrackyIcon` ([shared/utils/leaflet-markers.ts](apps/web/src/app/shared/utils/leaflet-markers.ts)) :

| Element | Comportement |
| --- | --- |
| **Forme** | Pictogramme par type (car/truck/van/moto/bus/bike/construction) sur fond circulaire colore vitesse |
| **Heading rotatif** | Tous les types pivotent selon `heading` (correctif du bug actuel ou seul `OTHER` tournait) |
| **Couleur vitesse** | 0 / 1-50 / 51-90 / 91+ km/h (existe deja, conserve) |
| **Pulse "actif"** | Animation pulse autour du marker du vehicule selectionne (inspire mahlem-now `mn-marker-pulse`) |
| **Indicateur ignition** | Petit point ACC ON (vert) / OFF (gris) en bas a droite du marker |
| **Indicateur GSM/GPS** | Liseret rouge clignotant si signal perdu depuis > 5min |
| **Plaque flottante** | Mini-label "AB-123-CD" sous le marker, masquable en preferences |
| **Cluster** | Au-dela de 50 markers visibles, agreger en cluster avec compteur et couleur dominante |

#### 2.4.5 Interactions marker (P0)

| Action | Comportement |
| --- | --- |
| **Click** | Centre la carte sur le vehicule (`flyTo`), ouvre une carte info compacte (popover) avec les infos cles |
| **Double-click** | Active le mode Follow sur ce vehicule |
| **Right-click** | Menu contextuel : "Suivre", "Voir fiche", "Couper moteur", "Tracer un geofence ici", "Copier coordonnees" |
| **Long-press mobile** | Equivalent right-click |
| **Hover** | Tooltip : plaque + vitesse + ignition + timestamp dernier signal |

Popover info marker contient :

- Plaque + type vehicule
- Vitesse instantanee + heading
- Statut ACC + dernier signal
- Bouton "Voir fiche detaillee" -> `/vehicles/:id`
- Bouton "Couper / Restaurer moteur" (avec garde-fou existant double-confirmation)
- Bouton "Suivre"
- Mini-graphique vitesse derniere heure (sparkline)

#### 2.4.6 Trails & historique visible (P0/P1)

| Feature | Priorite |
| --- | --- |
| **Trail temps-reel** : polyligne sur les N dernieres positions, gradient de couleur selon vitesse (vert lent -> rouge rapide), epaisseur fade vers passe | P0 |
| **Trail length configurable** : 10 / 20 / 50 / 100 / 200 points (existe deja partiellement, etendre) | P0 |
| **Stop markers** : pictogramme "P" auto-dessine la ou le vehicule est reste arrete > 5min, avec popup "duree d'arret" | P1 |
| **Mini-replay 1h** : bouton "Voir derniere heure" qui charge les 60 dernieres minutes en mini-replay sans quitter la carte live | P1 |
| **Trip courant** : si un trip est ouvert (cf. `TripsService`), ligne pleine vs trail dashed pour distinguer "mouvement actuel" et "historique brut" | P1 |

#### 2.4.7 Geofences sur carte (P0/P1)

| Feature | Priorite |
| --- | --- |
| Affichage cercles existants (porte de Leaflet) | P0 |
| Survol -> tooltip nom + rayon | P0 |
| Click -> ouvre fiche geofence en drawer | P0 |
| Outil de dessin click-to-place + slider rayon (porte de l'existant) | P0 |
| Outil de dessin polygone (geofences libres) | P1 — synchro avec [09-roadmap-v2.md](docs/09-roadmap-v2.md) §2.4 |
| Vehicules a l'interieur d'un geofence : compteur affiche dans la popup geofence | P1 |
| Heatmap des violations (P2) | P2 |

#### 2.4.8 Filtres et calques (P0/P1)

Panneau "Calques" lateral gauche, toggle visibilite par categorie :

- Vehicules en mouvement (vitesse > 5 km/h)
- Vehicules a l'arret (vitesse = 0 + ignition ON)
- Vehicules eteints (ignition OFF)
- Vehicules hors-ligne (pas de signal > 10min)
- Geofences
- Trails
- Stop markers (P1)
- POIs (depots, points clients) (P2)

Multi-selection vehicule par groupe / fleet (en lien avec `VehicleGroup` deja existant en DB).

#### 2.4.9 Outils utilitaires (P1/P2)

| Outil | Priorite | Description |
| --- | --- | --- |
| **Recherche d'adresse** | P1 | Barre de recherche en haut, geocoding Nominatim (OSM, free), `flyTo` sur resultat |
| **Mesure de distance** | P1 | Click-to-add points, affiche distance cumulee + total |
| **Mesure d'aire** | P2 | Polygone, calcule surface |
| **Copier coordonnees** | P0 | Click-droit sur la carte -> copier `lat, lng` au presse-papier |
| **Plein ecran** | P0 | Bouton fullscreen via Fullscreen API |
| **Capture d'ecran** | P2 | Export PNG via `map.getCanvas().toDataURL()` |
| **Partager URL** | P1 | Bouton "Partager cette vue" -> URL contenant `lat,lng,zoom,bearing,pitch,layers` |

#### 2.4.10 Controles & UI (P0)

- **Compass / Reset North** (porte de mahlem-now) : visible si `bearing !== 0 \|\| pitch !== 0`.
- **Zoom +/-** : controles MapLibre standard, position bottom-right.
- **Echelle** : `ScaleControl` MapLibre, position bottom-left.
- **Geolocate** : bouton "Ma position" pour localiser l'utilisateur (utile lors de la creation d'un geofence depuis le terrain).
- **Indicateur "Live"** : pastille existante "Suivi temps reel" + nombre de vehicules actifs (a conserver).
- **Indicateur mode camera** : pastille top-center indiquant le mode actif (Free, Follow, Heading-up, Chase, Overview).
- **Theme** : suit la preference Tracky (light / dark) automatiquement (style carte associe).

#### 2.4.11 Performance & accessibilite (P0/P1)

- **Sub-pixel positioning** active (porte de mahlem-now).
- **Will-change: transform** sur les markers DOM pour accelerer la composition.
- **Lazy load** : la page carte est deja en lazy route, conserver.
- **Viewport culling** : ne pas creer de marker DOM pour les vehicules hors viewport au-dela d'un seuil (utiliser une layer GeoJSON symbole quand > 200 markers).
- **Keyboard shortcuts** : `f` toggle fullscreen, `c` reset compass, `o` overview, `+`/`-` zoom, `m` cycle modes camera.
- **A11y** : `aria-label` sur tous les boutons custom, `role="button"` sur markers cliquables.

#### 2.4.12 Mobile-first (P0)

- **Bottom-sheet** pour la liste vehicules (replace le sidebar desktop).
- **Touch gestures** natifs MapLibre : pinch-zoom, pinch-rotate, two-finger pitch.
- **Boutons larges** : 44x44 px minimum (iOS HIG).
- **Mode portrait** : panneau "Calques" devient overlay plein ecran ouvrable via FAB.

#### 2.4.13 Replay (TripReplayComponent) (P0)

Refonte complete dans le meme esprit que la carte live :

- Memes fonds de carte multiples
- Polyligne snappee aux routes (preparation chantier 3.B map-matching)
- Marker anime avec heading rotatif
- Timeline scrubable + boutons play/pause/x2/x4 (existe deja, port a conserver)
- Mini panel "stats segment" (vitesse moy/max, distance, duree) qui s'actualise selon l'index de replay
- Markers de stops surimprimes le long du replay

### 2.5 Strategie de portage

1. **Sprint B1** : fondations (MapService, MapComponent live MVP : multi-fonds, follow, heading-up, overview, marker enrichi, trail couleur).
2. **Sprint B2** : interactions (popover + actions moteur, calques, recherche d'adresse, geofence display).
3. **Sprint B3** : derives (MiniMapComponent, TripReplayComponent, GeofenceDialogComponent, mobile bottom-sheet).
4. **Sprint B4** : polish (chase 3D, stop markers, mini-replay 1h, mesures, partage URL).

Conserver l'API publique des composants pour zero impact sur les pages parents existantes.

### 2.6 Taches & estimations

#### Sprint B1 — Fondations & MVP live (P0)

| # | Tache | Estimation |
| - | --- | --- |
| 2.A | Installation `maplibre-gl@5.24.0` + types, suppression `leaflet` apres migration | 30min |
| 2.B | Portage `MapService` (copie + adaptation typings Tracky, layers GeoJSON, helpers polylignes/cercles) | 3h |
| 2.C | Refactor `MapComponent` (init MapLibre, gestion markers, trails, geofences cercles, lifecycle) | 4h |
| 2.D | Refactor `createTrackyIcon` -> `HTMLElement` MapLibre, rotation **tous types** + indicateur ACC + plaque | 2h |
| 2.E | Selecteur multi-fonds (OSM, Dark, Light, Satellite, Hybride, Topo) + persist preferences | 2h |
| 2.F | Modes camera : Free / Follow / Heading-up / Overview, toggle UI + state machine | 3h |
| 2.G | Trail gradient vitesse (segments colores) + epaisseur fade | 2h |
| 2.H | Bouton compass + reset bearing/pitch (porte mahlem-now) | 1h |

**Sous-total B1 :** ~17h30.

#### Sprint B2 — Interactions metier (P0)

| # | Tache | Estimation |
| - | --- | --- |
| 2.I | Popover info marker (plaque, vitesse, ACC, dernier signal, sparkline, boutons fiche/CUT-RESTORE/Suivre) | 3h |
| 2.J | Menu contextuel right-click / long-press (Suivre, Fiche, Geofence ici, Copier coords) | 2h |
| 2.K | Panneau "Calques" lateral gauche : toggle visibilite par statut + groupes vehicules | 2h |
| 2.L | Barre de recherche adresse (Nominatim) + `flyTo` resultat | 1h30 |
| 2.M | Plein ecran + raccourcis clavier (f/c/o/+/-/m) | 1h |
| 2.N | Cluster markers (au-dela de 50 vehicules visibles) | 2h |

**Sous-total B2 :** ~11h30.

#### Sprint B3 — Composants derives (P0)

| # | Tache | Estimation |
| - | --- | --- |
| 2.O | Refactor `MiniMapComponent` (vehicle-detail, multi-fonds + heading rotatif) | 1h30 |
| 2.P | Refactor `TripReplayComponent` (multi-fonds, marker anime, panel stats segment, stop markers) | 3h |
| 2.Q | Refactor `GeofenceDialogComponent` (cercles via MapLibre layer + slider rayon + drag center) | 2h |
| 2.R | Mobile bottom-sheet liste vehicules + adaptations responsives | 2h |

**Sous-total B3 :** ~8h30.

#### Sprint B4 — Polish (P1/P2 — optionnel V1.4)

| # | Tache | Priorite | Estimation |
| - | --- | --- | --- |
| 2.S | Mode Chase 3D (pitch 60deg + bearing locke + zoom 17) | P1 | 1h30 |
| 2.T | Stop markers automatiques (analyse positions, dessin pictos "P") | P1 | 2h |
| 2.U | Mini-replay 1h depuis la carte live | P1 | 2h |
| 2.V | Outil mesure distance (clicks + total cumule) | P1 | 1h30 |
| 2.W | Partage URL (lat/lng/zoom/bearing/pitch/layers) | P1 | 1h |
| 2.X | Mode Cinema (cycle auto) + Mode Locked (depot) | P2 | 2h |
| 2.Y | Outil dessin polygone geofence (synchro [09-roadmap-v2.md](docs/09-roadmap-v2.md) §2.4) | P2 | 3h |

**Sous-total B4 :** ~13h (~7h en P1 seul, ~5h en P2 differable).

#### Total chantier 2

| Scope | Effort |
| --- | --- |
| **MVP P0 (B1+B2+B3)** | **~37h30** |
| MVP + Polish P1 (B1+B2+B3+B4 P1) | ~44h30 |
| Total complet (P0+P1+P2) | ~50h30 |

> **Recommandation :** livrer le **MVP P0** (~37h30, ~5 jours dev) en priorite. Le polish P1 peut etre reporte d'une iteration sans bloquer la sortie.

### 2.7 Criteres d'acceptation

#### MVP P0

- [ ] La carte charge MapLibre (verifie via DevTools `window.maplibregl`).
- [ ] Au moins 6 fonds de carte selectionnables (Plan, Dark, Light, Satellite, Hybride, Topo).
- [ ] Pinch-rotate / pinch-pitch fonctionnels sur mobile.
- [ ] Bouton compass apparait des que `bearing !== 0 \|\| pitch !== 0`, reset via `easeTo`.
- [ ] Tous les types de vehicules (CAR, TRUCK, VAN, MOTORCYCLE, BICYCLE, BUS, CONSTRUCTION, OTHER) tournent selon leur heading.
- [ ] Indicateur ACC visible sur chaque marker. Plaque flottante affichable/masquable en preferences.
- [ ] Mode Follow : double-click marker -> camera suit ce vehicule. Drag manuel -> sortie automatique.
- [ ] Mode Heading-up : la carte pivote pour aligner le heading du vehicule suivi vers le haut.
- [ ] Mode Overview : bouton "Vue d'ensemble" auto-fit tous les vehicules visibles.
- [ ] Click marker -> popover compact avec actions (fiche, CUT/RESTORE, Suivre).
- [ ] Right-click / long-press -> menu contextuel.
- [ ] Panneau Calques : toggles statut (mouvement/arret/eteint/hors-ligne) + multi-selection groupes.
- [ ] Barre de recherche adresse fonctionnelle (Nominatim).
- [ ] Trail temps-reel avec gradient couleur vitesse + fade epaisseur.
- [ ] Cluster markers actif > 50 vehicules visibles.
- [ ] `MiniMapComponent`, `TripReplayComponent`, `GeofenceDialogComponent` migres et fonctionnels.
- [ ] Mobile : bottom-sheet liste vehicules, gestures fluides, boutons 44x44 min.
- [ ] Pas de regression visible dark/light mode.
- [ ] Lighthouse Perf >= 80 sur la page carte (post-migration).

#### Polish P1 (livrable suivant)

- [ ] Mode Chase 3D fonctionnel (pitch 60deg, follow vehicule).
- [ ] Stop markers dessines automatiquement aux arrets > 5min.
- [ ] Mini-replay 1h accessible depuis la carte live.
- [ ] Outils mesure distance / partage URL fonctionnels.

---

## 3. Chantier 3 — Lissage des traces live

### 3.1 Probleme observe

Le tracé en direct (polyline derriere le marker) presente :

- Des **lignes droites** entre deux positions GPS (au lieu de suivre la route).
- Des **coupures** dans les virages serres (le boitier echantillonne tous les 30s, donc les courbes sont "coupees").

### 3.2 Contraintes hardware

Per [03-protocol-coban-gps403d.md](docs/03-protocol-coban-gps403d.md) §1.3 et §5.3 :

- Le boitier Coban GPS403D est configure avec `fix030s***n` -> 1 trame toutes les **30 secondes** en mouvement.
- Le minimum supporte par le firmware est `fix005s***n` (5s) mais consomme 6x plus de data et batterie.
- **Conclusion :** on ne peut pas resoudre le probleme cote hardware sans tradeoff cout/autonomie.

### 3.3 Etat des lieux

| Couche | Implementation | Fichier |
| --- | --- | --- |
| Trace live | `points.push(latLng)` brut, capacite max 20 points | [map.component.ts:212-238](apps/web/src/app/features/map/map.component.ts#L212) |
| Trace replay | `parsed.map(p => L.latLng(p.lat, p.lng))` brut, polyline droite | [trip-replay.component.ts:169](apps/web/src/app/features/reports/trip-replay.component.ts#L169) |
| Stockage trip polyline | 100 points max par trip (`if (state.polyPoints.length < 100)`) | [trips.service.ts:157-159](apps/api/src/trips/trips.service.ts#L157) |
| Lissage | Aucun (pas de Catmull-Rom, pas de Bezier, pas de map-matching) | n/a |

### 3.4 Solution proposee

#### A. Lissage cosmetique (Catmull-Rom spline)

Remplacer la polyline brute par une courbe spline qui passe par tous les points GPS mais arrondit les angles. Plugin : [leaflet-curve](https://github.com/elfalem/Leaflet.curve) ou implementation custom de l'algorithme Catmull-Rom (~30 lignes de TS).

**Avantage :** instantane, pas de requete reseau, ameliore le rendu visuel sans changer la donnee. Recommande pour le **mode live**.

**Limite :** ne suit pas la route. Si le GPS rate un virage, la spline traversera quand meme un champ.

#### B. Map-matching (snap-to-road)

Pour le **mode replay** (offline, pas de contrainte temps reel), utiliser un service de map-matching :

- **OSRM** (`/match` endpoint) — open-source, self-hostable. Cf. [osrm-backend](https://github.com/Project-OSRM/osrm-backend).
- **Mapbox Map Matching API** — payant, ~0.50$/1000 requetes.
- **Valhalla** (`/trace_route`) — open-source, alternative a OSRM.

Workflow :

1. A la cloture du trip (`finalizeTrip` dans [trips.service.ts:243](apps/api/src/trips/trips.service.ts#L243)), envoyer les `polyPoints` au service de map-matching.
2. Stocker la polyligne snappee dans une nouvelle colonne `polylineMatched: String?` sur `Trip`.
3. Le replay charge en priorite `polylineMatched`, fallback sur `polyline` brut.

**Avantage :** trace 100% fidele aux routes en replay.

**Limite :** dependance externe, latence de calcul (~500ms-2s par trip), cout reseau.

#### C. Interpolation client temps-reel (entre deux WS events)

Pendant les 30 secondes entre deux trames, animer le marker en interpolation lineaire :

```ts
// Dans MapComponent.updateMarkers
animateMarker(trackerId, fromLatLng, toLatLng, headingDelta, durationMs = 30_000) {
  const startTs = performance.now();
  const tick = () => {
    const t = Math.min(1, (performance.now() - startTs) / durationMs);
    const lat = fromLatLng.lat + (toLatLng.lat - fromLatLng.lat) * t;
    const lng = fromLatLng.lng + (toLatLng.lng - fromLatLng.lng) * t;
    marker.setLatLng([lat, lng]);
    if (t < 1 && !cancelled) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
```

Couple a la **rotation animee** du heading, ca donne l'illusion d'un mouvement continu meme avec une trame toutes les 30s.

**Avantage :** UX immediate, zero dependance externe. Recommande pour le **mode live**.

**Limite :** le mouvement reel pendant ces 30s peut ne pas etre rectiligne (donc le marker affiche une approximation). Acceptable visuellement.

### 3.5 Recommandation

| Mode | Solution retenue | Effort |
| --- | --- | --- |
| **Live** (`MapComponent`) | C (interpolation) + A (Catmull-Rom sur la polyline) | ~3h |
| **Replay** (`TripReplayComponent`) | B (OSRM map-matching cote API, fallback A si offline) | ~5h |

### 3.6 Taches & estimations

| # | Tache | Estimation |
| - | --- | --- |
| 3.A | Implementation Catmull-Rom spline (utilitaire `apps/web/src/app/shared/utils/spline.ts`) | 1h30 |
| 3.B | Animation translation marker dans `MapComponent` (interpolation 30s) | 2h |
| 3.C | Augmenter `polyPoints` cap a 500 (au lieu de 100) ou stockage stream | 30min |
| 3.D | Setup OSRM (Docker self-host, cf. [osrm-backend](https://github.com/Project-OSRM/osrm-backend)) | 2h |
| 3.E | Service `MapMatchingService` cote API + colonne `polylineMatched` | 2h |
| 3.F | Tests unitaires spline + map-matching | 1h |

**Total :** ~9h (avec OSRM). Si OSRM differe : ~3h pour live seul.

### 3.7 Criteres d'acceptation

- [ ] La polyline live ne presente plus d'angles droits entre deux points.
- [ ] Le marker bouge de facon continue (pas de teleport).
- [ ] En replay, la polyline suit le reseau routier (pas de traversee de batiments / champs).
- [ ] Performance : pas de chute du framerate sur 50 vehicules en mouvement.

---

## 4. Chantier 4 — Correctifs rapports & replays

### 4.1 Problemes observes

1. **Distances negatives** dans les rapports (ex : `-XX km`).
2. **Tracts aberrants** dans les replays : formes triangulaires, lignes droites traversant la carte, retours en arriere brutaux.

### 4.2 Cause racine — distances negatives

L'algorithme `distanceMeters` ([haversine.ts:1-11](apps/api/src/common/utils/haversine.ts#L1)) est mathematiquement correct et **ne peut pas retourner de valeur negative** (`atan2` + `sqrt` -> resultat positif).

L'accumulation `state.dist += d` ([trips.service.ts:150](apps/api/src/trips/trips.service.ts#L150)) ne peut donc pas devenir negative non plus.

**Hypotheses a investiguer (par probabilite) :**

| # | Hypothese | Investigation |
| - | --- | --- |
| H1 | Lignes legacy en DB ecrites par l'ancien `MockPositionEmitterService` ou par une migration manuelle avec une valeur negative. | `SELECT COUNT(*) FROM trips WHERE distance_meters < 0;` |
| H2 | Aggregation cote frontend qui calcule un delta odometre `endOdo - startOdo` quand l'odometre a roule (overflow uint32 du protocole Coban). | grep `odometer\|odo\b` dans `apps/web` |
| H3 | Bug d'arithmetique IEEE-754 sur petites distances (jamais reproductible : haversine est `R * 2 * atan2(...)`). | Tests unitaires dedies |
| H4 | Champ `Trip.distanceKm` calcule via `Math.round(dist / 10) / 100` ([trips.service.ts:261](apps/api/src/trips/trips.service.ts#L261)) — formule correcte mais perd 2 decimales sous 10m. Pas de probleme de signe. | RAS |

**Plan d'action :**

1. **Audit DB** : requete SQL pour identifier les trips concernes.
2. **Garde-fou ingestion** : forcer `distanceMeters = Math.max(0, dist)` a tous les points d'ecriture (`finalizeTrip`, `recompute`).
3. **Garde-fou DB** : ajouter une CHECK constraint Postgres `CHECK (distance_meters >= 0)` via migration raw SQL.
4. **Garde-fou affichage** : dans [reports.component.ts:110](apps/web/src/app/features/reports/reports.component.ts#L110), formater `Math.max(0, trip.distanceMeters) / 1000`.
5. **Recompute** : pour les trips deja en DB avec valeur negative, lancer le `POST /admin/trips/recompute` existant.

### 4.3 Cause racine — tracts aberrants

Le code accepte sans filtrage des positions GPS douteuses :

| Etage | Filtre actuel | Manque |
| --- | --- | --- |
| Ingestion | Rejette `valid: false` ([positions.service.ts:43-46](apps/api/src/positions/positions.service.ts#L43)) | Pas de rejet `(0, 0)`. Pas de detection de saut > 200 km/h equivalent. |
| Trip processing | Aucun filtre, push direct dans `polyPoints` ([trips.service.ts:157](apps/api/src/trips/trips.service.ts#L157)) | Idem |
| Segmenter | Aucun filtre, sort par timestamp seulement ([trip-segmenter.service.ts:39](apps/api/src/trips/trip-segmenter.service.ts#L39)) | Idem |
| Replay frontend | `parsed.map(p => L.latLng(p.lat, p.lng))` sans validation ([trip-replay.component.ts:169](apps/web/src/app/features/reports/trip-replay.component.ts#L169)) | Idem |

**Symptomes expliques :**

- **Triangles** = un point GPS aberrant (ex : `(0, 0)` lors d'un fix degrade) cree un sommet a Null Island, puis le point suivant revient sur la zone reelle.
- **Lignes droites traversantes** = teleportation due a un fix LBS (cell-id) tres imprecis melange a des fixes GPS.
- **Cap de 100 points** ([trips.service.ts:157](apps/api/src/trips/trips.service.ts#L157)) tronque les longs trajets, ce qui peut donner des coupures rectilignes anormales.

### 4.4 Solution proposee

#### A. Filtre de sanite GPS partage

Creer un utilitaire pur dans `packages/shared/src/utils/gps-sanity.ts` :

```ts
export function isValidLatLng(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
    !(Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001); // exclut Null Island
}

export function isPlausibleJump(
  prev: { lat: number; lng: number; timestamp: Date },
  next: { lat: number; lng: number; timestamp: Date },
  maxKmh = 250,
): boolean {
  const dt = (next.timestamp.getTime() - prev.timestamp.getTime()) / 1000;
  if (dt <= 0) return false;
  const dKm = distanceMeters(prev.lat, prev.lng, next.lat, next.lng) / 1000;
  return (dKm / dt) * 3600 < maxKmh;
}
```

#### B. Application defensive a 4 etages

| Etage | Action |
| --- | --- |
| `PositionsService.ingest` | Apres `if (!frame.valid)`, ajouter `if (!isValidLatLng(...)) return;` |
| `TripsService.processPosition` | Avant push polyPoint, verifier `isPlausibleJump(state.lastLat/Lng, data, ...)` ; si false, marquer la trame comme suspecte (log) et **ne pas** l'ajouter a la polyline. |
| `TripSegmenterService.segmentPositions` | Pre-filtre avant le `sort` : retirer les positions `!isValidLatLng`. |
| `TripReplayComponent.initReplay` | `parsed.filter(isValidLatLng).filter(p => isPlausibleJump(prev, p))` avant le `map(L.latLng)`. |

#### C. Augmenter le cap de polyPoints

Passer de 100 a 500 ([trips.service.ts:157](apps/api/src/trips/trips.service.ts#L157)) ou supprimer le cap et appliquer un Douglas-Peucker (simplification preservant la forme) au moment de `finalizeTrip`. Recommandation : DP avec tolerance 5m.

#### D. (Optionnel) Marqueur visuel des points suspects

Dans le replay, dessiner les points filtres en **rouge clignotant** mais sans les inclure dans la polyline. Permet de debug visuel et de confiance utilisateur.

### 4.5 Taches & estimations

| # | Tache | Estimation |
| - | --- | --- |
| 4.A | Audit SQL trips a distance negative + recompute | 30min |
| 4.B | Utilitaire `gps-sanity.ts` dans `@vizyo/shared` + tests | 1h |
| 4.C | Application 4 etages (`positions.service`, `trips.service`, `segmenter`, `replay`) | 2h |
| 4.D | Migration : CHECK constraint `distance_meters >= 0` | 30min |
| 4.E | Augmentation cap polyPoints + Douglas-Peucker | 1h |
| 4.F | Tests E2E (trip avec position `(0,0)` injectee, trip avec saut 500km) | 1h |

**Total :** ~6h.

### 4.6 Criteres d'acceptation

- [ ] Aucun trip en DB avec `distanceMeters < 0` apres recompute.
- [ ] Une trame `(0, 0)` injectee dans le mock emitter ne produit ni triangle dans le replay ni distance gonflee.
- [ ] Une trame avec saut equivalent > 250 km/h est rejetee de la polyline.
- [ ] Long trajet (> 100 polyPoints) : la polyline conserve sa forme apres simplification (pas de coupures rectilignes).
- [ ] La constraint Postgres rejette les ecritures negatives futures (test : tentative d'INSERT avec -1).

---

## 5. Sequencement propose

| Sprint | Duree | Chantiers | Livrable |
| --- | --- | --- | --- |
| Sprint A | 1 jour | Chantier 1 (hydratation) + Chantier 4 (correctifs) | Carte instantanee + donnees fiables |
| Sprint B1 | 2.5 jours | Chantier 2 — Fondations & MVP live (taches 2.A->2.H) | MapLibre + fonds multiples + modes camera + markers enrichis + trail gradient |
| Sprint B2 | 1.5 jour | Chantier 2 — Interactions metier (taches 2.I->2.N) | Popover actions, calques, recherche adresse, clustering, raccourcis |
| Sprint B3 | 1 jour | Chantier 2 — Composants derives (taches 2.O->2.R) | MiniMap + TripReplay + GeofenceDialog + mobile bottom-sheet |
| Sprint C | 1 jour | Chantier 3 (lissage live + replay map-matching) | Tracts realistes |
| Sprint B4 | 1 jour (optionnel) | Chantier 2 — Polish P1 (Chase 3D, stop markers, mini-replay 1h, mesures, partage URL) | Differable a V1.5 |

**Total MVP :** 7 jours (~58h30 dev pur, hors review/QA). +1 jour si polish P1 inclus.

**Logique du sequencement :**

1. **Sprint A en premier** (chantiers 1+4) : debloque immediatement l'utilisateur final (carte instantanee + chiffres fiables). Effet visible des le lendemain de deploiement.
2. **Sprints B1->B3 ensuite** : la migration MapLibre est la fondation des chantiers suivants. Tout porter sur la nouvelle stack avant d'ajouter des features evite un double effort. Cluster, popover, modes camera necessitent MapLibre.
3. **Sprint C apres B3** : le chantier 3 (animation translation + Catmull-Rom + map-matching) est plus simple sur l'API MapLibre (`marker.setLngLat` accepte des transforms WebGL fluides) que sur Leaflet. Faire avant la migration creerait du code jetable.
4. **Sprint B4 differable** : les polish P1 (Chase 3D, stop markers, etc.) ameliorent l'UX mais ne sont pas requis pour la mise en service. Peuvent etre planifies sur V1.5 si la pression delai l'impose.

---

## 6. Risques et points d'attention

| Risque | Mitigation |
| --- | --- |
| Migration Prisma `Tracker.last*` sur DB en prod | Tester sur staging, migration en deux temps (ajout colonnes nullable -> backfill via job -> deploiement code) |
| Migration Leaflet -> MapLibre : regression visuelle | Reference d'implementation `MapService` mahlem-now + tests visuels par composant (MapComponent, MiniMap, TripReplay, GeofenceDialog) avant merge ; feature flag `useMaplibre` pour rollback rapide si bug bloquant |
| Migration MapLibre : geofences cercles | Porter via source GeoJSON `Polygon` approximant le cercle (64 segments) ou via layer `circle` MapLibre avec `circle-radius-pixels` (cf. doc MapLibre Style Spec) ; tester l'editabilite drag-radius |
| OSRM hosting (Chantier 3.B) | Demarrer avec map-matching Mapbox payant (10$/mois) si self-host trop chronophage ; OSRM en V2 |
| Recompute trips legacy (Chantier 4.A) | Dry-run en local avant production. Backup Postgres avant. |
| Filtres trop agressifs (Chantier 4.B) | Logger toutes les positions filtrees pendant 1 semaine en pre-prod, valider qu'on ne perd pas de donnees legitimes |
| Bundle size MapLibre (~800KB gzipped vs ~140KB Leaflet) | Acceptable : la page carte est deja chargee paresseusement (lazy route) ; verifier le score Lighthouse apres migration |

---

## 7. Out of scope (V2)

Les points suivants sont identifies mais **hors scope** de cette roadmap correctifs urgents :

- Mode 3D / pitch carte -> roadmap V2.
- Reduction de l'intervalle Coban a `fix010s***n` -> necessite renegociation forfait data + test autonomie batterie.
- Replay multi-vehicules synchronise -> backlog produit.
- Cache Redis pour positions live -> §3.3 [09-roadmap-v2.md](docs/09-roadmap-v2.md).
- Migration TimescaleDB -> §3.3 [09-roadmap-v2.md](docs/09-roadmap-v2.md).

---

## 8. Journal des modifications

| Date | Auteur | Changement |
| --- | --- | --- |
| 2026-04-26 | Younesshs | Creation de la roadmap correctifs urgents apres retours utilisateur final post-deploiement V1. |
| 2026-04-26 | Younesshs | Chantier 2 precise apres audit mahlem-now (`D:/www/mahlem-now/`) : stack confirmee MapLibre GL JS 5.24.0, plan de migration detaille avec reference `MapService`, effort revise 12h -> 14h. |
| 2026-04-26 | Younesshs | Chantier 2 elargi : mahlem-now devient reference **technique** uniquement, perimetre fonctionnel adapte au metier flotte (multi-fonds, modes camera follow/heading-up/chase/overview, popover actions metier, calques, recherche adresse, clustering, mobile bottom-sheet, etc.). Decoupage en 4 sprints B1->B4. Effort MVP P0 14h -> 37h30, total avec polish ~50h. Total roadmap MVP ~58h30. |
| 2026-04-26 | Younesshs | **Implementation V1.4 livree** sur la branche `feat/roadmap-v1.4-correctifs`. 7 commits, 31 fichiers modifies, +3760/-340 lignes. Detail couverture ↓ |

---

## 9. Couverture finale livree (V1.4)

### ✅ Livre — testes en preview

| Sprint | Contenu | Statut |
| --- | --- | --- |
| **A — Chantier 1** | Hydratation positions au login (Tracker.last\* denormalises, snapshot endpoint, hydratation frontend) | ✅ |
| **A — Chantier 4** | Correctifs rapports (gps-sanity 4 etages, CHECK constraint, polypoints 100->500, Douglas-Peucker, clamp Math.max(0,...)) | ✅ |
| **B1 — Fondations** | MapLibre GL 5.24.0, MapService porte de mahlem-now, 6 fonds (Plan/Dark/Light/Satellite/Hybride/Topo), markers heading rotatif tous types, ACC indicateur, plaque flottante, pulse vehicule actif, compass reset conditionnel, trail gradient | ✅ |
| **B2 — Interactions** | 4 modes camera (Free/Follow/Heading-up/Chase 3D pitch 60deg), popover marker (Suivre/Fiche/CUT/RESTORE moteur avec confirm + audit), right-click menu (copier coords/centrer/reset Nord), recherche adresse Nominatim, calques panel (filtres statut + geofences/trails/plates), raccourcis F/C/O/M, fullscreen API | ✅ |
| **B3 — Composants derives** | MiniMap MapLibre (vehicle-detail), TripReplay MapLibre, GeofenceDialog MapLibre (cercle GeoJSON, marker draggable, slider rayon temps-reel) | ✅ |
| **C — Lissage live** | Catmull-Rom spline trails (6 samples/segment), interpolation marker 28s entre 2 events WS, heading lerp circulaire (gestion wrap 360->0) | ✅ |
| **D.1 — Polish P1** | Fix MiniMap vehicleType (passe le bon type depuis vehicle-detail) | ✅ |
| **D.2 — Polish P1** | Mini-replay 1h depuis carte live (bouton popover, polyligne bleue distincte, banner HUD) | ✅ |
| **D.4 — Polish P1** | Outil mesure distance (click-to-add, polyligne violet dashed, banner pts/km, reset) | ✅ |
| **D.5 — Polish P1** | Partage URL view-state (lat/lng/zoom/bearing/pitch/style en query, restoreFromUrl au load) | ✅ |
| **E.1 — Bonus P2** | Mode Cinema (cycle automatique flyTo 8s sur les vehicules) | ✅ |

### ⏸ Reporte a V1.5 (documente, justifications)

| Item | Pourquoi reporte |
| --- | --- |
| **Clustering markers > 50** | Notre flotte mock a 2 vehicules. La feature est utile a partir de ~50+ markers visibles. Necessite supercluster + switch GeoJSON layer / DOM dynamique au zoom. ~3h dev. |
| **Mobile bottom-sheet** | Les overlays HUD actuels sont utilisables sur mobile (testes en mobile portrait). Refonte sheet => meilleure UX mais ~2h dev. |
| **D.3 Stop markers automatiques** | Necessite analyse historique 24h ; mieux place dans TripReplay (qui a deja la timeline) ou dans vehicle-detail tab "Historique". |
| **OSRM map-matching** | Snap polylines aux routes en replay. Necessite hosting OSRM ou cle Mapbox payante. ~5h dev + infra. Cf. roadmap V2 §3.3. |
| **Geofences polygones** | Backend a deja `type: 'POLYGON'` mais pas la table dedier. Evolution shared roadmap V2 §2.4. |
| **E.2 Mode Locked** | Peu d'usage reel (depot fixe). Backlog. |
| **Mode Heatmap** | P2, low-priority. |

### Estimation effort livre

- **Total commit-ready** : 7 commits sur `feat/roadmap-v1.4-correctifs`.
- **Volume** : ~3760 lignes ajoutees, 340 lignes supprimees, 31 fichiers.
- **Effort dev** : ~40h sur ~50h roadmap initial. Le reste (~10h) est planifie V1.5.

### Tests & qualite

- Build : ✅ 3 packages (shared, API, web)
- Tests unitaires : ✅ 90/90 shared + 119/119 API
- Verification preview : ✅ login, hydratation, multi-fonds, modes camera, popover engine actions, right-click menu, Nominatim, MiniMap, TripReplay, GeofenceDialog, mesure, cinema, mini-replay 1h
- Erreurs console : ✅ aucune

### Migration DB requise

Avant deploiement, executer sur prod :
```bash
cd apps/api && npx prisma migrate deploy
```

Migrations :
- `20260426120000_tracker_last_position_denorm` (ajout colonnes Tracker.last\* + backfill)
- `20260426130000_trip_distance_non_negative` (CHECK constraint distance >= 0 + nettoyage)
