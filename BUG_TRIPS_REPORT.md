# Investigation BUG-TRIPS

Date : 2026-04-15T00:00:00Z

---

## 1. Audit du TripSegmenterService

### 1.1 Logique actuelle

Il existe **deux niveaux** de segmentation dans le code :

1. **`TripSegmenterService`** (`apps/api/src/trips/trip-segmenter.service.ts`) — service **stateless** utilisé uniquement pour le **recompute** batch de trips historiques.
2. **`TripsService.processPosition()`** (`apps/api/src/trips/trips.service.ts:106-145`) — machine à états **stateful** (in-memory) utilisée pour le traitement **temps réel** de chaque position entrante.

C'est le second (`TripsService`) qui est impliqué dans le bug rapporté.

#### Création d'un nouveau trip (temps réel — `TripsService.processPosition()`)

```pseudocode
SI pas de trip ouvert pour ce tracker:
    SI ignition === false → supprimer le candidat, RETURN (pas de trip)
    SI speedKmh > TRIP_SPEED_THRESHOLD_KMH (5 km/h):
        SI pas de candidat → créer un MovingCandidate avec firstMovingAt = timestamp
        SINON SI (timestamp - candidate.firstMovingAt) >= TRIP_MOVING_CONFIRM_MS (30s):
            → startTrip() : crée le trip en base + émet TripStartedEvent
            → supprimer le candidat
    SINON:
        → supprimer le candidat (speed trop faible, reset du timer)
```

**Points critiques :**
- Il faut **au minimum 2 positions consécutives** avec speed > 5 km/h, espacées d'au moins **30 secondes** pour démarrer un trip.
- Si une seule position descend en dessous du seuil entre les deux, le candidat est supprimé et le compteur reprend à zéro.

#### Clôture d'un trip (temps réel)

```pseudocode
SI trip ouvert ET ignition === false:
    → finalizeTrip(source='ignition')

SI trip ouvert ET speedKmh === 0:
    SI première fois à 0 → zeroSpeedSince = timestamp
    SINON SI (timestamp - zeroSpeedSince) >= TRIP_STOP_TIMEOUT_MS (5 min):
        → finalizeTrip(source='speed')

SI trip ouvert ET speedKmh > 0 ET speedKmh <= seuil:
    → zeroSpeedSince = null (reset, mais le trip reste ouvert)
```

**Attention :** la clôture par speed nécessite `speedKmh === 0` (strict), pas juste `<= TRIP_SPEED_THRESHOLD_KMH`. Un véhicule roulant à 2 km/h ne déclenchera **jamais** la clôture par speed.

#### Clôture par timeout (cron)

```pseudocode
@Cron('*/60 * * * * *')  // toutes les 60 secondes
POUR chaque trip ouvert:
    SI (now - lastTimestamp) > TRIP_STOP_TIMEOUT_MS (5 min):
        → finalizeTrip(source='timeout')
```

#### Finalisation (`finalizeTrip()`)

```pseudocode
SI distance_totale < TRIP_MIN_DISTANCE_METERS (50m):
    → DELETE le trip de la base, ne pas émettre d'événement
SINON:
    → UPDATE le trip avec endedAt, distance, maxSpeed, avgSpeed, polyline
    → émettre TripCompletedEvent via WebSocket
```

#### Mise à jour d'un trip en cours

Chaque position reçue pendant un trip ouvert met à jour l'état in-memory :
- `dist += haversine(lastPos, newPos)` (ligne 112)
- `maxSpeed = max(maxSpeed, speedKmh)` (ligne 112)
- `speedSum += speedKmh` (ligne 113)
- `positionCount++` (ligne 113)
- `polyPoints.push()` si < 100 points (ligne 115)

**Aucun UPDATE en base** n'est fait à chaque position — l'état est entièrement en mémoire jusqu'à la finalisation.

### Constantes

Définies dans `apps/api/src/trips/trip-segmenter.constants.ts` :

