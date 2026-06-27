# Sprint 4 — Écoute audio à distance — PLAN (Phase 2)

> Suite de `ANALYSE.md`. Branche `feat/sprint-4-ecoute-audio`. **LOCAL.**
> **STOP prévu après le bloc § 4 (sécurité/enforcement + tests de permission)** : je montre les
> tests avant de construire le reste dessus.

## Hypothèses actées (à corriger si besoin)
- **Périmètre Phase 2** : on construit **ENVOI de commande + 8 garde-fous + attestation + mail + audit**, **device MOCKÉ**.
- **Modèle CONFIRMÉ (2026-06-27) = Scénario A (appel live)** : l'écoute = appel vers la **SIM du boîtier** ; le serveur **arme le monitor + audite** uniquement. **Aucun clip serveur, aucune réception, aucune rétention-clip → garde-fou #8 SANS OBJET.** L'`AudioMonitoringCommand` (audit légal) est conservé. L'`AudioClip` n'est pas créé.
- **Déclencheur en prod** : `FLEET_ADMIN` du client **uniquement**. `SUPER_ADMIN` = **dev/test only** (bloqué en prod). `FLEET_MANAGER` **exclu** du déclenchement.
- **Rétention** : audit commande = long (immuable, légal) ; clip = court `AUDIO_RETENTION_DAYS=7` (différé).

---

## 1. Modèle de données (Prisma)

