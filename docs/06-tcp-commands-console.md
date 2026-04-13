# Phase 6 — Console de commandes TCP (builder + templates + historique + scheduling)

**Objectif** : donner aux FLEET_ADMIN et SUPER_ADMIN un outil pour envoyer n'importe quelle commande Coban à un tracker connecté, avec parsing d'ACK, historique, templates et planification.

**Durée estimée** : 3–5 jours de dev découpés en 6 sous-phases séquentielles.

**Prérequis** : Phase 5 validée (ou au moins 5.4.A/B — login + position E2E sur vrai tracker).

---

## 6.0 Décisions d'architecture (à valider avant de coder)

### 6.0.1 Module séparé d'EngineControl

`EngineControlModule` reste tel quel — il a une logique métier critique (garde-fou vitesse, confirmation double). On crée un nouveau `TrackerCommandsModule` pour tout le reste. Les deux partagent `SocketRegistryService` et `encodeCommand` de `@vizyo/tracky-shared`.

**Raison** : ne pas contaminer un module stable déjà testé E2E avec une surface d'API beaucoup plus large.

### 6.0.2 Sécurité par défaut

- Toutes les commandes sont **whitelisted** dans un catalog côté shared. Aucune commande raw libre.
- Certaines commandes sont **SUPER_ADMIN only** (ex : `factory`, `reset`, modification de `adminip` et `apn`).
- La commande "raw" est un mode **avancé** activé par flag config, masqué par défaut en UI.

### 6.0.3 ACK parsing

Chaque template déclare un `expectedAckPattern: RegExp` et un `ackTimeoutMs`. Un `AckWaiterService` en mémoire attend la prochaine trame texte matchant le pattern pour l'IMEI ciblé, ou timeout → `FAILED`.

Les ACK Coban arrivent **dans le même flux TCP** que les positions (trame courte comme `reset ok`, `speed ok!`, etc.), il faut donc intercepter **avant** le parser de position dans `tcp-server.service.ts`.

---

## 6.1 Sous-phase 6.1 — Catalog de commandes (shared)

**Fichier** : `packages/shared/src/protocol/coban.catalog.ts`

Définir :

```ts
export type CobanCommandCategory =
  | 'config_initial'   // APN, adminip, gprs, password
  | 'reporting'        // fix, less gprs, monitor/tracker toggle
  | 'alarm'            // move, speed, sensor sensitivity
  | 'geofence'         // stockade, nostockade
  | 'power'            // sleep, factory, reset
  | 'info'             // status, position, version
  | 'engine'           // J, K (info seulement, usage via EngineControl)
  | 'custom';

export interface CobanCommandTemplate {
  id: string;                         // 'reset', 'speed_alarm', 'fix_30s_continuous'
  category: CobanCommandCategory;
  label: string;                      // FR
  description: string;                // FR
  requiresSuperAdmin: boolean;
  requiresConfirmation: boolean;      // UI double-clic
  dangerous: boolean;                 // affichage rouge + warning
  params: CommandParamSpec[];         // [] si pas de params
  buildPayload: (imei: string, params: Record<string, unknown>) => string;
  expectedAckPattern: RegExp;         // ex: /reset\s*ok/i
  ackTimeoutMs: number;               // ex: 15000
  availableVia: ('tcp' | 'sms')[];    // certaines commandes sont SMS-only
}

export interface CommandParamSpec {
  name: string;                       // 'speed_limit'
  label: string;                      // FR: 'Vitesse max (km/h)'
  type: 'number' | 'string' | 'select' | 'duration' | 'latlng';
  required: boolean;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
  validate?: (value: unknown) => string | null;  // null = OK
}
```

**Liste des templates V1** (à implémenter dans ce fichier) :