| Constante | Valeur | Usage |
|-----------|--------|-------|
| `TRIP_SPEED_THRESHOLD_KMH` | `5` | Speed minimale pour considérer le véhicule en mouvement |
| `TRIP_STOP_TIMEOUT_MS` | `300 000` (5 min) | Durée à speed 0 pour clôturer un trip |
| `TRIP_MOVING_CONFIRM_MS` | `30 000` (30 s) | Durée minimale de mouvement pour confirmer un trip |
| `TRIP_MIN_DISTANCE_METERS` | `50` | Distance minimale pour persister un trip |
| `TRIP_TIMEOUT_CHECK_MS` | `60 000` (60 s) | Intervalle du cron de timeout (non utilisé directement, cron codé en dur) |

### 1.2 Dépendances

**Comment le service reçoit les positions :**
- Appel **direct synchrone** (non event-based) depuis `PositionsService.ingest()` (ligne 96-106 de `positions.service.ts`)
- L'appel est **asynchrone** avec `.catch()` : `this.trips.processPosition({...}).catch(err => ...)`
- **Pas de queue**, pas d'EventEmitter, pas de pub/sub — appel direct fire-and-forget

**Accès base de données :**
- Via `PrismaService` injecté dans `TripsService`
- Pas de transactions explicites
- Opérations : `trip.create()`, `trip.update()`, `trip.delete()`, `trip.findMany()`

**Événements émis :**
- `trip:started` via `RealtimeGateway.emitTripStarted(fleetId, event)` — WebSocket (Socket.IO)
- `trip:completed` via `RealtimeGateway.emitTripCompleted(fleetId, event)` — WebSocket (Socket.IO)
- Aucun EventEmitter NestJS n'est utilisé pour les trips

### 1.3 Tests existants

Fichier : `apps/api/src/trips/trip-segmenter.service.spec.ts` (97 lignes)

**⚠️ IMPORTANT : les tests couvrent UNIQUEMENT le `TripSegmenterService` (batch/recompute), PAS le `TripsService.processPosition()` (temps réel).**

| Test | Description | Pertinent pour le bug ? |
|------|-------------|------------------------|
| `should create 1 trip for continuous movement` | Mouvement continu → 1 trip | Non (batch seulement) |
| `should split into 2 trips when stopped for 5+ min` | Arrêt prolongé → split | Non (batch) |
| `should end trip on ignition OFF` | Ignition OFF → fin trip | Non (batch) |
| `should filter out trip with distance < 50m` | Distance < 50m → pas de trip | Non (batch) |
| `should return empty array for empty positions` | 0 positions → [] | Non |
| `should return empty for all stationary positions` | Positions immobiles → [] | Non |
| `should not start trip for speed > 5 but < 30s` | Mouvement < 30s → pas de trip | Non (batch) |
| `should calculate distance and speeds correctly` | Vérification calculs | Non |

**Aucun test ne couvre le chemin temps réel (`TripsService.processPosition()`).** Il n'existe pas de fichier `trips.service.spec.ts`.

**Aucun test ne simule le cas rapporté :** véhicule en mouvement mais aucun trip créé.

---

## 2. Vérification du chemin position → trip

### Étape 1 : Réception trame TCP

**Fichier :** `apps/api/src/tracker-tcp/tcp-server.service.ts`
- **Ligne 67-74** : Buffer TCP, split par `[;\r\n]`, extraction de la trame brute
- **Ligne 79** : `const frame = decodeFrame(raw)` — décodage Coban
- **Ligne 81-85** : Logging wire frame via `CobanWireLogger.in()` (conditionnel à `WIRE_LOG_ENABLED=true`)
- **Ligne 87** : `this.dispatchFrame(frame, socket, boundImei, ...)` — dispatch selon le type

**Rejets silencieux possibles :**
- Aucune position avant login (ligne 180-183 : `if (!currentImei)` → log warn, break)
- IMEI mismatch (ligne 184-186 : `if (frame.imei !== currentImei)` → log warn, break)

**Logs :** `debug` pour chaque frame reçue (ligne 76), `warn` pour les rejets

### Étape 2 : Décodage Coban

**Fichier :** `packages/shared/src/protocol/coban.parser.ts`
- **Ligne 62-155** : `decodeRegularPosition()` — format CSV standard
- **Ligne 175-243** : `decodeAlternativePosition()` — format alternatif

**Résultat :** `CobanPositionFrame` avec champs `valid`, `ignition`, `speedKph`, `latitude`, `longitude`, `deviceTime`

