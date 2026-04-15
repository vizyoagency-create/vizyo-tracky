# Audit monorepo Vizyo Tracky

Date : 2026-04-15
Genere par : Claude Code

---

## 1. Structure globale

### 1.1 Arborescence

```
vizyo-tracky/
├── apps/
│   ├── api/                    # NestJS backend
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── seed.ts
│   │   │   └── migrations/     # 12 migrations
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── config/
│   │   │   ├── common/utils/
│   │   │   ├── health/
│   │   │   ├── prisma/
│   │   │   ├── auth/
│   │   │   ├── auth-client/
│   │   │   ├── alerts/
│   │   │   ├── engine-control/
│   │   │   ├── fleets/
│   │   │   ├── geofences/
│   │   │   ├── internal/
│   │   │   ├── observability/
│   │   │   ├── positions/
│   │   │   ├── realtime/
│   │   │   ├── socket-registry/
│   │   │   ├── tracker-commands/
│   │   │   ├── tracker-tcp/
│   │   │   ├── trackers/
│   │   │   ├── trips/
│   │   │   ├── users/
│   │   │   ├── vehicle-access/
│   │   │   ├── vehicle-groups/
│   │   │   ├── vehicle-schedules/
│   │   │   └── vehicles/
│   │   ├── nest-cli.json
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── web/                    # Angular 20 frontend
│       ├── src/
│       │   ├── main.ts
│       │   ├── index.html
│       │   ├── styles.css
│       │   └── app/
│       │       ├── app.ts
│       │       ├── app.config.ts
│       │       ├── app.routes.ts
│       │       ├── core/           # auth, guards, interceptors, services, theme
│       │       ├── features/       # dashboard, map, vehicles, alerts, etc.
│       │       ├── layouts/        # auth-layout, dashboard-layout
│       │       └── shared/         # components, ui, utils
│       ├── angular.json
│       ├── package.json
│       └── proxy.conf.json
├── packages/
│   └── shared/                 # DTO + protocol Coban + WS events
│       └── src/
│           ├── index.ts
│           ├── dto/            # vehicle, tracker, position, alert, geofence, trip
│           ├── events/         # ws-events.ts
│           └── protocol/       # coban.parser, coban.encoder, coban.catalog, coban.types, coban.utils
├── deploy/
│   └── vps/
│       ├── Dockerfile.api
│       ├── Dockerfile.web
│       ├── Dockerfile.lp
│       ├── docker-compose.prod.yml
│       ├── nginx.web.conf
│       ├── nginx.lp.conf
│       └── .env.prod.example
├── docker/
│   └── postgres/init-postgis.sql
├── docs/                       # 10+ docs techniques
├── lp/
│   └── vizyo-tracky.html       # Landing page standalone HTML
├── docker-compose.yml          # Dev : Postgres + Redis
├── turbo.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .env.example
└── .nvmrc
```

### 1.2 Outil de monorepo

- Gestionnaire : **pnpm workspaces** + **Turborepo**
- `pnpm-workspace.yaml` : workspaces = `apps/*`, `packages/*`
- `turbo.json` : tasks build, dev, lint, typecheck, test

### 1.3 Versions cles

| Dependance | Version |
|---|---|
| Node | >= 20.18.0 (`.nvmrc` : 20.18.0) |
| NestJS | ^11.0.1 |
| Angular | ^20.3.0 |
| Prisma | ^6.19.3 (`@prisma/adapter-pg`) |
| TypeScript | ^5.7.3 (API), ~5.9.2 (Web) |
| BullMQ | ^5.71.0 (`@nestjs/bullmq` ^11.0.4) |
| Socket.IO | ^4.8.0 (server + client) |
| PostGIS | postgis/postgis:16-3.4-alpine (Docker) |
| Redis | redis:7.4-alpine |
| Leaflet | ^1.9.4 |
| Tailwind CSS | ^4.2.2 |
| Zod | ^4.3.6 (env validation) |
| Jest | ^30.0.0 |
| nestjs-pino | ^4.6.1 |

---

## 2. Backend NestJS

### 2.1 Entree de l'app

- Chemin : `apps/api/src/main.ts`
- Bootstrap : `NestFactory.create(AppModule)`, CORS, global prefix `/api`, `ValidationPipe` (whitelist, transform, forbidNonWhitelisted)
- Logger : nestjs-pino

Modules racine importes dans `AppModule` (`apps/api/src/app.module.ts`) :

1. `ConfigModule.forRoot` (global, Zod validation)
2. `EventEmitterModule.forRoot`
3. `ScheduleModule.forRoot`
4. `ThrottlerModule.forRoot` (100 req/min)
5. `LoggerModule` (nestjs-pino, pino-pretty en dev, JSON en prod, redact auth/password/token/secret)
6. `PrismaModule`
7. `SocketRegistryModule`
8. `AuthClientModule`
9. `AuthModule`
10. `PositionsModule`
11. `AlertsModule`
12. `EngineControlModule`
13. `FleetsModule`
14. `GeofencesModule`
15. `TripsModule`
16. `VehiclesModule`
17. `TrackersModule`
18. `TrackerCommandsModule`
19. `TrackerTcpModule`
20. `ObservabilityModule`
21. `RealtimeModule`
22. `VehicleAccessModule`
23. `VehicleGroupsModule`
24. `VehicleSchedulesModule`
25. `InternalModule`
26. `UsersModule`

Global guard : `ThrottlerGuard`
Health controller : `HealthController` (registered in AppModule)

### 2.2 Modules existants

