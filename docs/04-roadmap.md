# 04 — Roadmap Vizyo Tracky

> **Statut :** V1.1 — 2026-04-11
> **Perimetre :** plan de route produit et technique pour les deux volets (application + landing page), avec suivi d'avancement, backlog priorise et decisions d'architecture.
> **Mise a jour :** ce document est mis a jour a la fin de chaque session de developpement. Le journal en §10 trace les changements.

---

## 1. Vision produit

Vizyo Tracky est un produit interne Vizyo Agency qui remplace l'application Baanool par defaut des traceurs GPS Coban GPS403D par une plateforme web moderne, centree sur la securite et l'experience utilisateur du gestionnaire de flotte.

**Utilisateur cible :** PME de transport, loueurs de vehicules, societes avec flotte utilitaire (10-200 vehicules).

**Differenciateurs :**

- **Securite applicative de la coupure moteur** : garde-fou double (hardware Coban + logiciel serveur) avec audit trail obligatoire, validation GPS fix, seuil de vitesse strict, et double confirmation UI.
- **Temps reel visible** : carte live avec markers qui bougent, WebSocket multi-tenant securise, pas de polling client.
- **UI moderne** : Angular 20 + Tailwind 4, design system "Command Center" mint/green, pas d'interface chinoise traduite a l'arrache.
- **Multi-flottes** : un admin Vizyo peut gerer plusieurs clients, chaque client ne voit que sa flotte.

**Modele economique :** abonnement mensuel par vehicule (tarification a finaliser). Canaux d'acquisition : WhatsApp et email, pas de self-service.

---

## 2. Architecture globale

### 2.1 Volet 1 — Application