**Rejets silencieux (retourne `unknown` frame) :**
- Moins de 7 champs CSV (ligne 65)
- IMEI invalide (ligne 70)
- Flag valid ni 'A' ni 'V' (ligne 78) → frame rejetée comme `unknown`
- Hémisphère invalide (lignes 86-87)
- Coordonnées non parsables (lignes 95, 98)

**Extraction ignition :**
- **Ligne 148-149** : `const ignRaw = parts[14] ?? ''; if (ignRaw === '0' || ignRaw === '1') result.ignition = ignRaw === '1';`
- Si le champ est absent ou contient autre chose que '0'/'1' → `ignition` reste `undefined`

**Extraction valid :**
- **Ligne 76** : `const validFlag = parts[6]`
- **Ligne 131** : `valid: validFlag === 'A'`
- 'A' = valide, 'V' = invalide

**Logs :** Aucun log dans le parser (module partagé pur)

### Étape 3 : Appel à `PositionsService.ingest()`

**Fichier :** `apps/api/src/positions/positions.service.ts`
- **Ligne 192 (tcp-server)** : `await this.positions.ingest(frame)`
- **Argument :** `CobanPositionFrame` complet

### Étape 4 : Persistance Position en base

**Fichier :** `apps/api/src/positions/positions.service.ts`

**Rejets silencieux :**
1. **Ligne 38-41** : `if (!tracker)` → IMEI inconnue en base, log `warn`, RETURN
2. **Ligne 43-46** : `if (!frame.valid)` → GPS invalide (flag 'V'), log `debug`, **RETURN — PAS DE PERSISTANCE, PAS DE TRIP**

**Persistance (ligne 48-59) :** `prisma.position.create()` — seulement si frame.valid === true

**Logs :** `warn` pour IMEI inconnue, `debug` pour GPS invalide

### Étape 5 : Appel à `TripsService.processPosition()`

**Fichier :** `apps/api/src/positions/positions.service.ts`

**Condition critique — ligne 76 :** `if (tracker.vehicle) { ... }`

**⚠️ Si le tracker n'a PAS de véhicule associé (`tracker.vehicle` est `null`), AUCUN trip processing n'a lieu. AUCUN log n'est émis. Rejet 100% silencieux.**

**Appel (lignes 96-106) :**
```typescript
this.trips.processPosition({
    trackerId: tracker.id,
    vehicleId: tracker.vehicle.id,
    fleetId: tracker.vehicle.fleetId,
    lat: frame.latitude,
    lng: frame.longitude,
    speedKmh: frame.speedKph,
    timestamp: frame.deviceTime,
    ignition: frame.ignition ?? true,   // ← défaut à TRUE si absent
    vehiclePlate: tracker.vehicle.plate,
}).catch((err) => this.logger.error('Trip processing failed', err));
```

**Point clé :** `frame.ignition ?? true` — si l'ignition n'est pas dans la trame Coban, elle est considérée comme `true`. Ce n'est **PAS** bloquant pour la création de trip.

**Logs :** `error` seulement si `.catch()` est déclenché

### Étape 6 : Logique de segmentation temps réel

**Fichier :** `apps/api/src/trips/trips.service.ts`
- **Ligne 117** : `if (!this.ready) return;` — bloquant si `onModuleInit()` n'a pas terminé
- **Lignes 121-145** : Logique de création/gestion de trip (voir section 1.1)

**Rejets silencieux dans processPosition() :**
1. **Ligne 117** : `ready === false` → RETURN silencieux
2. **Ligne 122-124** : `ignition === false` sans trip ouvert → RETURN (normal)
3. **Ligne 143-144** : `speedKmh <= 5` sans trip ouvert → supprime candidat (normal)

### Étape 7 : Persistance Trip

**Fichier :** `apps/api/src/trips/trips.service.ts`
- **`startTrip()` (ligne 129-146)** : `prisma.trip.create()` — crée un trip avec `endedAt: null`
- **`finalizeTrip()` (ligne 147-161)** : `prisma.trip.update()` — ajoute `endedAt`, distance, etc.
- **Si distance < 50m (ligne 147)** : `prisma.trip.delete()` — supprime le trip silencieusement

---

## 3. Hypothèses de bug (top 5)

### Hypothèse 1 : Le parser Coban marque les positions comme `valid: false` (probabilité : ÉLEVÉE — 35%)