| Module | Chemin | Controllers | Services | Dependances |
|---|---|---|---|---|
| **Auth** | `src/auth/` | `AuthController` (POST login, refresh) | `AuthService` | PrismaService, ConfigService, AuthClientService |
| **AuthClient** | `src/auth-client/` | - | `AuthClientService` | ConfigService (Vizyo Auth external API) |
| **Vehicles** | `src/vehicles/` | `VehiclesController` (CRUD + stats) | `VehiclesService` | PrismaService |
| **Trackers** | `src/trackers/` | `TrackersController` (CRUD + assign/unassign) | `TrackersService` | PrismaService |
| **Positions** | `src/positions/` | `PositionsController` (GET list) | `PositionsService` (ingest + list) | PrismaService, RealtimeGateway, TripsService |
| **Alerts** | `src/alerts/` | `AlertsController` (list, count, acknowledge) | `AlertsService` | PrismaService, RealtimeGateway, VehicleAccessService |
| **EngineControl** | `src/engine-control/` | `EngineControlController` | `EngineControlService` | PrismaService, SocketRegistryService, CobanWireLogger |
| **Geofences** | `src/geofences/` | `GeofencesController` (CRUD) | `GeofencesService` | PrismaService |
| **Trips** | `src/trips/` | `TripsController` (list, daily summary, recompute) | `TripsService`, `TripSegmenterService` | PrismaService, RealtimeGateway |
| **Fleets** | `src/fleets/` | `FleetsController` | `FleetsService` | PrismaService |
| **Users** | `src/users/` | `UsersController` | `UsersService` | PrismaService |
| **TrackerCommands** | `src/tracker-commands/` | `TrackerCommandsController` | `TrackerCommandsService`, `AckWaiterService` | PrismaService, SocketRegistryService, BullMQ |
| **TrackerTcp** | `src/tracker-tcp/` | - | `TcpServerService` | SocketRegistryService, PrismaService, PositionsService, AlertsService, RealtimeGateway, CobanWireLogger, ErrorLogger, AckWaiterService |
| **Realtime** | `src/realtime/` | - | `RealtimeGateway` (WebSocket) | AuthService |
| **SocketRegistry** | `src/socket-registry/` | - | `SocketRegistryService` | - (in-memory Map) |
| **Observability** | `src/observability/` | `ObservabilityController` | `CobanWireLogger`, `ErrorLogger`, `AllExceptionsFilter` | PrismaService, ConfigService |
| **VehicleAccess** | `src/vehicle-access/` | - | `VehicleAccessService` | PrismaService |
| **VehicleGroups** | `src/vehicle-groups/` | `VehicleGroupsController` | `VehicleGroupsService` | PrismaService |
| **VehicleSchedules** | `src/vehicle-schedules/` | `VehicleSchedulesController` | `VehicleSchedulesService`, `ScheduleCronService` | PrismaService, EngineControlService |
| **Internal** | `src/internal/` | `InternalController` (fleet provision/suspend/activate, users CRUD) | - | PrismaService, AuthClientService |
| **Prisma** | `src/prisma/` | - | `PrismaService` | - |
| **Health** | `src/health/` | `HealthController` (GET /api/health) | - | - |

### 2.3 Module canonique : `vehicles`

**Structure :**
```
vehicles/
  vehicles.module.ts
  vehicles.controller.ts
  vehicles.service.ts
  vehicles.service.spec.ts
  dto/
    create-vehicle.dto.ts
    update-vehicle.dto.ts
```

**Exemple DTO (CreateVehicleDto) :**
```typescript
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { VehicleType } from '@prisma/client';

export class CreateVehicleDto {
  @IsString() @Length(1, 20)
  plate!: string;

  @IsOptional() @IsEnum(VehicleType)
  type?: VehicleType;

  @IsOptional() @IsString() @Length(1, 50)
  brand?: string;

  @IsOptional() @IsString() @Length(1, 50)
  model?: string;

  @IsOptional() @IsInt() @Min(1950) @Max(new Date().getFullYear() + 1)
  year?: number;

  @IsOptional() @IsString() @Length(1, 30)
  color?: string;

  @IsOptional() @IsUUID()
  fleetId?: string;
}
```

**Strategie d'authentification :**
- JWT via service externe Vizyo Auth (`VIZYO_AUTH_API_URL`)
- `JwtAuthGuard` : extrait Bearer token, appelle `AuthService.verifyAccessToken()` puis `resolveLocalUser()` via Prisma
- `RolesGuard` + decorateur `@Roles(UserRole.FLEET_ADMIN, ...)` pour RBAC
- `AuthUser` interface : `{ id, authUserId, email, firstName, lastName, role, fleetId, isActive, permissions }`
- Token signe par Vizyo Auth, verifie localement avec `VIZYO_AUTH_JWT_ACCESS_SECRET`

### 2.4 Serveur TCP trackers

- Chemin : `apps/api/src/tracker-tcp/tcp-server.service.ts`
- Port : configurable via `TRACKER_TCP_PORT` (defaut 5023)
- Protocole : Coban GPS403D, parsing via `decodeFrame()` de `@vizyo/tracky-shared`

**Stockage des sockets :**
- `SocketRegistryService` (`src/socket-registry/socket-registry.service.ts`)
- `Map<string, RegisteredSocket>` en memoire (cle = IMEI)
- Interface `RegisteredSocket` : `{ imei, socket, connectedAt, lastSeenAt, remoteAddress }`
- Methodes : `register()`, `unregister()`, `touch()`, `get()`, `send()`, `has()`, `listOnline()`

**Dispatch des commandes sortantes :**
- `EngineControlService.dispatchCommand()` : recupere socket via `this.sessionRegistry.get(imei)`, encode la commande Coban, appelle `socket.write(payload)`
- `TrackerCommandsService` : meme pattern pour les commandes generiques
- `AckWaiterService` : attente d'ACK par pattern-matching sur les frames `unknown` recues

**Lien IMEI <-> Vehicule :**
- Table `trackers` : `imei` (unique) + `vehicleId` (unique, nullable)
- A la connexion TCP : `decodeFrame` extrait l'IMEI du login frame -> lookup `prisma.tracker.findUnique({ where: { imei } })` -> si tracker existe, enregistrement dans le registry
- Un tracker sans vehicule associe (`vehicleId: null`) peut se connecter mais les positions ne sont pas rattachees a un vehicule

### 2.5 WebSocket / Socket.IO

**Gateway :** `apps/api/src/realtime/realtime.gateway.ts`
- Namespace : `/realtime`
- CORS : configurable via `CORS_ORIGIN`

**Evenements emis vers le front :**
| Evenement | Payload type | Description |
|---|---|---|
| `position:update` | `PositionUpdateEvent` | Nouvelle position recue |
| `tracker:status` | `TrackerStatusChangedDto` | Changement online/offline |
| `alert:new` | `AlertEvent` | Nouvelle alerte |
| `alert:acknowledged` | `{ id, acknowledgedAt, acknowledgedBy }` | Alerte acquittee |
| `geofence:violation` | `GeofenceViolationEvent` | Entree/sortie geofence |
| `trip:started` | `TripStartedEvent` | Debut de trajet |
| `trip:completed` | `TripCompletedEvent` | Fin de trajet |

**Authentification WS :**
- Token envoye via `client.handshake.auth.token`
- Verification JWT via `AuthService.verifyAccessToken()` + `resolveLocalUser()`
- Client rejoint room `fleet:<fleetId>` ; SUPER_ADMIN rejoint `fleet:*`
- Connexion refusee si pas de token ou token invalide

### 2.6 Tests