### `AudioMonitoringCommand` — commande + **audit immuable** (garde-fou #7), miroir `EngineControlCommand`
```prisma
model AudioMonitoringCommand {
  id             String        @id @default(uuid()) @db.Uuid
  trackerId      String        @db.Uuid
  tracker        Tracker       @relation(fields: [trackerId], references: [id], onDelete: Cascade)
  vehicleId      String?       @db.Uuid          // snapshot du véhicule au déclenchement
  fleetId        String        @db.Uuid          // scope tenant
  status         AudioCommandStatus @default(PENDING) // PENDING|SENT|ACKNOWLEDGED|FAILED|REJECTED
  reason         String        @db.Text          // MOTIF — NOT NULL (garde-fou #4)
  requestedBy    String        @db.Uuid          // qui (garde-fou #7)
  requestedByRole String                          // rôle au déclenchement (traçabilité #3)
  requestedInEnv String                           // 'development'|'production' (traçabilité gate #3)
  source         String        @default("MANUAL")
  lastError      String?
  sentAt         DateTime?
  ackedAt        DateTime?
  clipId         String?       @db.Uuid          // DIFFÉRÉ (réception B) — null pour l'instant
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt
  @@index([fleetId, createdAt(sort: Desc)])
  @@index([vehicleId, createdAt(sort: Desc)])
  @@index([trackerId, status])
}
enum AudioCommandStatus { PENDING SENT ACKNOWLEDGED FAILED REJECTED }
```
> **Immuabilité** = pratique applicative (INSERT + transitions de statut only ; jamais de DELETE par l'usage ; purge = cron dédié, hors usage). Pas d'endpoint de suppression exposé.

### `FleetAudioConfig` — activation par flotte (garde-fous #1 OFF défaut + #5 attestation)
```prisma
model FleetAudioConfig {
  id                  String   @id @default(uuid()) @db.Uuid
  fleetId             String   @unique @db.Uuid
  fleet               Fleet    @relation(fields: [fleetId], references: [id], onDelete: Cascade)
  enabled             Boolean  @default(false)   // #1 OFF par défaut
  attestedByUserId    String?  @db.Uuid          // #5 qui a attesté
  attestedAt          DateTime?
  attestationVersion  String?                    // version du texte d'attestation accepté
  activationEmailSentAt DateTime?                // #6 trace du mail flotte
  retentionDays       Int      @default(7)       // #8 (clip, différé)
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
}
```

### `AudioClip` — **SANS OBJET** (Scénario A retenu : appel live, aucun clip serveur). Non créé.

---

## 2. Config / flags (env)
`apps/api/src/config/env.validation.ts` :
```ts
AUDIO_MONITORING_ENABLED: z.string().default('false'),         // #2 flag prod inactivable
AUDIO_RETENTION_DAYS: z.coerce.number().int().positive().default(7), // #8 (clip, différé)
```
Lecture : `config.get('AUDIO_MONITORING_ENABLED',{infer:true})==='true'` (pattern `WIRE_LOG_ENABLED`/`MockPositionEmitter`).

---

## 3. Protocole device (commande) — MOCKÉ en Phase 2
- `coban.types.ts` : `| { type: 'voice_monitor'; ... }` ajouté à `CobanCommand`.
- `coban.encoder.ts` : case `voice_monitor` → **format réel INCONNU** (cf `ANALYSE.md §2`). En attendant la source Baanool : **placeholder explicite** (throw « format à confirmer » ou `custom`), et le **test mocke `socket-registry.send`** → on valide qu'une trame est dispatchée, **jamais** vers un device réel.
- Réutilise `socket-registry.send` + fallback SMS + `ack-waiter` (priorité dédiée, ≠ moteur=10) + `emitUpdate` (WS).

---

## 4. 🔒 BLOC SÉCURITÉ / ENFORCEMENT — **STOP ICI pour ta revue**

### 4.1 Endpoints + chaîne de guards
**Déclenchement** : `POST /audio-monitoring/trackers/:trackerId/listen`  body `{ reason: string }`
```
@UseGuards(JwtAuthGuard)                              // classe
@Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)   // SA seulement pour passer le gate dev
@UseGuards(RolesGuard, AudioMonitoringGuard)          // ordre : rôle puis gate env
@RequireVehiclePermission('audio_monitoring', { paramName: 'trackerId' })
@UseGuards(PermissionsGuard)
```
**Activation flotte** : `PATCH /fleets/:fleetId/audio-config` body `{ enabled, attestation: true, attestationVersion }`
```
@Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN) + @UseGuards(RolesGuard, AudioMonitoringGuard)
```

### 4.2 `AudioMonitoringGuard` (le pivot dev/prod — garde-fous #2 + #3)
```
canActivate(ctx):
  env  = config NODE_ENV ; flag = AUDIO_MONITORING_ENABLED==='true'
  if env === 'production':
     if !flag                       -> ForbiddenException  // #2 : flag absent => écoute impossible
     if user.role === SUPER_ADMIN    -> ForbiddenException  // #3 : prestataire ne déclenche pas en prod
  // dev/test : super-admin autorisé (véhicule de test)
  return true
```

### 4.3 Service `requestListen()` — enforcements
1. **Motif** (#4) : `reason` trimé non vide → sinon `BadRequestException` (en plus du DTO `@IsNotEmpty`).
2. **Scope tenant** (fail-closed) : tracker filtré par `fleetId` du user si non-SUPER_ADMIN (`resolveTenantScope`/`tracker.vehicle.fleetId`).
3. **Activation flotte** (#1) : `FleetAudioConfig.enabled === true` pour la flotte → sinon `ForbiddenException('fonction non activée')`.
4. **Perm** (#1) : `audio_monitoring` sur le véhicule (PermissionsGuard, défauts = false partout sauf admin).
5. Crée `AudioMonitoringCommand` (status PENDING, `reason`, `requestedBy`, `requestedByRole`, `requestedInEnv`) **avant** dispatch = **audit** (#7).
6. Dispatch **mocké** (device de test).

### 4.4 Activation `setFleetAudioConfig()` — enforcements
- `enabled:true` **exige** `attestation===true` → sinon `BadRequestException('attestation requise')` (#5).
- Pose `attestedBy/attestedAt/attestationVersion`.
- **Mail flotte** (#6) : `EmailService.send` à `user.findMany({fleetId, isActive:true})`, template « obligations » (informer conducteurs, signalétique, finalité limitée). `activationEmailSentAt` posé.

### 4.5 🧪 TESTS DE PERMISSION (le livrable du STOP) — `audio-monitoring.security.spec.ts` (modèle `night-watchman.security.spec.ts`)
| Test | Attendu |
|---|---|
| `@Roles(listen)` = `[FLEET_ADMIN, SUPER_ADMIN]`, **PAS** FLEET_MANAGER/VIEWER/NIGHT_WATCHMAN | reflète les guards réels |
| `@UseGuards` listen contient `RolesGuard`, `AudioMonitoringGuard`, `PermissionsGuard` | guard câblé (anti no-op) |
| **prod + SUPER_ADMIN** → `AudioMonitoringGuard` jette **403** (#3) | bloqué |
| **prod + flag OFF** → 403 (#2) — écoute techniquement impossible | bloqué |
| **dev + SUPER_ADMIN** → autorisé (véhicule test) | passe |
| **prod + FLEET_ADMIN + flag ON** → passe le guard | passe |
| **motif vide** → `BadRequestException` (#4) | rejeté |
| **flotte non activée** → 403 (#1) | rejeté |
| **activation sans attestation** → `BadRequestException` (#5) | rejeté |
| **scope tenant** : user d'une autre flotte → tracker introuvable (fail-closed) | rejeté |
| **défauts perms** : `audio_monitoring=false` pour VIEWER/FM/NW (catalogue) | vérifié |
| **anti-escalade** : FM (sans audio_monitoring) ne peut pas l'accorder (`clampPermissions`) | vérifié |

> **STOP** : je te montre ces tests **écrits et verts** (device mocké) **avant** de construire l'UI, le mail réel, l'audit-historique et la rétention.

---

## 5. Reste du plan (Phase 3, après validation du bloc § 4)
- **Audit-historique admin** : endpoint `GET /admin/.../audio-monitoring` (réutilise le pattern `/admin/activity/engine-commands`) — qui/quand/véhicule/motif.
- **Rétention** : `AudioRetentionService` (cron, miroir `LogCleanupService`) — purge clip (différé) ; l'audit commande est conservé (légal).
- **Front (mobile-first)** : bouton « Écouter » + **modale motif obligatoire** ; écran activation flotte (attestation) ; (lecture du vocal = différée au modèle B).
- **Réception/stockage du vocal** : **DIFFÉRÉ** — bloc séparé quand la source Baanool est fournie (`AudioClip` + canal de retour + sécurité de l'ingestion).

---

## 6. Fichiers touchés (Phase 2)
- `packages/shared/src/permissions/permissions.ts` (+ `audio_monitoring`, défauts, label).
- `apps/api/prisma/schema.prisma` (+ `AudioMonitoringCommand`, `FleetAudioConfig`, enum) + migration.
- `apps/api/src/config/env.validation.ts` (+ 2 env).
- `apps/api/src/audio-monitoring/` : `module`, `controller`, `service`, `audio-monitoring.guard.ts`, `dto/request-listen.dto.ts`, `dto/set-fleet-audio-config.dto.ts`.
- `packages/shared/src/protocol/coban.{types,encoder}.ts` (type `voice_monitor`, placeholder format).
- `apps/api/src/email/email.service.ts` (+ template activation flotte).
- `apps/api/src/audio-monitoring/audio-monitoring.security.spec.ts` (le bloc § 4.5).

## 7. Commits atomiques prévus
`feat(audio): perm audio_monitoring + flag env + modeles (config+commande)` ·
`feat(audio): guard dev/prod + service requestListen (motif/scope/activation)` ·
`feat(audio): activation flotte (attestation) + mail obligations` ·
`test(audio): security spec (super-admin prod bloque, motif, flag, scope, attestation)` ·
`docs(sprint-4): PLAN`.

**Aucune écoute réelle. Device mocké. Réception différée. Je m'arrête au § 4 pour ta validation des tests de permission.**