**Description :**
Si le GPS du tracker n'a pas de fix satellite correct, le flag dans la trame Coban est 'V' au lieu de 'A'. Le parser le traduit en `valid: false`. Dans ce cas, `PositionsService.ingest()` fait un `return` à la ligne 43-46 **avant toute persistance et avant tout appel au trip segmenter**.

**Code suspect :**
- `apps/api/src/positions/positions.service.ts:43-46`
```typescript
if (!frame.valid) {
    this.logger.debug(`Invalid GPS fix for ${frame.imei}, skipping persistence`);
    return;
}
```
- `packages/shared/src/protocol/coban.parser.ts:131` : `valid: validFlag === 'A'`

**Symptôme attendu :**
- 0 positions en base pour ce tracker aujourd'hui
- 0 trips créés
- Le tracker peut apparaître en ligne (le status est mis à jour via heartbeats, pas via positions)
- Logs `debug` "Invalid GPS fix" dans la console (mais `debug` est souvent désactivé en production)

**Comment confirmer :**
1. Exécuter la requête 4.1 — si `nb_positions = 0` mais le tracker est `ONLINE`, c'est très probablement ça
2. Vérifier les wire_logs (requête 4.4) pour inspecter les trames brutes et le flag valid
3. Vérifier les logs applicatifs pour "Invalid GPS fix"

### Hypothèse 2 : Le tracker n'est pas associé à un véhicule (`tracker.vehicle` est `null`) (probabilité : ÉLEVÉE — 30%)

**Description :**
Le trip processing est conditionné par `if (tracker.vehicle)` à la ligne 76 de `positions.service.ts`. Si le tracker n'a pas de véhicule associé dans la table `trackers`, **tout le bloc trip + geofence + broadcast est ignoré silencieusement**. Les positions SONT persistées en base, mais aucun trip n'est créé.

**Code suspect :**
- `apps/api/src/positions/positions.service.ts:76`
```typescript
if (tracker.vehicle) {
    // ... tout le trip processing est ici
}
// PAS de else, PAS de log
```

**Symptôme attendu :**
- Des positions EXISTENT en base pour ce tracker
- 0 trips créés
- Pas de broadcast de position en temps réel sur le dashboard
- Pas de violations de géofence
- **Aucun log d'erreur** — c'est un chemin silencieux

**Comment confirmer :**
```sql
SELECT t.id, t.imei, t.vehicle_id, v.plate
FROM trackers t
LEFT JOIN vehicles v ON v.id = t.vehicle_id
WHERE t.status = 'ONLINE';
```
Si `vehicle_id` est `NULL` pour le tracker concerné, c'est la cause.

### Hypothèse 3 : Le champ `ignition` n'est pas extrait du protocole Coban — frame avec < 15 champs (probabilité : MODÉRÉE — 15%)

**Description :**
Si la trame Coban a moins de 15 champs (parts[14] absent), le parser ne définit pas `result.ignition`. Dans `positions.service.ts:104`, `frame.ignition ?? true` le met à `true` par défaut. **Ceci n'est PAS bloquant pour la création de trip.**

Cependant, si le tracker envoie explicitement `ignition = '0'` (parts[14] = '0'), chaque position aura `ignition: false`. Dans `TripsService.processPosition()` ligne 122 :
```typescript
if (data.ignition === false) {
    this.movingCandidates.delete(data.trackerId);
    return;
}
```
**Un trip ne sera JAMAIS créé si toutes les positions ont `ignition: false`.**

**Code suspect :**
- `packages/shared/src/protocol/coban.parser.ts:148-149`
```typescript
const ignRaw = parts[14] ?? '';
if (ignRaw === '0' || ignRaw === '1') result.ignition = ignRaw === '1';
```
- `apps/api/src/trips/trips.service.ts:122-124` — bloque tout si ignition === false

**Symptôme attendu :**
- Positions en base avec speed > 0 mais aucun trip
- Le dashboard montre le véhicule en mouvement en temps réel (via broadcast)
- Mais section Reports vide

**Comment confirmer :**
1. Inspecter les trames brutes (wire_logs) : vérifier si parts[14] = '0' dans les trames position
2. Vérifier les logs du TripsService pour des messages `processPosition` avec ignition = false