- Framework : **Jest** (^30.0.0 avec ts-jest)
- 12 fichiers de tests unitaires identifies :
  - `positions.service.spec.ts`
  - `vehicles.service.spec.ts`
  - `internal.controller.spec.ts`
  - `tracker-commands.service.spec.ts`
  - `ack-waiter.service.spec.ts`
  - `engine-control.service.spec.ts`
  - `alerts.service.spec.ts`
  - `trackers.service.spec.ts`
  - `schedule-cron.service.spec.ts`
  - `auth.service.spec.ts`
  - `observability.spec.ts`
  - `trip-segmenter.service.spec.ts`
- Tests e2e : *absent*
- Couverture : documentation mentionne 112 tests API + 72 tests shared

**Exemple test unitaire (VehiclesService) :**
```typescript
describe('VehiclesService', () => {
  let service: VehiclesService;
  let prisma: { vehicle: { create: jest.Mock; findMany: jest.Mock; ... }; tracker: { update: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      vehicle: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(vehicleRecord(data))),
        findMany: jest.fn().mockResolvedValue([vehicleRecord()]),
        findUnique: jest.fn().mockResolvedValue(vehicleRecord()),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve(vehicleRecord(data))),
        delete: jest.fn().mockResolvedValue(undefined),
      },
      tracker: { update: jest.fn().mockResolvedValue(undefined) },
    };
    const module = await Test.createTestingModule({
      providers: [VehiclesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(VehiclesService);
  });

  it('should create vehicle using requestedBy.fleetId for non-SUPER_ADMIN', async () => {
    const result = await service.create({ plate: 'AB-123-CD', brand: 'Renault' }, fleetAdmin);
    expect(prisma.vehicle.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fleetId: FLEET_ID }) }),
    );
    expect(result.plate).toBe('AB-123-CD');
  });
});
```

---

## 3. Schema Prisma

### 3.1 Modeles (fichier `apps/api/prisma/schema.prisma`)

**Enums :**
```prisma
enum UserRole       { SUPER_ADMIN  FLEET_ADMIN  FLEET_MANAGER  VIEWER }
enum TrackerStatus  { ONLINE  OFFLINE  IDLE }
enum GeofenceType   { CIRCLE  POLYGON }
enum GeofenceRule   { ENTER  EXIT  BOTH }
enum AlertType      { SOS  POWER_CUT  ACCIDENT  COLLISION  LOW_BATTERY  OVERSPEED
                      GEOFENCE_ENTER  GEOFENCE_EXIT  MOVEMENT_IDLE  HARSH_BRAKING
                      HARSH_ACCELERATION  HARSH_TURN  BONNET  DOOR  VIBRATION  UNKNOWN }
enum AlertSeverity  { INFO  WARNING  CRITICAL }
enum VehicleType    { CAR  TRUCK  VAN  MOTORCYCLE  BICYCLE  BUS  CONSTRUCTION  OTHER }
enum AccessType     { ALL  GROUP  VEHICLE }
enum EngineAction   { CUT  RESTORE }
enum CommandStatus  { PENDING  SENT  ACKNOWLEDGED  FAILED  REJECTED_SPEED }
enum TrackerCommandStatus  { PENDING  SCHEDULED  SENT  ACKNOWLEDGED  FAILED  CANCELLED }
enum TrackerCommandChannel { TCP  SMS }
```

