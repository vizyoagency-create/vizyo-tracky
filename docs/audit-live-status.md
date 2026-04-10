# Audit Live vs Static — Vizyo Tracky Frontend

> Date : 2026-04-10 | Auteur : Claude Opus 4.6 | Version : 1.0

---

## 1. Inventaire events WS backend

| Event name | Emis depuis | Payload type | Scope |
|---|---|---|---|
| `position:update` | `realtime.gateway.ts:59` broadcastPosition() | PositionUpdateEvent | fleet room |
| `tracker:status` | `realtime.gateway.ts:63` emitTrackerStatus() | TrackerStatusChangedDto | fleet room |
| `alert:new` | `realtime.gateway.ts:81` broadcastAlert() | AlertEvent | fleet room |
| `alert:acknowledged` | `realtime.gateway.ts:88` broadcastAlertAcknowledged() | AlertAcknowledgedEvent | fleet room |

**Events internes (NestJS EventEmitter, pas WS) :**
- `tracker.assigned` — `trackers.service.ts:159` — consomme par MockPositionEmitterService
- `tracker.unassigned` — `trackers.service.ts:176` — consomme par MockPositionEmitterService

**Note :** `emitTrackerStatus()` existe dans le gateway mais **n'est appele par aucun service** actuellement. Event mort cote backend.

---

## 2. Inventaire events WS frontend

| Event name | Ecoute dans realtime.service.ts | Expose comme | Consomme par |
|---|---|---|---|
| `position:update` | Oui (ligne 42) | `positions` signal Map | dashboard, map, vehicle-detail |
| `alert:new` | Oui (ligne 48) | `alerts` signal + toast auto | alerts-bell, alerts page (indirect via effect) |
| `alert:acknowledged` | Oui (ligne 58) | filtre `alerts` signal | alerts-bell, alerts page (indirect via effect) |
| `tracker:status` | **NON** | — | — |

---

## 3. Audit par composant

#### features/dashboard/dashboard.component.ts
- **Donnees affichees** : 4 metric cards (statiques hardcoded), positions live (trackerId, lat, lng, speedKmh, timestamp, ignition)
- **Source HTTP** : aucune
- **Ecoute WS** : ✅ OUI — `realtime.positionsList()` via computed `enrichedPositions()`, `realtime.connected()`
- **GAP** : les 4 metric cards (Vehicules: 24, En mouvement: 8, etc.) sont **hardcodees**, pas de donnees reelles
- **Action requise** : brancher les metric cards sur des vrais compteurs API (GET /vehicles/count, etc.)

#### features/map/map.component.ts
- **Donnees affichees** : markers Leaflet + trails pour chaque tracker en temps reel
- **Source HTTP** : aucune
- **Ecoute WS** : ✅ OUI — `realtime.positionsList()` via effect `positionsEffect()`
- **GAP** : aucun gap critique. La carte est 100% live.
- **Action requise** : aucune

#### features/vehicles/vehicles-list.component.ts
- **Donnees affichees** : liste vehicules (plate, brand, model, year, tracker IMEI, tracker status dot)
- **Source HTTP** : `VehiclesApiService.list()` au ngOnInit
- **Ecoute WS** : ❌ NON
- **GAP** : tracker status (dot vert/gris) ne se met pas a jour en live. Un vehicule qui passe ONLINE/OFFLINE reste fige jusqu'au refresh.
- **Event backend disponible** : `tracker:status` existe dans le gateway mais n'est jamais emis. Meme s'il l'etait, le frontend ne l'ecoute pas.
- **Action requise** : (1) emettre tracker:status depuis PositionsService/TcpServerService, (2) ecouter dans RealtimeService, (3) mettre a jour la liste live

#### features/vehicles/vehicle-detail.component.ts
- **Donnees affichees** : header vehicule, 4 stats cards (statut, vitesse, derniere position, IMEI), mini-map, historique positions, alertes vehicule, commandes engine control
- **Source HTTP** : VehiclesApiService.findOne(), PositionsApiService.list(), AlertsApiService.list(), EngineControlService.listCommands()
- **Ecoute WS** : ⚠️ PARTIEL — `realtime.positions()` pour livePosition via computed, mais historique/alertes/commandes sont HTTP only
- **GAP** : 
  - Nouvelles alertes pour ce vehicule n'apparaissent pas dans l'onglet Alertes sans refresh
  - Nouvelles commandes engine control n'apparaissent pas dans l'onglet Commandes apres un CUT/RESTORE depuis un autre onglet navigateur
  - Historique positions ne se met pas a jour en live (acceptable — trop volumineux pour du WS)
- **Action requise** : refresh auto des onglets alertes/commandes quand un event WS pertinent arrive

#### features/alerts/alerts.component.ts
- **Donnees affichees** : liste paginee d'alertes avec filtres severity/acknowledged
- **Source HTTP** : AlertsApiService.list() avec cursor pagination
- **Ecoute WS** : ⚠️ INDIRECT — effect ecoute `realtime.alerts().length`, recharge via HTTP quand le compteur change
- **GAP** : le rechargement HTTP est asynchrone, la liste peut flasher brievement. Pas de gap fonctionnel critique.
- **Action requise** : aucune urgente (pattern actuel fonctionne)