### Hypothèse 4 : Les seuils sont trop restrictifs pour un usage urbain lent (probabilité : MODÉRÉE — 10%)

**Description :**
- `TRIP_SPEED_THRESHOLD_KMH = 5` : nécessite > 5 km/h. En soi raisonnable.
- `TRIP_MOVING_CONFIRM_MS = 30 000` : nécessite 30 secondes consécutives au-dessus du seuil.
- Si les positions arrivent toutes les 10 secondes, il faut **au minimum 3-4 positions consécutives** au-dessus de 5 km/h.
- **Bug subtil :** si la speed tombe à ≤ 5 km/h entre deux positions (feu rouge, ralentisseur), le candidat est **supprimé** (ligne 143-144) et le compteur des 30 secondes reprend à zéro.
- En conduite urbaine avec beaucoup d'arrêts, un trip pourrait ne jamais démarrer.

**Code suspect :**
- `apps/api/src/trips/trips.service.ts:143-144`
```typescript
} else {
    this.movingCandidates.delete(data.trackerId);
}
```

**Symptôme attendu :**
- Positions en base avec des speeds faibles (< 10 km/h) et intermittentes
- Aucun trip car jamais 30 secondes consécutives au-dessus de 5 km/h
- Le véhicule apparaît en mouvement sur la carte temps réel

**Comment confirmer :**
```sql
SELECT speed_kmh, timestamp
FROM positions
WHERE tracker_id = '<tracker_id>'
  AND timestamp >= CURRENT_DATE
ORDER BY timestamp ASC;
```
Chercher des séquences de 30 secondes sans interruption > 5 km/h.

### Hypothèse 5 : Crash/restart du service — perte de l'état in-memory (probabilité : FAIBLE — 10%)

**Description :**
L'état des trips ouverts et des `movingCandidates` est **entièrement en mémoire** (`Map<string, OpenTripState>`). Si le service redémarre :
- Les trips ouverts sont récupérés depuis la base (`onModuleInit()` ligne 68-103)
- **Mais les `movingCandidates` sont PERDUS** — ils ne sont pas persistés
- Le flag `ready` est `false` jusqu'à la fin de `onModuleInit()` (ligne 102)
- Pendant ce temps, toute position reçue est silencieusement ignorée (ligne 117 : `if (!this.ready) return`)

Si le service a redémarré aujourd'hui, il y a un trou pendant lequel aucun trip n'a été traité.

**Code suspect :**
- `apps/api/src/trips/trips.service.ts:117`
```typescript
if (!this.ready) return;
```
- `apps/api/src/trips/trips.service.ts:61` : `private readonly movingCandidates = new Map<>()`  — non persisté

**Symptôme attendu :**
- Des positions existent en base
- Pas de trips, ou trips manquants pendant une fenêtre spécifique
- Logs de démarrage : "Trip recovery: X open trips loaded"

**Comment confirmer :**
1. Vérifier les logs de démarrage du service aujourd'hui
2. Vérifier si un restart/deploy a eu lieu : `journalctl -u vizyo-api --since today | grep -i "start\|listen\|recovery"`

---

## 4. Vérifications base de données

### 4.1 Positions reçues aujourd'hui

```sql
SELECT
  p.tracker_id,
  t.imei,
  v.plate,
  COUNT(*) as nb_positions,
  MIN(p.timestamp) as first_pos,
  MAX(p.timestamp) as last_pos,
  COUNT(*) FILTER (WHERE p.valid = false) as invalid_count,
  AVG(p.speed_kmh) as avg_speed,
  MAX(p.speed_kmh) as max_speed
FROM positions p
JOIN trackers t ON t.id = p.tracker_id
LEFT JOIN vehicles v ON v.id = t.vehicle_id
WHERE p.timestamp >= CURRENT_DATE
GROUP BY p.tracker_id, t.imei, v.plate
ORDER BY nb_positions DESC;
```

**Statut :** Non exécutée — pas d'accès direct à la base PostgreSQL depuis cet environnement.