**Modeles :**
```prisma
model Fleet {
  id        String   @id @default(uuid()) @db.Uuid
  name      String
  clientId  String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  users         User[]
  vehicles      Vehicle[]
  geofences     Geofence[]
  alerts        Alert[]
  vehicleGroups VehicleGroup[]
  @@map("fleets")
}

model User {
  id          String    @id @default(uuid()) @db.Uuid
  authUserId  String    @unique
  email       String    @unique
  firstName   String?
  lastName    String?
  role        UserRole  @default(VIEWER)
  permissions Json?
  isActive    Boolean   @default(true)
  fleetId     String?   @db.Uuid
  fleet       Fleet?    @relation(fields: [fleetId], references: [id], onDelete: SetNull)
  acknowledgedAlerts Alert[]           @relation("AlertAcknowledgedBy")
  trackerCommands    TrackerCommand[]
  vehicleAccess      UserVehicleAccess[]
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([fleetId])
  @@map("users")
}

model Vehicle {
  id        String      @id @default(uuid()) @db.Uuid
  fleetId   String      @db.Uuid
  fleet     Fleet       @relation(fields: [fleetId], references: [id], onDelete: Cascade)
  plate     String
  type      VehicleType @default(CAR)
  brand     String?
  model     String?
  year      Int?
  color     String?
  tracker   Tracker?
  schedule  VehicleSchedule?
  trips     Trip[]
  alerts    Alert[]
  groups    VehicleGroupAssignment[]
  userAccess UserVehicleAccess[]
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  @@unique([fleetId, plate])
  @@index([fleetId])
  @@map("vehicles")
}

model Tracker {
  id         String        @id @default(uuid()) @db.Uuid
  imei       String        @unique
  model      String        @default("COBAN_GPS403D")
  status     TrackerStatus @default(OFFLINE)
  lastSeenAt DateTime?
  vehicleId  String?       @unique @db.Uuid
  vehicle    Vehicle?      @relation(fields: [vehicleId], references: [id], onDelete: SetNull)
  positions  Position[]
  commands   EngineControlCommand[]
  trackerCommands TrackerCommand[]
  alerts     Alert[]
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  @@index([status])
  @@map("trackers")
}

model Position {
  id         String   @id @default(uuid()) @db.Uuid
  trackerId  String   @db.Uuid
  tracker    Tracker  @relation(fields: [trackerId], references: [id], onDelete: Cascade)
  lat        Float
  lng        Float
  speedKmh   Float    @default(0)
  heading    Float    @default(0)
  altitude   Float?
  satellites Int?
  valid      Boolean  @default(true)
  timestamp  DateTime
  createdAt  DateTime @default(now())
  @@index([trackerId, timestamp(sort: Desc)])
  @@map("positions")
}
-- Note : colonne PostGIS `location` geography(Point, 4326) ajoutee manuellement dans migration

model Trip {
  id                 String   @id @default(uuid()) @db.Uuid
  vehicleId          String   @db.Uuid
  vehicle            Vehicle  @relation(fields: [vehicleId], references: [id], onDelete: Cascade)
  trackerId          String?  @db.Uuid
  fleetId            String?  @db.Uuid
  startedAt          DateTime
  endedAt            DateTime?
  durationSeconds    Int      @default(0)
  startLat           Float    @default(0)
  startLng           Float    @default(0)
  endLat             Float?
  endLng             Float?
  distanceKm         Float    @default(0)
  distanceMeters     Float    @default(0)
  maxSpeed           Float    @default(0)
  avgSpeed           Float    @default(0)
  positionCount      Int      @default(0)
  segmentationSource String   @default("live")
  polyline           String?
  createdAt          DateTime @default(now())
  @@index([vehicleId, startedAt(sort: Desc)])
  @@index([fleetId, startedAt(sort: Desc)])
  @@map("trips")
}

model Geofence {
  id           String       @id @default(uuid()) @db.Uuid
  fleetId      String       @db.Uuid
  fleet        Fleet        @relation(fields: [fleetId], references: [id], onDelete: Cascade)
  name         String
  type         GeofenceType
  rule         GeofenceRule @default(BOTH)
  centerLat    Float        @default(0)
  centerLng    Float        @default(0)
  radiusMeters Int          @default(500)
  color        String?      @default("#10e0a0")
  active       Boolean      @default(true)
  createdAt    DateTime     @default(now())
  updatedAt    DateTime     @updatedAt
  @@index([fleetId])
  @@map("geofences")
}
-- Note : colonne PostGIS `geometry` geography(Geometry, 4326) ajoutee manuellement

model Alert {
  id               String        @id @default(uuid()) @db.Uuid
  fleetId          String        @db.Uuid
  fleet            Fleet         @relation(...)
  vehicleId        String?       @db.Uuid
  vehicle          Vehicle?      @relation(...)
  trackerId        String?       @db.Uuid
  tracker          Tracker?      @relation(...)
  type             AlertType
  severity         AlertSeverity @default(WARNING)
  title            String
  message          String?
  payload          Json?
  latitude         Float?
  longitude        Float?
  acknowledgedAt   DateTime?
  acknowledgedBy   String?       @db.Uuid
  acknowledgedUser User?         @relation("AlertAcknowledgedBy", ...)
  createdAt        DateTime      @default(now())
  @@index([fleetId, createdAt(sort: Desc)])
  @@index([fleetId, acknowledgedAt])
  @@index([vehicleId])
  @@index([trackerId])
  @@map("alerts")
}

model VehicleGroup {
  id        String  @id @default(uuid()) @db.Uuid
  name      String
  fleetId   String  @db.Uuid
  fleet     Fleet   @relation(...)
  vehicles  VehicleGroupAssignment[]
  users     UserVehicleAccess[]
  createdAt DateTime @default(now())
  @@unique([fleetId, name])
  @@map("vehicle_groups")
}

model VehicleGroupAssignment {
  vehicleId String @db.Uuid
  groupId   String @db.Uuid
  vehicle   Vehicle      @relation(...)
  group     VehicleGroup @relation(...)
  @@id([vehicleId, groupId])
  @@map("vehicle_group_assignments")
}

model UserVehicleAccess {
  id         String        @id @default(uuid()) @db.Uuid
  userId     String        @db.Uuid
  user       User          @relation(...)
  accessType AccessType
  groupId    String?       @db.Uuid
  group      VehicleGroup? @relation(...)
  vehicleId  String?       @db.Uuid
  vehicle    Vehicle?      @relation(...)
  @@index([userId])
  @@map("user_vehicle_access")
}

model TrackerCommand {
  id              String                @id @default(uuid()) @db.Uuid
  trackerId       String                @db.Uuid
  tracker         Tracker               @relation(...)
  templateId      String
  category        String
  params          Json                  @default("{}")
  payload         String
  channel         TrackerCommandChannel @default(TCP)
  status          TrackerCommandStatus  @default(PENDING)
  scheduledAt     DateTime?
  sentAt          DateTime?
  ackedAt         DateTime?
  ackResponse     String?
  lastError       String?
  requestedBy     String                @db.Uuid
  requestedByUser User                  @relation(...)
  createdAt       DateTime              @default(now())
  updatedAt       DateTime              @updatedAt
  @@index([trackerId, createdAt(sort: Desc)])
  @@index([status])
  @@index([scheduledAt])
  @@map("tracker_commands")
}

model WireLog {
  id        String   @id @default(uuid()) @db.Uuid
  imei      String
  direction String   // 'IN' | 'OUT'
  raw       String   @db.Text
  frameType String?  // 'login' | 'heartbeat' | 'position' | 'unknown' | 'command' | 'ack'
  commandId String?  @db.Uuid
  context   Json?
  createdAt DateTime @default(now())
  @@index([imei, createdAt(sort: Desc)])
  @@index([commandId])
  @@index([createdAt])
  @@map("wire_logs")
}

model ErrorLog {
  id        String   @id @default(uuid()) @db.Uuid
  level     String   // 'ERROR' | 'CRITICAL'
  source    String
  message   String
  stack     String?  @db.Text
  imei      String?
  commandId String?  @db.Uuid
  userId    String?  @db.Uuid
  context   Json?
  createdAt DateTime @default(now())
  @@index([source, createdAt(sort: Desc)])
  @@index([imei])
  @@index([commandId])
  @@index([createdAt])
  @@map("error_logs")
}

model EngineControlCommand {
  id          String        @id @default(uuid()) @db.Uuid
  trackerId   String        @db.Uuid
  tracker     Tracker       @relation(...)
  action      EngineAction
  scheduledAt DateTime?
  status      CommandStatus @default(PENDING)
  reason      String?
  requestedBy String        @db.Uuid
  source      String        @default("MANUAL") // "MANUAL" | "SCHEDULER"
  lastError   String?
  sentAt      DateTime?
  ackedAt     DateTime?
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt
  @@index([trackerId, status])
  @@map("engine_control_commands")
}

model VehicleSchedule {
  id        String @id @default(uuid()) @db.Uuid
  vehicleId String @unique @db.Uuid
  vehicle   Vehicle @relation(...)
  enabled   Boolean @default(false)
  timezone  String  @default("Europe/Paris")
  mondayEnabled..sundayEnabled    Boolean
  mondayStart..sundayStart        String?  // "08:00"
  mondayEnd..sundayEnd            String?  // "20:00"
  lastEvaluatedAt    DateTime?
  lastEvaluatedState String?   // "IN_WINDOW" | "OUT_OF_WINDOW"
  overrideUntil      DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@map("vehicle_schedules")
}
```

### 3.2 Migrations

- Nombre : **12 migrations**
- Derniere : `20260414120000_add_vehicle_schedules` (2026-04-14)

Liste chronologique :
1. `20260408125517_init`
2. `20260409092820_add_valid_to_position`
3. `20260409110000_add_alerts_module`
4. `20260410120000_add_geofences_fields`
5. `20260410140000_add_trips_v1`
6. `20260411120000_auth_via_vizyo_auth`
7. `20260412090007_add_vehicle_groups`
8. `20260412115609_add_user_permissions`
9. `20260412212503_add_vehicle_type`
10. `20260413120000_observability_logs`
11. `20260413130000_tracker_commands_init`
12. `20260414120000_add_vehicle_schedules`