#### features/engine-control/engine-control-button.component.ts
- **Donnees affichees** : bouton CUT/RESTORE, pills historique des 5 dernieres commandes
- **Source HTTP** : EngineControlService.requestCommand(), EngineControlService.listCommands()
- **Ecoute WS** : ❌ NON
- **GAP** : l'historique des commandes ne se rafraichit qu'apres un submit local. Si un autre admin envoie une commande, pas visible.
- **Action requise** : faible priorite — le CUT est une action operateur, rarement concurrente

#### shared/ui/alerts-bell/alerts-bell.component.ts
- **Donnees affichees** : badge compteur, dropdown 10 dernieres alertes non acquittees
- **Source HTTP** : AlertsApiService.acknowledge(), acknowledgeAll()
- **Ecoute WS** : ✅ OUI — `realtime.alerts()`, `realtime.unacknowledgedCount()`, `realtime.hasCritical()`
- **GAP** : aucun. 100% live via les signals RealtimeService.
- **Action requise** : aucune

#### features/auth/login.component.ts
- **Donnees affichees** : formulaire email/password
- **Source HTTP** : fetch POST /api/auth/login
- **Ecoute WS** : N/A (initie la connexion WS apres login)
- **GAP** : aucun
- **Action requise** : aucune

#### features/settings/settings.component.ts
- **Donnees affichees** : email + role de l'utilisateur, bouton logout
- **Source HTTP** : aucune (lit depuis AuthService signal)
- **Ecoute WS** : N/A (appelle realtime.disconnect() au logout)
- **GAP** : aucun
- **Action requise** : aucune

#### features/vehicles/add-vehicle-dialog/add-vehicle-dialog.component.ts
- **Donnees affichees** : formulaire stepper 2 etapes
- **Source HTTP** : VehiclesApiService.create(), TrackersApiService.create(), TrackersApiService.assign()
- **Ecoute WS** : ❌ NON
- **GAP** : aucun (modal de creation, pas de donnees live a afficher)
- **Action requise** : aucune

#### features/placeholder/placeholder.component.ts
- **Donnees affichees** : texte placeholder "bientot disponible"
- **Source** : aucune
- **Ecoute WS** : N/A
- **Action requise** : aucune

---

## 4. Tableau recapitulatif

| Composant | Statut | Gap critique ? | Effort estime |
|---|---|---|---|
| dashboard | ⚠️ partial | oui (metric cards hardcodees) | 2h |
| map | ✅ live | non | — |
| vehicles-list | ❌ static | oui (tracker status fige) | 1h |
| vehicle-detail | ⚠️ partial | non (position live, reste HTTP) | 1h |
| alerts page | ⚠️ partial | non (sync indirect fonctionne) | — |
| engine-control-button | ❌ static | non (action operateur) | 30min |
| alerts-bell | ✅ live | non | — |
| login | N/A | — | — |
| settings | N/A | — | — |
| add-vehicle-dialog | N/A | — | — |
| placeholder | N/A | — | — |

---

## 5. Events backend manquants a creer

| Event | Emis depuis | Payload | Justification |
|---|---|---|---|
| `tracker:status` | PositionsService (quand status change ONLINE), TcpServerService (disconnect → OFFLINE), MockEmitter | `{ trackerId, imei, status, vehicleId }` | Permettre mise a jour live de la pastille statut dans vehicles-list et vehicle-detail |
| `vehicle:created` | VehiclesService.create() | `{ id, plate, fleetId }` | Sync multi-utilisateurs de la liste vehicules |
| `vehicle:deleted` | VehiclesService.remove() | `{ id }` | Sync multi-utilisateurs |
| `command:status` | EngineControlService.dispatchCommand() | `{ commandId, status, trackerId }` | Mise a jour live du statut commande dans vehicle-detail et engine-control-button |

---

## 6. Events frontend morts

| Event | Statut | Detail |
|---|---|---|
| `tracker:status` (WS_EVENTS.TRACKER_STATUS) | ⚠️ MORT | Defini dans WS_EVENTS, methode emitTrackerStatus() existe dans le gateway, mais **jamais appelee** par aucun service backend. Frontend ne l'ecoute pas non plus. |

---

## 7. Recommandation d'ordre d'execution

1. **Activer tracker:status** — emettre depuis PositionsService + TcpServerService, ecouter dans RealtimeService, mettre a jour vehicles-list → impact demo visible immediat
2. **Brancher les metric cards du dashboard** — remplacer les hardcoded 24/8/14/3 par des vrais compteurs API → credibilite demo
3. **Refresh auto alertes/commandes dans vehicle-detail** — ecouter les events WS pertinents et recharger les onglets → experience fluide
4. **Creer event vehicle:created/deleted** — sync multi-utilisateurs de la liste vehicules → utile quand >1 admin connecte
5. **Creer event command:status** — live update du statut commande → nice-to-have, faible priorite