**Interprétation attendue :**
- Si `nb_positions = 0` pour le tracker concerné → hypothèse 1 (GPS invalide, positions non persistées)
- Si `nb_positions > 0` mais `plate IS NULL` → hypothèse 2 (tracker sans véhicule)
- Si `nb_positions > 0`, `plate` défini, mais `max_speed <= 5` → hypothèse 4 (seuils)
- Si `nb_positions > 0`, `max_speed > 5`, `plate` défini → hypothèse 3 (ignition) ou 5 (restart)

### 4.2 Trips créés aujourd'hui

```sql
SELECT id, vehicle_id, started_at, ended_at, distance_km, position_count, segmentation_source
FROM trips
WHERE started_at >= CURRENT_DATE
ORDER BY started_at DESC;
```

**Statut :** Non exécutée — pas d'accès direct à la base.

### 4.3 Trips ouverts (jamais clôturés)

```sql
SELECT id, vehicle_id, started_at, position_count, segmentation_source
FROM trips
WHERE ended_at IS NULL
ORDER BY started_at DESC
LIMIT 20;
```

**Statut :** Non exécutée — pas d'accès direct à la base.

**Interprétation :** Des trips ouverts très anciens indiqueraient des problèmes de finalisation (timeout cron non fonctionnel).

### 4.4 Logs Coban récents pour le tracker concerné

```sql
SELECT created_at, direction, frame_type, raw
FROM wire_logs
WHERE created_at >= CURRENT_DATE
  AND frame_type = 'position'
ORDER BY created_at DESC
LIMIT 50;
```

**Statut :** Non exécutée — pas d'accès direct à la base.

**Note :** les wire_logs ne sont persistés que si `WIRE_LOG_ENABLED=true` dans l'environnement (voir `apps/api/src/observability/coban-wire-logger.service.ts:24`). Si cette variable n'est pas définie, aucun wire_log n'est en base.

### 4.5 Erreurs récentes

```sql
SELECT created_at, source, message, imei
FROM error_logs
WHERE created_at >= CURRENT_DATE
  AND (source LIKE '%trip%' OR source LIKE '%position%' OR source LIKE '%segment%')
ORDER BY created_at DESC
LIMIT 50;
```

**Statut :** Non exécutée — pas d'accès direct à la base.

### 4.6 Vérification de l'association tracker-véhicule (requête complémentaire)

```sql
SELECT t.id, t.imei, t.status, t.last_seen_at, t.vehicle_id, v.plate
FROM trackers t
LEFT JOIN vehicles v ON v.id = t.vehicle_id
WHERE t.status IN ('ONLINE', 'IDLE')
ORDER BY t.last_seen_at DESC;
```

**Statut :** Non exécutée — à exécuter manuellement pour vérifier l'hypothèse 2.

---

## 5. Vérification des trames Coban

### Format attendu d'une trame position régulière

```
imei:XXXXXXXXXXXXXXX,alarm,YYMMDD,rfid,L,HHMMSS,A/V,DDMM.MMMM,N/S,DDDMM.MMMM,E/W,speed_knots,course,altitude,ignition,door,fuel1,fuel2,temp
```

**Champs critiques :**
- Index 6 : `A` (valide) ou `V` (invalide) — **DOIT être 'A'** sinon la position est ignorée
- Index 11 : vitesse en nœuds — convertie en km/h via `knotsToKph()`
- Index 14 : ignition — `'1'` = ON, `'0'` = OFF, absent = `undefined` → défaut `true` dans le service

### Vérification à effectuer

**Sans accès à la base :** procédure manuelle

1. **Récupérer les wire_logs :**
```sql
SELECT raw FROM wire_logs
WHERE frame_type = 'position' AND created_at >= CURRENT_DATE
ORDER BY created_at DESC LIMIT 10;
```

2. **Pour chaque trame, vérifier :**
   - Le nombre de champs (split par `,`) — doit être >= 7, idéalement >= 15
   - `parts[6]` = 'A' (pas 'V') → validité GPS
   - `parts[14]` = '1' → ignition ON (pas '0' ni absent)
   - `parts[11]` = vitesse en nœuds → vérifier que la conversion donne > 5 km/h

3. **Exemple d'une trame correcte :**
```
imei:123456789012345,tracker,260415,,L,120000,A,3334.2000,N,00735.4000,W,10.5,45,150,1,0,,,
```
- Valid: A ✓
- Speed: 10.5 knots ≈ 19.4 km/h ✓
- Ignition: 1 ✓