| id | category | dangerous | super_only | params | payload | ACK |
|---|---|---|---|---|---|---|
| `status` | info | ❌ | ❌ | — | `**,imei:X,R;` | `/status/i` |
| `position_single` | info | ❌ | ❌ | — | `**,imei:X,B;` | position frame |
| `reset` | power | ✅ | ❌ | — | `reset123456` (TCP → encapsuler) | `/reset\s*ok/i` |
| `factory` | power | ✅ | ✅ | — | `factory123456` | `/factory\s*ok/i` |
| `sleep_on` | power | ❌ | ❌ | — | `sleep123456 on` | `/sleep.*ok/i` |
| `sleep_off` | power | ❌ | ❌ | — | `sleep123456 off` | `/sleep.*ok/i` |
| `fix_continuous` | reporting | ❌ | ❌ | `interval` (30s/60s/2m/5m) | `fix<FREQ>***n123456` | `/fix.*ok/i` |
| `fix_stop` | reporting | ❌ | ❌ | — | `nofix123456` | `/nofix\s*ok/i` |
| `speed_alarm` | alarm | ❌ | ❌ | `speed_kmh` (20–200) | `speed123456 <SPEED>` | `/speed\s*ok/i` |
| `move_alarm` | alarm | ❌ | ❌ | `radius_m` | `move123456 <RADIUS>` | `/move\s*ok/i` |
| `stockade_set` | geofence | ❌ | ❌ | `lat1, lng1, lat2, lng2` | `stockade123456 <BOX>` | `/stockade\s*ok/i` |
| `stockade_clear` | geofence | ❌ | ❌ | — | `nostockade123456` | `/nostockade\s*ok/i` |
| `time_zone` | config_initial | ❌ | ❌ | `offset` (-12 to 12) | `time zone123456,<OFFSET>` | `/time zone\s*ok/i` |
| `less_gprs_on` | reporting | ❌ | ❌ | — | `less gprs123456 on` | `/less gprs.*ok/i` |
| `less_gprs_off` | reporting | ❌ | ❌ | — | `less gprs123456 off` | `/less gprs.*ok/i` |
| `apn` | config_initial | ✅ | ✅ | `apn, user, pass` | `apn123456 <APN>,<U>,<P>` | `/APN\s*ok/i` |
| `adminip` | config_initial | ✅ | ✅ | `ip, port` | `adminip123456 <IP> <PORT>` | `/adminip\s*ok/i` |
| `password_change` | config_initial | ✅ | ✅ | `new_pass` (6 digits) | `password123456 <NEW>` | `/password\s*ok/i` |
| `protocol_18` | config_initial | ❌ | ✅ | — | `protocol123456 18` | `/protocol18\s*ok/i` |
| `engine_stop` | engine | ✅ | ❌ | — | `**,imei:X,J;` | — (via EngineControl uniquement) |
| `engine_resume` | engine | ✅ | ❌ | — | `**,imei:X,K;` | — (via EngineControl uniquement) |
| `raw` | custom | ✅ | ✅ | `raw_payload` | `<RAW>` | user-provided |

**Tests** : `coban.catalog.spec.ts` — pour chaque template, assert `buildPayload` produit la bonne string et le `expectedAckPattern` matche un exemple d'ACK.

---

## 6.2 Sous-phase 6.2 — Prisma : modèle `TrackerCommand`

Ajouter dans `schema.prisma` :