### 3.3 Seeds

- Fichier : `apps/api/prisma/seed.ts`
- Contenu : cree une fleet "Vizyo Demo Fleet" (UUID fixe) + upsert admin `admin@vizyoagency.com` avec role `SUPER_ADMIN`
- Necessite `SEED_ADMIN_AUTH_USER_ID` (ID du user dans Vizyo Auth externe)

---

## 4. Frontend Angular

### 4.1 Structure

```
apps/web/src/
├── main.ts
├── index.html
├── styles.css                          # Tailwind 4 + theme CSS custom properties
└── app/
    ├── app.ts                          # Root component (standalone)
    ├── app.config.ts                   # providers: router, httpClient + interceptor
    ├── app.routes.ts                   # Route definitions
    ├── core/
    │   ├── auth/
    │   │   └── auth.guard.ts           # canActivate: token check
    │   ├── guards/
    │   │   └── super-admin.guard.ts
    │   ├── interceptors/
    │   │   └── auth.interceptor.ts     # Bearer token + refresh logic
    │   ├── services/
    │   │   ├── auth.service.ts
    │   │   ├── alerts.service.ts
    │   │   ├── positions.service.ts
    │   │   ├── geofences.service.ts
    │   │   ├── trackers.service.ts
    │   │   ├── trips.service.ts
    │   │   ├── vehicles.service.ts
    │   │   ├── users.service.ts
    │   │   ├── fleets.service.ts
    │   │   ├── vehicle-groups.service.ts
    │   │   ├── preferences.service.ts
    │   │   ├── realtime.service.ts
    │   │   ├── permissions.service.ts
    │   │   ├── tracker-commands.service.ts
    │   │   ├── admin-logs.service.ts
    │   │   ├── vehicle-schedules.service.ts
    │   │   └── engine-control.service.ts
    │   └── theme/
    │       └── theme.service.ts
    ├── features/
    │   ├── alerts/alerts.component.ts
    │   ├── dashboard/dashboard.component.ts
    │   ├── map/map.component.ts
    │   ├── vehicles/
    │   │   ├── vehicles-list.component.ts
    │   │   ├── vehicle-detail.component.ts
    │   │   ├── vehicle-dialog/vehicle-dialog.component.ts
    │   │   ├── vehicle-groups-tab.component.ts
    │   │   └── vehicle-schedule/vehicle-schedule.component.ts
    │   ├── engine-control/engine-control-button.component.ts
    │   ├── tracker-commands/
    │   │   ├── commands-panel.component.ts
    │   │   └── admin-commands.component.ts
    │   ├── geofences/
    │   │   ├── geofences-list.component.ts
    │   │   └── geofence-draw-dialog/geofence-draw-dialog.component.ts
    │   ├── reports/
    │   │   ├── reports.component.ts
    │   │   └── trip-replay.component.ts
    │   ├── observability/observability.component.ts
    │   ├── settings/settings.component.ts
    │   ├── users/
    │   │   ├── users-list.component.ts
    │   │   ├── user-drawer.component.ts
    │   │   └── vehicle-access-drawer.component.ts
    │   ├── auth/login.component.ts
    │   └── placeholder/placeholder.component.ts
    ├── layouts/
    │   ├── auth-layout.component.ts
    │   └── dashboard-layout.component.ts
    └── shared/
        ├── components/
        │   ├── metric-card.component.ts
        │   └── theme-toggle.component.ts
        ├── ui/
        │   ├── logo/logo.component.ts
        │   ├── mini-map/mini-map.component.ts
        │   ├── confirm-modal/confirm-modal.component.ts
        │   ├── toast/toast-container.component.ts
        │   ├── toast/toast.service.ts
        │   └── alerts-bell/alerts-bell.component.ts
        └── utils/
            ├── relative-time.ts
            ├── vehicle-icons.ts
            └── leaflet-markers.ts
```

### 4.2 Conventions

- **Angular Signals** : utilise partout (services, composants). Ex : `signal()`, `computed()`, `effect()` dans `AuthService`, `RealtimeService`, `DashboardComponent`
- **Standalone components** : 100% standalone (pas de NgModule)
- **State management** : services avec signals Angular. Pas de NgRx
- **UI library** : **Tailwind CSS 4** + composants custom. Pas de Material/PrimeNG. Icons via `lucide-angular`
- **Fonts** : Inter (sans), Poppins (display), JetBrains Mono (mono)
- **Theme** : dark/light via CSS custom properties + `data-theme` attribute sur `<html>`

**Routes principales :**
| Route | Composant | Guard |
|---|---|---|
| `/login` | `LoginComponent` (AuthLayout) | - |
| `/dashboard` | `DashboardComponent` (DashboardLayout) | authGuard |
| `/map` | `MapComponent` (fullscreen) | authGuard |
| `/vehicles` | `VehiclesListComponent` | authGuard |
| `/vehicles/:id` | `VehicleDetailComponent` | authGuard |
| `/alerts` | `AlertsComponent` | authGuard |
| `/geofences` | `GeofencesListComponent` | authGuard |
| `/reports` | `ReportsComponent` | authGuard |
| `/users` | `UsersListComponent` | authGuard |
| `/settings` | `SettingsComponent` | authGuard |
| `/admin/observability` | `ObservabilityComponent` | authGuard + superAdminGuard |
| `/admin/commands` | `AdminCommandsComponent` | authGuard + superAdminGuard |

### 4.3 Authentification frontend

- **Service** : `apps/web/src/app/core/services/auth.service.ts`
- **Methode** : JWT stocke en `localStorage` (`tracky_token`, `tracky_refresh_token`, `tracky_user`)
- **Login** : POST `/api/auth/login` -> stocke accessToken + refreshToken + user
- **Refresh** : POST `/api/auth/refresh` avec refreshToken, prevention de requetes paralleles
- **Signals** : `token`, `user`, `isAuthenticated` (computed)

**Guards :**
- `authGuard` (`core/auth/auth.guard.ts`) : verifie presence du token dans localStorage
- `superAdminGuard` (`core/guards/super-admin.guard.ts`) : verifie role = SUPER_ADMIN

**Interceptor HTTP :**
- `authInterceptor` (`core/interceptors/auth.interceptor.ts`) : ajoute `Authorization: Bearer <token>`, gestion automatique du refresh sur 401, exclusion de `/auth/login` et `/auth/refresh`

### 4.4 Composants metiers