4. **Exemple d'une trame problématique :**
```
imei:123456789012345,tracker,260415,,L,120000,V,3334.2000,N,00735.4000,W,0.0,0,0,0,0,,,
```
- Valid: V ✗ → position ignorée
- Ignition: 0 → même si valid était 'A', ignition=false bloquerait le trip

### Vérification alternative sans wire_logs

Si `WIRE_LOG_ENABLED` n'est pas activé, les trames brutes ne sont pas en base. Options :
1. Activer temporairement : `WIRE_LOG_ENABLED=true` et redémarrer le service
2. Augmenter le log level à `debug` pour voir les trames dans la console
3. Utiliser `tcpdump` sur le port TCP du tracker : `tcpdump -i any port 5115 -A`

---

## 6. Recommandations

### 6.1 Quick fix (si cause identifiée)

La cause ne peut être confirmée avec certitude sans accès à la base. Cependant, voici les patches pour les causes les plus probables :

#### Si hypothèse 1 (GPS invalide) :
Pas de fix côté logiciel — problème matériel/environnemental du tracker. Vérifier l'antenne GPS, le positionnement du boîtier dans le véhicule, ou un firmware obsolète.

#### Si hypothèse 2 (tracker sans véhicule) :
Associer le tracker à un véhicule dans l'interface admin. **Patch défensif :** ajouter un log warning quand un tracker a des positions mais pas de véhicule.

```typescript
// positions.service.ts, après la ligne 75
if (!tracker.vehicle) {
    this.logger.warn(`Tracker ${tracker.imei} has positions but no vehicle assigned, skipping trip/broadcast`);
    return;
}
```

#### Si hypothèse 3 (ignition toujours false) :
Vérifier le câblage du fil ignition sur le tracker Coban dans le véhicule. Si le fil n'est pas branché sur le +ACC, le tracker peut reporter `ignition: '0'` en permanence.

**Patch alternatif :** ne pas bloquer la création de trip uniquement sur la base de l'ignition — utiliser la speed comme critère principal, l'ignition comme critère secondaire pour la clôture rapide.

```typescript
// trips.service.ts, ligne 122 — modifier la condition
if (!state) {
    // Ne bloquer QUE si ignition === false ET speed <= seuil
    if (data.ignition === false && data.speedKmh <= TRIP_SPEED_THRESHOLD_KMH) {
        this.movingCandidates.delete(data.trackerId);
        return;
    }
    // ... reste de la logique
```

### 6.2 Améliorations défensives

#### Logs additionnels

| Emplacement | Log | Niveau |
|-------------|-----|--------|
| `positions.service.ts:76` (else branch) | `Tracker ${imei} has no vehicle, skipping trip processing` | `warn` |
| `trips.service.ts:117` | `Trip processing skipped: service not ready` | `warn` |
| `trips.service.ts:122` | `Ignition OFF for tracker ${trackerId}, no trip started` | `debug` |
| `trips.service.ts:143` | `Speed below threshold for tracker ${trackerId}, candidate reset` | `debug` |
| `trips.service.ts:139-141` | `Trip started after ${elapsed}ms of movement for tracker ${trackerId}` | `info` |
| `trips.service.ts:147` | `Trip ${tripId} discarded: distance ${dist}m < ${MIN_DISTANCE}m` | `info` |

#### Métriques à exposer

Via un endpoint `/health/trips` ou des métriques Prometheus :

- `positions_ingested_total` — compteur de positions traitées
- `positions_invalid_total` — compteur de positions GPS invalides filtrées
- `positions_no_vehicle_total` — compteur de positions sans véhicule associé
- `trips_started_total` — compteur de trips démarrés
- `trips_completed_total` — compteur de trips finalisés
- `trips_discarded_total` — compteur de trips supprimés (distance < seuil)
- `trips_open_current` — gauge du nombre de trips ouverts en mémoire
- `moving_candidates_current` — gauge du nombre de candidats en attente

#### Health check spécifique

```typescript
@Get('health/trips')
async tripHealth() {
    return {
        ready: this.trips.isReady(),
        openTrips: this.trips.getOpenTripCount(),
        movingCandidates: this.trips.getMovingCandidateCount(),
        lastProcessedAt: this.trips.getLastProcessedAt(),
    };
}
```