```
┌──────────────────────────────────────────────────────────────┐
│                     apps/api (NestJS 11)                     │
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐   │
│  │ AuthModule   │   │ VehiclesMod  │   │ TrackersModule  │   │
│  │ JWT+bcrypt   │   │ CRUD+stats   │   │ CRUD+assign     │   │
│  └──────────────┘   └──────────────┘   └─────────────────┘   │
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐   │
│  │ TrackerTcp   │   │ Positions    │   │ EngineControl   │   │
│  │ :5023 Coban  │──▶│ ingest+broad │──▶│ guard+dispatch  │   │
│  └──────────────┘   └──────────────┘   └─────────────────┘   │
│         ▲                   │                    │          │
│         │                   ▼                    ▼          │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐   │
│  │ SocketReg    │   │ Realtime     │   │ PrismaModule    │   │
│  │ @Global      │   │ /realtime WS │   │ adapter-pg      │   │
│  └──────────────┘   └──────────────┘   └─────────────────┘   │
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐   │
│  │ AlertsModule │   │ GeofencesMod │   │ TripsModule     │   │
│  │ alarmes+bell │   │ CRUD+detect  │   │ segment+replay  │   │
│  └──────────────┘   └──────────────┘   └─────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Volet 2 — Landing page

Next.js + Tailwind statique sur Vercel, pas de backend. Conversion via WhatsApp + email.

### 2.3 Packages partages

- `@vizyo/shared` — types DTO, events WebSocket, protocole Coban (parser + encoder purs)

---

## 3. Etat d'avancement

### 3.1 Legende

- ✅ **Fait** : implemente, teste, valide
- 🚧 **En cours** : partiellement fait ou en iteration
- 📋 **Planifie** : prevu dans un sprint identifie
- 💭 **Backlog** : identifie, non planifie
- ❌ **Hors scope V1**

### 3.2 Volet application

| Brique                              | Statut | Notes                                                                                          |
| ----------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| Monorepo Turborepo + pnpm           | ✅     | Stack alignee Vizyo Manager/Leads                                                              |
| Docker Compose (Postgres + Redis)   | ✅     | Ports 5433 / 6379                                                                              |
| Prisma + migrations                 | ✅     | 12+ modeles, colonnes PostGIS ajoutees en raw SQL                                              |
| Auth JWT + bcrypt + jsonwebtoken    | ✅     | Pas de Passport, alignement Manager/Leads                                                      |
| RolesGuard reutilisable             | ✅     | Dans `auth/guards/`, importable depuis tout module                                             |
| SocketRegistryModule                | ✅     | `@Global()`, TrackerSocket interface (net.Socket + FakeTcpSocket)                              |
| CRUD Fleets                         | ✅     | Via seed admin, pas d'UI dediee pour l'instant                                                 |
| CRUD Vehicles                       | ✅     | 8 tests, multi-tenant strict, plate unique par fleet, GET /vehicles/stats                      |
| CRUD Trackers + assignation         | ✅     | 10 tests, IMEI unique global, assign/unassign + EventEmitter                                   |
| EngineControlModule                 | ✅     | 13 tests, garde-fou 60s stale + valid GPS + vitesse 20 km/h, dispatch reel via socket.write    |
| Parser Coban GPS403D                | ✅     | `packages/shared/src/protocol/`, 22 tests parser, no-throw                                     |
| Encoder Coban GPS403D               | ✅     | 9 commandes Traccar + custom + sos_ack, 20 tests                                               |
| TcpServerService                    | ✅     | Dispatch login/heartbeat/position/unknown, ACK SOS, reject unknown IMEI, alert creation        |
| PositionsService                    | ✅     | Persistance + broadcast WS + geofence check + trip processing, 5 tests                        |
| MockPositionEmitterService          | ✅     | FakeTcpSocket, event-driven assign, 30s sync, alarmes aleatoires                              |
| RealtimeGateway (Socket.IO)         | ✅     | 9 events WS : position, tracker:status, alert:new/ack, geofence:violation, trip:started/completed |
| **AlertsModule**                    | ✅     | CRUD + mapping CobanAlarm, broadcast WS, toast auto, acquittement, 10 tests                    |
| **GeofencesModule**                 | ✅     | CRUD cercles, detection ENTER/EXIT in-memory haversine, cache fleet, dessin Leaflet custom     |
| **TripsModule**                     | ✅     | Segmentation hybride (ignition+vitesse), recompute admin, cron timeout 60s, 8 tests segmenter  |
| Angular 20 standalone + signals     | ✅     | Tailwind 4, design system Tracky mint/green                                                    |
| Auth UI (login + logout)            | ✅     | Pre-rempli dev, AuthService JWT decode, reconnexion WS au refresh                              |
| Dashboard (suivi temps reel)        | ✅     | Metric cards live (GET /vehicles/stats, refresh 30s), positions live, engine control buttons    |
| Carte Leaflet temps reel            | ✅     | Markers SVG, trails, geofence circles overlay, popup lien fiche vehicule                       |
| **UI Engine Control**               | ✅     | Bouton CUT/RESTORE, double confirmation, toast, pills historique, AuthInterceptor              |
| **Module Alerts UI**                | ✅     | Widget bell header (badge+dropdown), page /alerts filtrable, sync bidirectionnelle WS           |
| **Page Vehicule detail**            | ✅     | Fiche /vehicles/:id, 5 onglets (carte, historique, alertes, commandes, trajets), mini-map live |
| **Page Vehicules liste**            | ✅     | Table, modal stepper Add Vehicle+Tracker, pastille statut live via WS                          |
| **Page Geofences**                  | ✅     | Table CRUD, dessin custom Leaflet click-to-place + slider rayon, overlay carte                 |
| **Page Rapports**                   | ✅     | KPI cards, trips list, replay modal avec animation Leaflet (play/pause/speed), recompute admin |
| **Identite visuelle**               | ✅     | Logo SVG+PNG, favicon, login lockup 90px, sidebar icon+text Poppins, theme dark/light auto     |
| **Sprint "tout en live"**           | ✅     | tracker:status WS, dashboard metrics reelles, vehicle-detail alert refresh                     |
| Users CRUD + invitations            | 💭     | Backlog — pour l'instant seed admin, manual DB insert                                          |
| Polling confirmation commande       | 💭     | Backlog — §7.3 doc protocole, worker BullMQ qui verifie ignition=0 apres T+120s               |
| Scheduling commande (T+Xmin)        | 💭     | Backlog — re-evaluer canCutEngine au moment T, pas au moment de programmation                  |
| CLI provisionnement tracker         | 💭     | Backlog — genere la sequence SMS d'init Coban (§5.7 doc) depuis un formulaire                  |
| Rapports PDF / export               | 💭     | Backlog — v1.1                                                                                 |
| Mobile app Capacitor                | ❌     | Hors scope V1, roadmap v2                                                                      |

### 3.3 Volet landing page

| Brique                    | Statut | Notes                                                                       |
| ------------------------- | ------ | --------------------------------------------------------------------------- |
| Maquette HTML standalone  | ✅     | Faite dans une session anterieure, design "Command Center" dark             |
| **Stack Next.js + Vercel**| 📋     | **Sprint "acquisition"** — porter la maquette en Next.js, deployer          |
| Contenu copywriting FR    | 🚧     | Placeholders : pricing, temoignages, numero WhatsApp, logo Tracky           |
| Simulateur de prix        | ✅     | Logique client-side OK, grille tarifaire a finaliser                        |
| Video demo produit        | 📋     | A tourner maintenant que l'UI est complete                                  |
| SEO France + Maroc        | 📋     | Meta tags, sitemap, requetes cibles identifiees                             |
| Analytics (GA/Plausible)  | 💭     | Backlog                                                                     |

### 3.4 Tests et qualite

| Mesure                          | Etat actuel                                                  |
| ------------------------------- | ------------------------------------------------------------ |
| Tests unitaires API             | ✅ 105 tests (13 engine + 8 vehicles + 10 trackers + 10 alerts + 5 positions + 8 segmenter + 14 observability + 8 ack-waiter + 17 tracker-commands + 12 autres) |
| Tests unitaires shared          | ✅ 72 tests (22 parser + 20 encoder + 30 catalog)            |
| Tests d'integration API         | 💭 Non couvert — backlog                                     |
| Tests E2E Angular               | 💭 Non couvert — backlog                                     |
| Coverage minimum                | 💭 Pas de seuil fixe — a definir                             |
| CI GitHub Actions               | 💭 Non configuree — backlog                                  |
| Scenario E2E manuel netcat      | ✅ Valide 2026-04-09                                         |
| Audit live-vs-static            | ✅ docs/audit-live-status.md — 3 gaps combles                |
| Pipeline WireLog E2E            | ✅ Valide 2026-04-13 (RESTORE OUT + status OUT dans wire_logs) |

### 3.5 Vague A — Phase 8 (Logs) + Phase 6 (Commands Console)

| Brique                            | Statut | Notes                                                              |
| --------------------------------- | ------ | ------------------------------------------------------------------ |
| **Phase 8 — Observabilité**       | ✅     | nestjs-pino, CobanWireLogger, ErrorLogger, AllExceptionsFilter, admin UI, cron cleanup |
| **Phase 6.1 — Catalog shared**    | ✅     | 20 templates, engine_stop/resume exclus, 30 tests                  |
| **Phase 6.2 — Prisma TrackerCommand** | ✅ | Nouveau enum TrackerCommandStatus + TrackerCommandChannel, migration |
| **Phase 6.3 — AckWaiter + TCP hook** | ✅  | Map in-memory, hook case 'unknown', 8 tests                       |
| **Phase 6.4 — Service + Controller** | ✅  | CRUD, dispatch, cancel, catalog, @Throttle, WS event, 17 tests    |
| **Phase 6.5 — Scheduling cron**   | ✅     | @Cron('*/30 * * * * *') poll SCHEDULED                            |
| **Phase 6.6 — Angular UI**        | ✅     | CommandsPanelComponent, AdminCommandsComponent, vehicle-detail tab |
| **Bonus — Unified history API**   | ✅     | GET /vehicles/:id/commands-history (engine + tracker merged)       |

---

## 4. Sprints a venir

### 4.1 Sprint "vendable" — ✅ COMPLETE

**Objectif :** un produit utilisable par un gestionnaire de flotte sans toucher a l'API directement.

**Etat au 2026-04-11 :** 7/7 criteres remplis (cf. §5).

### 4.2 Sprint "acquisition"

**Objectif :** avoir une presence web qui convertit des prospects en leads via WhatsApp.

| # | Tache                              | Estimation |
| - | ---------------------------------- | ---------- |
| 1 | Port maquette HTML → Next.js 15   | 3h         |
| 2 | Copywriting FR final               | 2h         |
| 3 | Grille tarifaire finalisee         | 1h         |
| 4 | Video demo 90 secondes             | 2h         |
| 5 | Deploiement Vercel + domaine       | 1h         |
| 6 | SEO basique (meta, sitemap, og)    | 1h         |

### 4.3 Sprint "premier client reel"

**Objectif :** avoir valide le produit avec du hardware reel et un utilisateur qui n'est pas toi.

| # | Tache                                         | Estimation           |
| - | --------------------------------------------- | -------------------- |
| 1 | Commande et livraison GPS403D                 | 1-2 semaines externe |
| 2 | Mise en service du boitier (SMS d'init)       | 1h                   |
| 3 | Validation E2E avec hardware reel             | 2h                   |
| 4 | Correction des divergences parser si besoin   | Variable             |
| 5 | Remplissage du tableau §9.2 doc protocole     | 1h                   |
| 6 | Onboarding UX : fleet → user → tracker < 5min | 3h                  |
| 7 | Demo commerciale prospect #1                  | 1h                   |

### 4.4 Sprint "production-grade"

**Objectif :** preparer le passage a l'echelle (10+ clients actifs).

| # | Tache                                      | Estimation |
| - | ------------------------------------------ | ---------- |
| 1 | ~~Polling confirmation commande~~ → AckWaiterService livré Phase 6 | ✅ fait |
| 2 | CI GitHub Actions (test + build + deploy)  | 2h         |
| 3 | ~~Monitoring Pino~~ → nestjs-pino livré Phase 8 (Loki en prod restant) | ✅ fait |
| 4 | Backup automatise Postgres                 | 1h         |
| 5 | Reverse proxy Traefik + Let's Encrypt      | 2h         |
| 6 | Migration vers un VPS dedie               | 2h         |
| 7 | Rate limiting sur endpoints sensibles      | 1h         |
| 8 | Rotation JWT secrets                       | 1h         |

---

## 5. Criteres de "vendable"

Un prospect doit pouvoir, lors d'une demo de 15 minutes :

1. ✅ Voir ses vehicules bouger en temps reel sur une carte
2. ✅ Cliquer sur un vehicule pour voir sa fiche detail
3. ✅ Declencher une coupure moteur avec double confirmation
4. ✅ Voir l'historique d'audit de la commande
5. ✅ Recevoir une alerte SOS simulee et l'acquitter
6. ✅ Creer un nouveau vehicule et l'associer a un tracker
7. Comprendre le prix en < 30 secondes (landing page requise)

**Etat au 2026-04-11 :** 6/7 faisable via UI. Le 7e requiert la landing page.

---

## 6. Decisions d'architecture importantes

### 6.1 Stack et conventions

- **Monorepo Turborepo + pnpm workspaces**
- **NestJS 11 + Prisma 6.19.3 adapter-pg**
- **Angular 20 standalone + signals** (pas de NgModule, `@if`/`@for`)
- **Tailwind 4** (config CSS pas JS, `.postcssrc.json`)
- **Auth : bcrypt + jsonwebtoken direct** (pas Passport)
- **Validation : class-validator pour DTO + Zod 4 pour env uniquement**
- **@nestjs/event-emitter** pour events internes (tracker.assigned/unassigned)
- **@nestjs/schedule** pour cron (trip timeout check 60s)

### 6.2 Securite coupure moteur (non-negociable)

- Garde-fou cote serveur obligatoire, double du hardware Coban
- Seuil vitesse : `> 20 km/h` refuse (condition stricte, pas `>=`)
- Seuil position stale : `> 60 secondes` refuse
- Check `valid: true` obligatoire (pas de coupure sur fix GPS invalide)
- Commandes REJECTED persistees **avant** le throw pour audit trail
- RESTORE jamais soumis au garde-fou
- `SUPER_ADMIN` bypass la verification multi-tenant, pas le garde-fou

### 6.3 Multi-tenancy

- Row-level isolation via `fleetId` sur toutes les entites metier
- `SUPER_ADMIN` voit toutes les flottes
- Tous les services prennent `requestedBy: { userId, role, fleetId }`

### 6.4 WebSocket

- Namespace unique `/realtime`
- JWT valide a la connexion
- Rooms par `fleet:${fleetId}`, SUPER_ADMIN dans `fleet:*`
- 9 events types : position:update, tracker:status, alert:new, alert:acknowledged, geofence:violation, trip:started, trip:completed
- Signals immutables cote Angular (nouvelle Map a chaque update)

### 6.5 Protocole Coban

- Parser et encoder dans `@vizyo/shared`, code 100% pur sans I/O
- Parser ne throw JAMAIS, encoder throw autorise
- Commandes mono-lettre (`J`, `K`, `L`, `M`, etc.)
- Port TCP : 5023 en dev, 5001 en prod cible

### 6.6 Persistance positions

- Source unique : `PositionsService.ingest(CobanPositionFrame)`
- Positions avec `valid: false` ne sont PAS persistees
- Broadcast WS uniquement si `tracker.vehicle` existe
- Geofence check + trip processing apres chaque ingest

### 6.7 Mock emitter dev

- Double garde : `MOCK_POSITIONS=true` ET `NODE_ENV !== 'production'`
- FakeTcpSocket pour engine control E2E sans hardware
- Event-driven : `tracker.assigned` → fake socket instantane
- Alarmes aleatoires (2% warning, 0.3% critical)

### 6.8 Geofences

- V1 = cercles uniquement (haversine in-memory, pas PostGIS pour les checks)
- Cache par fleetId, invalide au create/update/delete
- First-seen logic : pas de faux ENTER au boot
- Geometry PostGIS mise a jour en non-bloquant (pour futures requetes spatiales)

### 6.9 Trips

- Segmentation hybride : ignition OFF → end | speed>5 30s → start | speed=0 5min → end
- Filtre bruit : distance < 50m → trip rejete
- Etat in-memory `Map<trackerId, OpenTripState>`, boot recovery depuis DB
- Cron @nestjs/schedule toutes les 60s pour timeout trips ouverts (tracker offline)
- Recompute refuse la fenetre < 10 minutes du present

---

## 7. Points a valider avec un vrai GPS403D

(inchange)

---

## 8. Risques et zones d'ombre

(inchange)

---

## 9. Glossaire

(inchange)

---

## 10. Journal des sessions

| Date       | Sprint                          | Livrables                                                                                                                                                                        |
| ---------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-09 | Bootstrap monorepo              | Turborepo + pnpm, Docker Compose, schema Prisma, AuthModule JWT, TcpServerService stub, Angular 20 + Tailwind 4 + design system, login + dashboard                               |
| 2026-04-09 | EngineControl + CRUD + Realtime | EngineControlModule 12 tests, VehiclesModule 8 tests, TrackersModule 10 tests, MockPositionEmitter, RealtimeGateway JWT + rooms, carte Leaflet markers SVG                       |
| 2026-04-09 | Parser Coban + Integration TCP  | Parser/encoder 42 tests, TcpServerService reel, PositionsService centralise, dispatch commande reel, FakeTcpSocket, seuil stale 60s + valid GPS                                  |
| 2026-04-09 | UI Engine Control + Alerts      | EngineControlButtonComponent, ToastService, ConfirmModal, AlertsModule 10 tests, widget bell, page /alerts, sync bidirectionnelle WS, AuthInterceptor, reconnexion WS au refresh  |
| 2026-04-10 | Vehicle detail + Positions API  | VehicleDetailComponent (5 onglets), MiniMapComponent, GET /positions API avec cursor+filtres temporels, cross-linking dashboard/alerts/map → fiche vehicule, 46 tests API         |
| 2026-04-10 | Sprint "tout en live"           | tracker:status WS actif, dashboard metrics reelles (GET /vehicles/stats), vehicle-detail alert refresh, audit docs/audit-live-status.md                                          |
| 2026-04-10 | Vehicles list + Add modal       | VehiclesListComponent, AddVehicleDialogComponent stepper 2 etapes, TrackersApiService, sidebar "Vehicules"                                                                       |
| 2026-04-10 | MockEmitter dynamique           | @nestjs/event-emitter, tracker.assigned/unassigned events, fake socket instantane, refresh 30s filet de securite                                                                 |
| 2026-04-10 | Identite visuelle               | LogoComponent (icon/lockup, dark/light/auto), favicon, meta, login lockup 90px, sidebar icon+text Poppins                                                                        |
| 2026-04-10 | Geofences V1                    | GeofencesModule CRUD, detection ENTER/EXIT haversine in-memory, AlertType GEOFENCE_ENTER, dessin Leaflet click-to-place + slider rayon, overlay cercles carte                    |
| 2026-04-11 | Trips V1                        | TripSegmenterService 8 tests, TripsService CRUD + processPosition live + cron timeout + recompute admin, ReportsComponent KPI+trips+replay anime, vehicle-detail onglet Trajets   |

---

## 11. References

- `docs/03-protocol-coban-gps403d.md` — spec protocole Coban GPS403D
- `docs/05-hardware-bench.md` — roadmap bench hardware 403C
- `docs/06-tcp-commands-console.md` — roadmap console de commandes TCP
- `docs/07-sms-gateway.md` — roadmap gateway SMS Twilio
- `docs/08-logging-and-observability.md` — roadmap logs et observabilite
- `docs/observability-guide.md` — guide d'utilisation des logs
- `docs/EXECUTION-TRACKER.md` — suivi d'execution des phases
- `packages/shared/src/protocol/` — implementation parser/encoder/catalog Coban
- `apps/api/src/engine-control/` — module de coupure moteur avec garde-fou
- `apps/api/src/tracker-commands/` — module console de commandes TCP
- `apps/api/src/observability/` — module logs et observabilite
- Repos internes Vizyo Manager et Vizyo Leads — source des conventions stack

---

## 12. Journal des modifications de ce document

| Version | Date       | Auteur  | Notes                                                                                             |
| ------- | ---------- | ------- | ------------------------------------------------------------------------------------------------- |
| V1      | 2026-04-09 | Youness | Creation initiale apres validation E2E complete de l'etape 5b                                     |
| V1.1    | 2026-04-11 | Claude  | Mise a jour complete : 15 sprints documentes, 54 tests API + 42 shared, 6/7 criteres vendable, ajout Alerts/Geofences/Trips/UI |
| V1.2    | 2026-04-13 | Claude  | Vague A complete : Phase 8 (observabilite) + Phase 6 (commands console), 105 tests API + 72 shared, pipeline WireLog valide E2E |