| Feature | Composant principal | Route |
|---|---|---|
| Dashboard | `features/dashboard/dashboard.component.ts` | `/dashboard` |
| Carte temps reel | `features/map/map.component.ts` | `/map` |
| Liste vehicules | `features/vehicles/vehicles-list.component.ts` | `/vehicles` |
| Detail vehicule | `features/vehicles/vehicle-detail.component.ts` | `/vehicles/:id` |
| Alertes | `features/alerts/alerts.component.ts` | `/alerts` |
| Geofences | `features/geofences/geofences-list.component.ts` | `/geofences` |
| Rapports/Trajets | `features/reports/reports.component.ts` | `/reports` |
| Utilisateurs | `features/users/users-list.component.ts` | `/users` |
| Observabilite | `features/observability/observability.component.ts` | `/admin/observability` |
| Commandes admin | `features/tracker-commands/admin-commands.component.ts` | `/admin/commands` |
| Parametres | `features/settings/settings.component.ts` | `/settings` |

### 4.5 Carte Leaflet

- **Composant principal** : `apps/web/src/app/features/map/map.component.ts`
- **Mini-map** : `apps/web/src/app/shared/ui/mini-map/mini-map.component.ts` (pour detail vehicule)
- **Tiles** : OpenStreetMap
- **Centre par defaut** : lat 46.6034, lng 1.8883 (France), zoom 12
- **Reception positions temps reel** : via `RealtimeService` (Socket.IO client) -> signal `positions` -> `effect()` dans le composant map met a jour les markers Leaflet
- **Markers** : DivIcon custom avec SVG vehicule, couleur selon vitesse, ring anime, rotation
- **Trails** : Polyline avec longueur configurable via preferences
- **Geofences** : Cercles Leaflet avec tooltip

---

## 5. Shared / Packages communs

### 5.1 Parser Coban GPS403D

- Chemin : `packages/shared/src/protocol/`
- Fichiers :
  - `coban.types.ts` : types CobanFrame (login, heartbeat, position, unknown), CobanCommand, CobanAlarmType (24 types)
  - `coban.parser.ts` : `decodeFrame(raw: string): CobanFrame` — supporte login, heartbeat, position reguliere, position alternative, frames inconnues
  - `coban.encoder.ts` : `encodeCommand(imei: string, cmd: CobanCommand): string` — 9 types (engine_stop/resume, alarm_arm/disarm, position_single/tracking, etc.)
  - `coban.utils.ts` : `nmeaToDecimal()`, `knotsToKph()`, `formatFrequency()`
  - `coban.catalog.ts` : 20+ templates de commandes avec metadata (category, params, ACK pattern, timeout)
- Tests : 72 tests documentes (dans le package shared)

### 5.2 Types partages

- Chemin : `packages/shared/src/`
- Exports publics (via `index.ts`) :

**DTOs :**
- `VehicleDto`, `VehicleState` (moving/idle/stopped/engine_cut/offline)
- `TrackerDto`, `TrackerStatus` (online/offline/idle)
- `PositionDto` (lat, lng, speedKmh, heading, altitude, timestamp)
- `AlertDto`, `AlertEvent` (type, severity, payload)
- `GeofenceDto`, `GeofenceViolationEvent`
- `TripDto`, `TripDailySummaryDto`, `TripRecomputeResultDto`, `TripStartedEvent`, `TripCompletedEvent`

**WS Events :**
- `WS_EVENTS` object avec constantes : `POSITION_UPDATE`, `TRACKER_STATUS`, `ALERT_NEW`, `ALERT_ACK`, `GEOFENCE_VIOLATION`, `TRIP_STARTED`, `TRIP_COMPLETED`

---

## 6. App mobile Capacitor

*Absent, a creer de zero.*

Le roadmap V2 (`docs/09-roadmap-v2.md`) mentionne une app mobile Capacitor en priorite basse (scaling 10+ clients).

---

## 7. Utilisateurs & Roles

### 7.1 Modele utilisateur actuel

```prisma
model User {
  id          String    @id @default(uuid()) @db.Uuid
  authUserId  String    @unique          // ID dans Vizyo Auth externe
  email       String    @unique
  firstName   String?
  lastName    String?
  role        UserRole  @default(VIEWER) // SUPER_ADMIN | FLEET_ADMIN | FLEET_MANAGER | VIEWER
  permissions Json?                      // permissions granulaires optionnelles
  isActive    Boolean   @default(true)
  fleetId     String?   @db.Uuid         // null pour SUPER_ADMIN
  fleet       Fleet?    @relation(...)
}
```

**Roles :**
- `SUPER_ADMIN` : acces global toutes flottes, `fleetId` = null
- `FLEET_ADMIN` : admin d'une flotte
- `FLEET_MANAGER` : gestionnaire d'une flotte
- `VIEWER` : lecture seule, acces filtre par `UserVehicleAccess`

**Multi-tenancy :**
- Isolation par `fleetId` sur toutes les entites metier (Vehicle, Tracker via Vehicle, Alert, Geofence, Trip, VehicleGroup)
- `Fleet` : `{ id, name, clientId }` — pas de notion Organization au-dessus
- Acces granulaire : `UserVehicleAccess` avec `AccessType` (ALL, GROUP, VEHICLE) pour les VIEWER

### 7.2 Notion de "Driver" (conducteur)

- *Absent* : il n'existe **aucune entite Driver** dans le schema Prisma
- *Absent* : aucune relation Vehicle <-> Driver
- *Absent* : aucune notion de "conducteur principal par defaut"
- Le modele `Trip` n'a **aucun champ** `driverId` ou equivalent
- Le modele `Position` n'a **aucun champ** d'identification conducteur

---

## 8. Entites Position / Trip

### 8.1 Modele Position

```prisma
model Position {
  id         String   @id @default(uuid()) @db.Uuid
  trackerId  String   @db.Uuid
  tracker    Tracker  @relation(...)
  lat        Float
  lng        Float
  speedKmh   Float    @default(0)
  heading    Float    @default(0)
  altitude   Float?
  satellites Int?
  valid      Boolean  @default(true)
  timestamp  DateTime
  createdAt  DateTime @default(now())
  @@index([trackerId, timestamp(sort: Desc)])
  @@map("positions")
}
```
Note : colonne PostGIS `location` geography(Point, 4326) ajoutee manuellement + index GIST.

### 8.2 Modele Trip

```prisma
model Trip {
  id                 String   @id @default(uuid()) @db.Uuid
  vehicleId          String   @db.Uuid
  vehicle            Vehicle  @relation(...)
  trackerId          String?  @db.Uuid
  fleetId            String?  @db.Uuid
  startedAt          DateTime
  endedAt            DateTime?
  durationSeconds    Int      @default(0)
  startLat           Float    @default(0)
  startLng           Float    @default(0)
  endLat             Float?
  endLng             Float?
  distanceKm         Float    @default(0)
  distanceMeters     Float    @default(0)
  maxSpeed           Float    @default(0)
  avgSpeed           Float    @default(0)
  positionCount      Int      @default(0)
  segmentationSource String   @default("live")  // "live" | "ignition" | "speed" | "hybrid"
  polyline           String?
  createdAt          DateTime @default(now())
  @@index([vehicleId, startedAt(sort: Desc)])
  @@index([fleetId, startedAt(sort: Desc)])
  @@map("trips")
}
```