```prisma
enum TrackerCommandStatus {
  PENDING      // créée, pas encore envoyée
  SCHEDULED    // planifiée pour plus tard (BullMQ)
  SENT         // écrite sur socket
  ACKNOWLEDGED // ACK parsé correctement
  FAILED       // erreur / timeout
  CANCELLED    // annulée par admin avant envoi
}

enum TrackerCommandChannel {
  TCP
  SMS
}

model TrackerCommand {
  id              String                @id @default(uuid()) @db.Uuid
  trackerId       String                @db.Uuid
  tracker         Tracker               @relation(fields: [trackerId], references: [id], onDelete: Cascade)
  templateId      String                // 'reset', 'speed_alarm', etc.
  category        String                // 'power', 'alarm', etc.
  params          Json                  @default("{}")
  payload         String                // ce qu'on a effectivement envoyé
  channel         TrackerCommandChannel @default(TCP)
  status          TrackerCommandStatus  @default(PENDING)
  scheduledAt     DateTime?
  sentAt          DateTime?
  ackedAt         DateTime?
  ackResponse     String?               // trame brute reçue
  lastError       String?
  requestedBy     String                @db.Uuid  // userId
  requestedByUser User                  @relation(fields: [requestedBy], references: [id], onDelete: Restrict)
  createdAt       DateTime              @default(now())
  updatedAt       DateTime              @updatedAt

  @@index([trackerId, createdAt(sort: Desc)])
  @@index([status])
  @@index([scheduledAt])
  @@map("tracker_commands")
}
```

Ajouter relation inverse sur `Tracker` et `User`, migration nommée `tracker_commands_init`.

---

## 6.3 Sous-phase 6.3 — `AckWaiterService` + hook TCP server

**Fichier** : `apps/api/src/tracker-commands/ack-waiter.service.ts`

- Map en mémoire : `Map<imei, PendingAck[]>` où `PendingAck = { commandId, pattern, resolve, reject, timeout }`
- Méthode `waitForAck(imei, pattern, timeoutMs): Promise<string>` — push dans la map, retourne une promise
- Méthode `tryMatch(imei, rawFrame): boolean` — appelée par `tcp-server.service.ts` pour chaque trame NON parsée comme `login`, `heartbeat`, `position`. Itère les waiters de l'IMEI, résout le premier qui match, clear timeout.

**Modif `tcp-server.service.ts`** : dans `dispatchFrame`, case `'unknown'`, au lieu de juste logguer, tenter `ackWaiter.tryMatch(currentImei, frame.raw)`. Si match → ne pas logger en warn.

---

## 6.4 Sous-phase 6.4 — `TrackerCommandsService` + Controller REST

**Fichier** : `apps/api/src/tracker-commands/tracker-commands.service.ts`

Méthodes :

- `request(trackerId, templateId, params, scheduledAt | null, requestedBy)` :
  1. Valider template existe, params valides, droits (`requiresSuperAdmin`)
  2. Résoudre tracker → IMEI, fleet check
  3. Si `engine_stop` / `engine_resume` → **rejeter** avec 400 et rediriger vers `/engine-control` (pour ne pas bypasser le garde-fou)
  4. Si `scheduledAt` dans le futur → créer en `SCHEDULED`, enqueue BullMQ `tracker-commands` avec delay, return
  5. Sinon → `dispatch(command)` immédiat
- `dispatch(command)` :
  1. `encodeCommand` via catalog
  2. `socketRegistry.get(imei)` → si offline : `FAILED` + `lastError = "Tracker offline"`
  3. `socket.write(payload)` + update `SENT, sentAt`
  4. `ackWaiter.waitForAck(imei, pattern, timeoutMs)` en arrière-plan :
     - Succès : `ACKNOWLEDGED, ackedAt, ackResponse`
     - Timeout : `FAILED, lastError = "ACK timeout"`
  5. Émettre event WS `command:updated` sur room `fleet:<fleetId>` à chaque changement
- `cancel(commandId, requestedBy)` : uniquement si status `SCHEDULED` ou `PENDING`, check droits
- `list(filters, requestedBy)` : pagination, filtres par trackerId, status, category, dateFrom, dateTo, templateId

**Controller** `tracker-commands.controller.ts` :

```
POST   /tracker-commands              (body: { trackerId, templateId, params, scheduledAt? })
GET    /tracker-commands              (query: filters)
GET    /tracker-commands/:id
DELETE /tracker-commands/:id          (= cancel)
GET    /tracker-commands/catalog      (public catalog filtré selon role)
```