### 6.3 Tests à ajouter

**Fichier à créer : `apps/api/src/trips/trips.service.spec.ts`**

| # | Scénario | Description |
|---|----------|-------------|
| 1 | Véhicule démarre, roule 5 min, s'arrête | → 1 trip créé avec `endedAt` défini |
| 2 | Véhicule roule à faible vitesse (< 5 km/h) | → Pas de trip créé |
| 3 | Véhicule roule entre 5-10 km/h pendant < 30s | → Pas de trip (TRIP_MOVING_CONFIRM_MS) |
| 4 | Véhicule roule entre 5-10 km/h pendant > 30s | → Trip créé |
| 5 | Positions reçues avec `ignition: false` uniquement | → Pas de trip créé |
| 6 | Trip ouvert + ignition OFF | → Trip finalisé avec `segmentationSource: 'ignition'` |
| 7 | Trip ouvert + 5 min à speed 0 | → Trip finalisé avec `segmentationSource: 'speed'` |
| 8 | Trip ouvert + distance < 50m | → Trip supprimé de la base |
| 9 | Service restart avec trips ouverts en base | → `openTrips` Map restaurée correctement |
| 10 | `ready = false` (init en cours) | → `processPosition()` ne fait rien, pas de crash |
| 11 | Speed intermittente (> 5, puis <= 5, puis > 5) | → MovingCandidate reset, trip retardé |
| 12 | Tracker sans véhicule associé | → Aucun trip, aucun crash |
| 13 | Timeout cron avec trip inactif > 5 min | → Trip finalisé avec `segmentationSource: 'timeout'` |

---

## 7. Questions ouvertes

1. **Quel est l'IMEI / l'identifiant du véhicule concerné ?** — Nécessaire pour cibler les requêtes SQL et les wire_logs.

2. **`WIRE_LOG_ENABLED` est-il activé en production ?** — Si non, aucun wire_log n'est disponible pour inspecter les trames brutes. Voir `apps/api/src/observability/coban-wire-logger.service.ts:24`.

3. **Le service API a-t-il redémarré aujourd'hui ?** — Vérifier `journalctl -u vizyo-api --since today`. Un restart implique une perte des `movingCandidates` et un trou potentiel dans le processing.

4. **Le fil ignition est-il câblé sur le tracker physique ?** — Si le fil +ACC n'est pas connecté, le tracker reporte `ignition: '0'` en permanence, ce qui bloque la création de trips (hypothèse 3).

5. **Quel est le niveau de log configuré en production ?** — Si le level est `info` ou supérieur, les logs `debug` d'invalid GPS fix et de positions filtrées ne sont pas visibles.

6. **Le tracker envoie-t-il des trames avec le format régulier ou alternatif ?** — L'extraction de l'ignition se fait à des index différents (14 vs 16) selon le format. Un mauvais format pourrait extraire l'ignition depuis le mauvais champ.

7. **Y a-t-il d'autres véhicules dont les trips fonctionnent correctement ?** — Si oui, comparer les trames et la configuration des trackers fonctionnels vs. défaillant.

8. **Le véhicule apparaît-il en mouvement sur la carte temps réel ?** — Si oui, les positions arrivent bien au broadcast WebSocket, ce qui élimine les hypothèses 1 et 2, et pointe vers l'hypothèse 3 (ignition) ou 4 (seuils).

---

## Classement final des hypothèses par probabilité décroissante

| Rang | Hypothèse | Probabilité | Diagnostic rapide |
|------|-----------|-------------|-------------------|
| 1 | GPS invalide (`valid: false`) — positions non persistées | 35% | Requête 4.1 : `nb_positions = 0` ? |
| 2 | Tracker sans véhicule associé (`tracker.vehicle = null`) | 30% | Requête 4.6 : `vehicle_id IS NULL` ? |
| 3 | Ignition toujours `false` — trip bloqué à la création | 15% | Wire_logs : `parts[14] = '0'` ? |
| 4 | Seuils trop restrictifs (speed ≤ 5 km/h ou < 30s consécutives) | 10% | Requête 4.1 : `max_speed <= 5` ? |
| 5 | Crash/restart — perte de l'état in-memory | 10% | Logs système : restart aujourd'hui ? |