### 8.3 Comment un trip est cree

**Service responsable :** `TripSegmenterService` (`apps/api/src/trips/trip-segmenter.service.ts`)

**Declenchement :** appele par `PositionsService.ingest()` a chaque position recue, et aussi par `TripsService.recompute()` pour retraitement batch.

**Criteres de segmentation (hybride ignition + vitesse) :**
1. **Ignition OFF** (`pos.ignition === false`) : cloture immediate du trip en cours (source = `ignition`)
2. **Arret prolonge** : vitesse = 0 pendant >= `TRIP_STOP_TIMEOUT_MS` (5 min) -> cloture (source = `speed`)
3. **Demarrage** : vitesse > `TRIP_SPEED_THRESHOLD_KMH` (5 km/h) confirmee pendant >= `TRIP_MOVING_CONFIRM_MS` (30 sec)
4. **Distance minimale** : trip ignore si distance < `TRIP_MIN_DISTANCE_METERS` (50 m)

**Constantes :**
```typescript
TRIP_SPEED_THRESHOLD_KMH = 5;
TRIP_STOP_TIMEOUT_MS     = 5 * 60 * 1000;   // 5 minutes
TRIP_MOVING_CONFIRM_MS   = 30 * 1000;        // 30 secondes
TRIP_MIN_DISTANCE_METERS = 50;
TRIP_TIMEOUT_CHECK_MS    = 60 * 1000;        // 1 minute (check periodique)
```

---

## 9. Mode vie privee — etat actuel

*A creer de zero.*

- Aucun champ `privacyMode`, `isPrivate`, `personalTrip` ou equivalent sur aucune entite
- Aucune logique de masquage de positions
- Aucun mecanisme d'activation/desactivation d'un mode personnel
- Le modele `Trip` n'a pas de champ de classification pro/perso
- Le modele `Position` n'a pas de flag de confidentialite

---

## 10. Identification conducteur — etat actuel

*A creer de zero.*

- Aucune entite `Driver` dans le schema
- Aucun mecanisme d'identification (PIN, NFC, RFID, Bluetooth, app mobile)
- Le modele `Trip` n'a pas de `driverId`
- Le modele `Position` n'a pas de `driverId`
- Aucune UI d'assignation conducteur dans le frontend
- Le tracker Coban GPS403D supporte un mecanisme d'identification (non exploite) : *a verifier dans les specs hardware*

---

## 11. Conventions de code

### 11.1 Nommage

- **Fichiers** : kebab-case (`engine-control.service.ts`, `create-vehicle.dto.ts`, `jwt-auth.guard.ts`)
- **Classes** : PascalCase (`EngineControlService`, `CreateVehicleDto`, `JwtAuthGuard`)
- **Variables/methodes** : camelCase
- **Enums Prisma** : SCREAMING_SNAKE_CASE (`SUPER_ADMIN`, `FLEET_ADMIN`)
- **Tables SQL** : snake_case via `@@map()` (`engine_control_commands`, `vehicle_schedules`)

### 11.2 Structure de dossier NestJS module

Pattern recurrent observe :
```
src/feature-x/
  feature-x.module.ts
  feature-x.controller.ts
  feature-x.service.ts
  feature-x.service.spec.ts
  dto/
    create-feature-x.dto.ts
    update-feature-x.dto.ts
    list-feature-x.dto.ts
```

Pas de dossier `entities/` (les entites sont dans Prisma schema).
Pas de dossier `tests/` separe — tests cotes avec les sources.

### 11.3 Gestion des erreurs

- **Exceptions NestJS standard** : `NotFoundException`, `ForbiddenException`, `BadRequestException`, `ConflictException`, `UnauthorizedException`, `ServiceUnavailableException`
- **Filtre global** : `AllExceptionsFilter` (`src/observability/all-exceptions.filter.ts`)
  - Catch-all
  - Persiste les erreurs 500+ dans `ErrorLog` via `ErrorLogger`
  - Format reponse : `{ error: { code, message, requestId } }`
- Pas d'exceptions custom au-dela des exceptions NestJS standard

### 11.4 Logs

- **Librairie** : nestjs-pino (pino ^10.3.1)
- **Dev** : pino-pretty (colorize, singleLine)
- **Prod** : JSON structure
- **Redaction** : `req.headers.authorization`, `*.password`, `*.token`, `*.secret`
- **Niveaux** : configurable via `LOG_LEVEL` env var
- **Wire logging** : `CobanWireLogger` persiste les trames TCP brutes dans table `wire_logs`
- **Error logging** : `ErrorLogger` persiste les erreurs dans table `error_logs`

### 11.5 Config / variables d'environnement

- `@nestjs/config` avec validation **Zod** (`apps/api/src/config/env.validation.ts`)
- Schema Zod valide au demarrage

**Variables env critiques :**
| Variable | Description |
|---|---|
| `NODE_ENV` | development / production / test |
| `API_PORT` | Port API (defaut 3000) |
| `TRACKER_TCP_PORT` | Port TCP trackers (defaut 5023) |
| `DATABASE_URL` | URL PostgreSQL |
| `REDIS_URL` | URL Redis |
| `LOG_LEVEL` | fatal/error/warn/info/debug/trace |
| `CORS_ORIGIN` | Origine CORS autorisee |
| `MOCK_POSITIONS` | Positions simulees (dev) |
| `VIZYO_AUTH_API_URL` | URL API auth externe |
| `VIZYO_AUTH_APP_ID` | App ID auth |
| `VIZYO_AUTH_APP_SECRET` | App secret auth (min 16 chars) |
| `VIZYO_AUTH_JWT_ACCESS_SECRET` | Secret JWT partage |
| `VIZYO_AUTH_JWT_ISSUER` | Issuer JWT |
| `VIZYO_AUTH_APP_INTERNAL_ID` | Internal app ID |
| `INTERNAL_API_SECRET` | Secret API interne (min 16 chars) |
| `WIRE_LOG_ENABLED` | Activation logs TCP |

---

## 12. CI / CD

- *Absent* : aucun fichier `.github/workflows/`, `.gitlab-ci.yml`, ou equivalent
- Deploiement : manuel via Docker Compose sur VPS Hostinger (IP : 72.62.26.240)
- Pipeline : *non defini*
- Le roadmap V2 mentionne CI/CD comme priorite haute