**Tests** :
- `tracker-commands.service.spec.ts` : 15+ tests (happy path par catégorie, timeout, offline, rejet engine, scheduling, cancel, fleet isolation)
- `ack-waiter.service.spec.ts` : 8+ tests (match, timeout, multiple waiters même IMEI, cleanup)

---

## 6.5 Sous-phase 6.5 — BullMQ worker `tracker-commands`

**Fichier** : `apps/api/src/tracker-commands/tracker-commands.processor.ts`

- Queue name : `tracker-commands`
- Job name : `dispatch-scheduled`
- Job data : `{ commandId }`
- Handler : load command → si status === `SCHEDULED` → appeler `service.dispatch(command)`
- Retry policy : 3 attempts, backoff exponential 30s/2min/10min

Bootstrap dans `AppModule` avec `BullModule.registerQueue({ name: 'tracker-commands' })`.

---

## 6.6 Sous-phase 6.6 — Angular : `CommandsPanelComponent`

**Structure** :

```
apps/web/src/app/features/tracker-commands/
├── commands-panel.component.ts          # conteneur, utilisé dans fiche véhicule onglet "Commandes"
├── command-builder.component.ts         # sélection catégorie + template + form dynamique
├── command-history.component.ts         # liste paginée, filtres, statuts en pills, actions (retry, cancel)
├── command-form.component.ts            # forms dynamiques selon CommandParamSpec
├── command-status.pipe.ts               # mapping status → label FR + couleur
├── services/
│   └── tracker-commands.service.ts      # HTTP + WS
└── models/
    └── tracker-command.types.ts         # DTO miroirs du shared
```

**UX** :

1. Onglet "Commandes" dans la fiche véhicule (à côté de "Engine control")
2. Haut : dropdown catégorie → dropdown template → form auto-généré selon `params`
3. Ligne temps : "Envoyer maintenant" | "Planifier le [datetime picker]"
4. Dangerous templates → modal de confirmation (même pattern que EngineControl)
5. Historique en dessous : derniers 20, scroll infini, filtre par status/category
6. Statuts en live via WS : `command:updated` met à jour la ligne
7. Colonnes historique : date, user, template (label FR), params résumés, status pill, latence ACK, actions (voir détail, annuler si SCHEDULED)
8. Détail commande en side-drawer : payload envoyé, raw response, timeline status

**Mode raw** : accessible via un bouton "Mode avancé" visible uniquement si `user.role === 'SUPER_ADMIN'`. Textarea + warning rouge "Aucune validation, peut rendre le tracker inutilisable".

**Accessibilité** : boutons dangerous avec `aria-label` explicite, focus management sur le modal.

---

## 6.7 Livrables phase 6

- [ ] 22 templates codés + tests catalog
- [ ] Modèle `TrackerCommand` + migration
- [ ] Service + Controller + AckWaiter + 25+ tests API
- [ ] BullMQ worker scheduling
- [ ] WS event `command:updated`
- [ ] UI complète (panel + builder + history + detail drawer)
- [ ] Mise à jour `docs/04-roadmap.md`
- [ ] E2E sur vrai 403C : au minimum `status`, `position_single`, `reset`, `speed_alarm`, `stockade_set`
- [ ] Doc utilisateur `docs/user-guide-commands.md` (FR, screenshots, warnings)

---

## 6.8 Points d'attention pour Claude Code

- Réutiliser les patterns existants : `SocketRegistryService`, `ToastService`, `ConfirmModal`, `AuthInterceptor`.
- Ne pas dupliquer le design system : réutiliser les pills de `EngineControlButtonComponent` pour les status.
- TypeScript strict partout, pas de `any` sauf casts explicites documentés.
- Les regex d'ACK doivent être case-insensitive et tolérantes aux espaces — le firmware Coban est inconsistent.
- Ajouter un rate-limit `@Throttle` sur `POST /tracker-commands` : max 10 req/min par user (éviter flood).
- Logs structurés : chaque dispatch → log JSON avec `commandId, imei, templateId, status` pour grep.