**Images Docker (production) :**
- `Dockerfile.api` : Node 20 Alpine, multi-stage, pnpm, Prisma migrate au demarrage
- `Dockerfile.web` : Node 20 Alpine (build) + nginx Alpine (runtime)
- `Dockerfile.lp` : nginx Alpine

**Orchestration prod :**
- `docker-compose.prod.yml` : 5 services (postgres, redis, api, web, lp)
- Reverse proxy : Traefik v3 (externe, reseau `foodsqan-public`)
- Domaines : `app-tracky.vizyoagency.com` (web+api), `tracky.vizyoagency.com` (landing page)

---

## 13. Documentation existante

- **README principal** : `README.md` — stack, prerequisites, demarrage, ports, structure, regles metier
- **Docs techniques** :
  - `docs/03-protocol-coban-gps403d.md` — Spec protocole Coban detaillee
  - `docs/04-roadmap.md` — Roadmap V1 complete avec journal de sessions
  - `docs/05-hardware-bench.md` — Procedures bench hardware
  - `docs/06-tcp-commands-console.md` — Spec Phase 6 (commands console)
  - `docs/07-sms-gateway.md` — Spec Phase 7 (SMS gateway, non implemente)
  - `docs/08-logging-and-observability.md` — Spec Phase 8 (observabilite)
  - `docs/09-roadmap-v2.md` — Roadmap V2 (draft)
  - `docs/DEPLOYMENT-VPS.md.md` — Guide deploiement VPS
  - `docs/EXECUTION-TRACKER.md` — Journal d'execution des phases
  - `docs/observability-guide.md` — Guide operationnel observabilite
- **Prompts** : `docs/prompts/` — prompts Claude Code utilises pour le dev (vague-a, vague-b, bench-403c)
- **ADR** : *absent* (decisions documentees dans le roadmap mais pas de format ADR formel)
- **Diagrammes** : *absent* (pas de diagrams Mermaid ou images d'architecture)

---

## 14. Points de friction identifies

1. **Pas d'entite Driver** — L'ajout d'identification conducteur necessite une nouvelle entite `Driver`, des relations avec `User` (un conducteur peut ou non etre un utilisateur), `Vehicle` (assignation par defaut), et `Trip` (liaison trajet-conducteur). Impact large sur le schema.

2. **Position sans `driverId`** — Pour le mode vie privee, il faut pouvoir filtrer/masquer les positions par conducteur. Ajouter un `driverId` sur Position impliquerait un volume d'ecriture significatif (chaque position GPS). Alternative : marquer au niveau Trip seulement.

3. **Trip sans classification pro/perso** — Le modele Trip n'a aucun champ pour distinguer un trajet professionnel d'un trajet personnel. Necessite au minimum un champ `tripType` ou `isPrivate`.

4. **Auth externalisee (Vizyo Auth)** — L'identification conducteur (PIN, NFC) ne peut pas passer par le meme flow d'auth que les utilisateurs web. Il faut un mecanisme d'identification leger cote tracker ou app mobile, distinct du JWT Vizyo Auth.

5. **Pas d'app mobile** — Le mode vie privee CNIL necessite typiquement une action du conducteur (appui bouton, NFC, etc.). Sans app mobile ni interface sur le tracker, le mecanisme d'activation est a concevoir.

6. **SocketRegistry en memoire** — Si le serveur API redemarre, toutes les connexions tracker sont perdues. Les trackers se reconnectent naturellement, mais les commandes en attente peuvent etre perdues. Pas bloquant pour la Phase 1, mais a considerer pour la scalabilite.

7. **Colonnes PostGIS ajoutees manuellement** — Les colonnes `location` (Position) et `geometry` (Geofence) sont ajoutees hors Prisma dans les migrations SQL. Cela complique l'ajout de nouvelles colonnes geographiques (ex : zone de geofence "domicile" pour vie privee).

8. **Pas de CI/CD** — Deploiement manuel sur VPS. Les tests ne sont pas executes automatiquement avant deploiement.

9. **Tests e2e absents** — Seuls des tests unitaires avec mocks Prisma existent. Pas de tests d'integration avec base de donnees.

10. **Duplication `distanceKm` / `distanceMeters` dans Trip** — Les deux champs coexistent dans le modele, ce qui est une source potentielle d'incoherence.

11. **Certains services frontend utilisent `fetch` au lieu de `HttpClient`** — `UsersService` et `VehicleGroupsService` utilisent l'API Fetch native, ce qui bypasse l'interceptor Angular et donc le refresh automatique du token.

12. **Token JWT en localStorage** — Vulnerable au XSS. Standard pour une SPA mais a considerer si le client institutionnel a des exigences de securite renforcees.

---

## Questions ouvertes

1. **Vizyo Auth** : le service d'auth externe gere-t-il deja une notion de "driver" ou de "device authentication" ? Peut-il delivrer des tokens pour des conducteurs non-utilisateurs ?

2. **Tracker Coban GPS403D** : le hardware supporte-t-il nativement un mecanisme d'identification conducteur (lecteur iButton/RFID, entree ACC differentielle) ? La doc protocole mentionne des types d'alarme mais pas d'identification.

3. **CNIL mode vie privee** : les exigences legales exactes du client institutionnel ne sont pas dans le repo. Faut-il un masquage temps reel (positions non enregistrees) ou un masquage a posteriori (positions stockees mais non visibles) ?

4. **Multi-conducteurs par vehicule** : un vehicule peut-il avoir plusieurs conducteurs autorises, ou seulement un conducteur principal ?

5. **Retention des donnees vie privee** : les positions en mode prive doivent-elles etre purgees apres un delai, ou simplement masquees dans l'interface ?

6. **Interaction Schedule <-> Vie privee** : le VehicleSchedule existant (coupure moteur hors horaires) interfere-t-il avec le mode vie privee (un conducteur en mode perso hors horaires doit-il pouvoir rouler) ?

7. **`permissions` JSON sur User** : ce champ est defini mais son schema n'est pas documente. Quelles permissions sont actuellement utilisees ?

8. **Landing page** : le fichier `lp/vizyo-tracky.html` est un standalone HTML non connecte au build Turborepo. Est-ce intentionnel ou un reste de prototype ?

9. **Nom de fichier `DEPLOYMENT-VPS.md.md`** : double extension `.md.md` — probablement une erreur de nommage.

10. **Reseau Docker `foodsqan-public`** : le nom suggere une infra partagee avec un autre projet (FoodSqan). Les services Tracky partagent-ils des ressources avec d'autres applications sur le meme VPS ?
