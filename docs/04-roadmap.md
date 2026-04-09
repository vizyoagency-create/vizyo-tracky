# 04 — Roadmap Vizyo Tracky

> **Statut :** V1 — 2026-04-09
> **Périmètre :** plan de route produit et technique pour les deux volets (application + landing page), avec suivi d'avancement, backlog priorisé et décisions d'architecture.
> **Mise à jour :** ce document est mis à jour à la fin de chaque session de développement. Le journal en §10 trace les changements.

---

## 1. Vision produit

Vizyo Tracky est un produit interne Vizyo Agency qui remplace l'application Baanool par défaut des traceurs GPS Coban GPS403D par une plateforme web moderne, centrée sur la sécurité et l'expérience utilisateur du gestionnaire de flotte.

**Utilisateur cible :** PME de transport, loueurs de véhicules, sociétés avec flotte utilitaire (10-200 véhicules).

**Différenciateurs :**

- **Sécurité applicative de la coupure moteur** : garde-fou double (hardware Coban + logiciel serveur) avec audit trail obligatoire, validation GPS fix, seuil de vitesse strict, et double confirmation UI.
- **Temps réel visible** : carte live avec markers qui bougent, WebSocket multi-tenant sécurisé, pas de polling client.
- **UI moderne** : Angular 20 + Tailwind 4, design system "Command Center" mint/green, pas d'interface chinoise traduite à l'arrache.
- **Multi-flottes** : un admin Vizyo peut gérer plusieurs clients, chaque client ne voit que sa flotte.

**Modèle économique :** abonnement mensuel par véhicule (tarification à finaliser). Canaux d'acquisition : WhatsApp et email, pas de self-service.

---

## 2. Architecture globale

### 2.1 Volet 1 — Application

```
┌──────────────────────────────────────────────────────────────┐
│                     apps/api (NestJS 11)                     │
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐   │
│  │ AuthModule   │   │ VehiclesMod  │   │ TrackersModule  │   │
│  │ JWT+bcrypt   │   │ CRUD         │   │ CRUD + assign   │   │
│  └──────────────┘   └──────────────┘   └─────────────────┘   │
│                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐   │
│  │ TrackerTcp   │   │ Positions    │   │ EngineControl   │   │
│  │ :5023 Coban  │──▶│ ingest+broad │   │ guard+dispatch  │   │
│  └──────────────┘   └──────────────┘   └─────────────────┘   │
│         ▲                   │                    │          │
│         │                   ▼                    ▼          │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────┐   │
│  │ SocketReg    │   │ Realtime     │   │ PrismaModule    │   │
│  │ @Global      │   │ /realtime WS │   │ adapter-pg      │   │
│  └──────────────┘   └──────────────┘   └─────────────────┘   │
└──────────────────────────────────────────────────────────────┘
         ▲                     ▲                    ▲
         │ TCP frames          │ WS events          │ SQL
         │                     │                    ▼
┌──────────────────┐   ┌──────────────┐   ┌──────────────────┐
│ Coban GPS403D    │   │ apps/web     │   │ Postgres+PostGIS │
│ (tracker HW)     │   │ Angular 20   │   │ port 5433        │
└──────────────────┘   └──────────────┘   └──────────────────┘
```

### 2.2 Volet 2 — Landing page

Next.js + Tailwind statique sur Vercel, pas de backend. Conversion via WhatsApp + email.

### 2.3 Packages partagés

- `@vizyo/shared` — types DTO, events WebSocket, protocole Coban (parser + encoder purs)

---

## 3. État d'avancement

### 3.1 Légende

- ✅ **Fait** : implémenté, testé, validé
- 🚧 **En cours** : partiellement fait ou en itération
- 📋 **Planifié** : prévu dans un sprint identifié
- 💭 **Backlog** : identifié, non planifié
- ❌ **Hors scope V1**

### 3.2 Volet application

| Brique                              | Statut | Notes                                                                                          |
| ----------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| Monorepo Turborepo + pnpm           | ✅     | Stack alignée Vizyo Manager/Leads                                                              |
| Docker Compose (Postgres + Redis)   | ✅     | Ports 5433 / 6379                                                                              |
| Prisma + migrations                 | ✅     | 9 modèles, colonnes PostGIS ajoutées en raw SQL                                                |
| Auth JWT + bcrypt + jsonwebtoken    | ✅     | Pas de Passport, alignement Manager/Leads                                                      |
| RolesGuard réutilisable             | ✅     | Dans `auth/guards/`, importable depuis tout module                                             |
| SocketRegistryModule                | ✅     | `@Global()`, Map IMEI→Socket en mémoire                                                        |
| CRUD Fleets                         | ✅     | Via seed admin, pas d'UI dédiée pour l'instant                                                 |
| CRUD Vehicles                       | ✅     | 8 tests, multi-tenant strict, `plate` unique par fleet                                         |
| CRUD Trackers + assignation         | ✅     | 10 tests, IMEI unique global, assign/unassign en transaction                                   |
| EngineControlModule                 | ✅     | 13 tests, garde-fou 60s stale + valid GPS + vitesse 20 km/h, audit REJECTED persisté           |
| Dispatch commande réel              | ✅     | `socket.write(encodeCommand(...))` via SocketRegistry, SENT/FAILED/REJECTED                    |
| Parser Coban GPS403D                | ✅     | `packages/shared/src/protocol/`, 22 tests parser                                               |
| Encoder Coban GPS403D               | ✅     | 9 commandes Traccar + custom + sos_ack, 20 tests                                               |
| TcpServerService                    | ✅     | Dispatch login/heartbeat/position/unknown, ACK SOS, reject unknown IMEI                        |
| PositionsService                    | ✅     | Persistance PostGIS + broadcast WS, utilisé par TCP et Mock                                    |
| MockPositionEmitterService          | ✅     | Dev only, double garde env, passe par PositionsService                                         |
| RealtimeGateway (Socket.IO)         | ✅     | JWT auth à la connexion, rooms par fleetId, SUPER_ADMIN `fleet:*`                              |
| Angular 20 standalone + signals     | ✅     | Tailwind 4, design system Tracky mint/green                                                    |
| Auth UI (login)                     | ✅     | Connexion WS automatique après login                                                           |
| Dashboard (suivi temps réel liste)  | ✅     | Signals, thème dark/light, ThemeToggle                                                         |
| Carte Leaflet temps réel            | ✅     | Markers SVG par vitesse, trails pointillés, overlay glassmorphism, légende                     |
| **UI Engine Control**               | 📋     | **Sprint "vendable" #1** — bouton avec double confirmation, statut temps réel                  |
| **Module Alerts**                   | 📋     | **Sprint "vendable" #2** — persistance alarmes Coban + widget dashboard                        |
| **Page Véhicule détail**            | 📋     | **Sprint "vendable" #3** — fiche par véhicule avec mini-map + historique + CUT                 |
| CRUD Geofences                      | 💭     | Backlog — rectangle d'abord (support Coban natif), polygone en v1.1                            |
| Détection de trajets                | 💭     | Backlog — segmentation automatique start/stop par IGN ou vitesse=0 >5min                       |
| Historique positions (replay)       | 💭     | Backlog — timeline scroll + lecture accélérée                                                  |
| Users CRUD + invitations            | 💭     | Backlog — pour l'instant seed admin, manual DB insert                                          |
| Polling confirmation commande       | 💭     | Backlog — §7.3 doc protocole, worker BullMQ qui vérifie ignition=0 après T+120s                |
| Scheduling commande (T+Xmin)        | 💭     | Backlog — ré-évaluer canCutEngine au moment T, pas au moment de programmation                  |
| CLI provisionnement tracker         | 💭     | Backlog — génère la séquence SMS d'init Coban (§5.7 doc) depuis un formulaire                  |
| Rapports PDF / export               | 💭     | Backlog — v1.1                                                                                 |
| Mobile app Capacitor                | ❌     | Hors scope V1, roadmap v2                                                                      |

### 3.3 Volet landing page

| Brique                    | Statut | Notes                                                                       |
| ------------------------- | ------ | --------------------------------------------------------------------------- |
| Maquette HTML standalone  | ✅     | Faite dans une session antérieure, design "Command Center" dark             |
| **Stack Next.js + Vercel**| 📋     | **Sprint "acquisition"** — porter la maquette en Next.js, déployer          |
| Contenu copywriting FR    | 🚧     | Placeholders : pricing, témoignages, numéro WhatsApp, logo Tracky           |
| Simulateur de prix        | ✅     | Logique client-side OK, grille tarifaire à finaliser                        |
| Vidéo démo produit        | 📋     | À tourner quand l'UI Engine Control sera finie                              |
| SEO France + Maroc        | 📋     | Meta tags, sitemap, requêtes cibles identifiées                             |
| Analytics (GA/Plausible)  | 💭     | Backlog                                                                     |

### 3.4 Tests et qualité

| Mesure                          | État actuel                                               |
| ------------------------------- | --------------------------------------------------------- |
| Tests unitaires API             | ✅ 31 tests (13 engine-control + 8 vehicles + 10 trackers) |
| Tests unitaires shared          | ✅ 42 tests (22 parser + 20 encoder)                      |
| Tests d'intégration API         | 💭 Non couvert — backlog                                  |
| Tests E2E Angular               | 💭 Non couvert — backlog                                  |
| Coverage minimum                | 💭 Pas de seuil fixé — à définir                          |
| CI GitHub Actions               | 💭 Non configurée — backlog                               |
| Scénario E2E manuel netcat      | ✅ Validé 2026-04-09                                      |

---

## 4. Sprints à venir

### 4.1 Sprint "vendable" — priorité absolue

**Objectif :** un produit utilisable par un gestionnaire de flotte sans toucher à l'API directement. Critère de sortie : démo commerciale possible devant un prospect non-technique.

| # | Tâche                           | Estimation | Dépendances                           |
| - | ------------------------------- | ---------- | ------------------------------------- |
| 1 | UI Engine Control               | 2-3h       | RealtimeService, carte, signals       |
| 2 | Module Alerts (API + UI)        | 3h         | TcpServerService, RealtimeGateway     |
| 3 | Page Véhicule détail            | 2h         | VehiclesService, PositionsService     |
| 4 | Badge audit trail commandes     | 1h         | EngineControlService.listCommands()   |

**Détails #1 — UI Engine Control**

- Composant `<app-engine-control-button>` réutilisable
- Modal de double confirmation obligatoire : "Je confirme vouloir immobiliser le véhicule [PLAQUE]. Le conducteur sera impacté." + champ `reason` optionnel
- Bouton désactivé si `speedKmh > 20` ou `valid === false` côté client (UX, mais le serveur reste la source de vérité)
- Toast de succès ou d'erreur avec le `lastError` du serveur si REJECTED
- Historique des 5 dernières commandes pour ce véhicule (pills vertes SENT / rouges REJECTED)
- Rôle minimum requis : `FLEET_ADMIN`

**Détails #2 — Module Alerts**

- Modèle Prisma `Alert` (id, fleetId, vehicleId, trackerId, type, severity, payload JSON, createdAt, acknowledgedAt?, acknowledgedBy?)
- Enum `AlertType` : `SOS`, `POWER_CUT`, `ACCIDENT`, `COLLISION`, `LOW_BATTERY`, `OVERSPEED`, `GEOFENCE_EXIT`, `MOVEMENT_IDLE`
- Enum `AlertSeverity` : `INFO`, `WARNING`, `CRITICAL`
- `TcpServerService` : quand `frame.alarm` est une valeur critique, créer une Alert via `AlertsService` au lieu de juste logger
- `RealtimeGateway` : broadcaster un nouvel event `alert:new` sur la fleet room
- UI : widget bell dans le header avec badge de compteur non-acquittées + dropdown des 10 dernières
- Route `/alerts` : liste paginée, filtres par type/severity/acquitté
- Tests unitaires : 6+ (création depuis TcpServer, listing multi-tenant, acquittement, broadcast)

**Détails #3 — Page Véhicule détail**

- Route `/vehicles/:id` déjà existante (placeholder), à remplacer
- Layout : header avec plaque + marque + modèle, tabs "Carte" / "Historique" / "Alertes" / "Commandes"
- Onglet Carte : mini-Leaflet centré sur la dernière position connue, marker unique, pas de trail
- Onglet Historique : timeline des 50 dernières positions (tableau simple, pas de replay pour l'instant)
- Onglet Alertes : liste filtrée sur ce vehicleId
- Onglet Commandes : historique complet des EngineControlCommand pour ce vehicleId
- Sidebar droite : actions rapides incluant le bouton Engine Control (#1)

### 4.2 Sprint "acquisition"

**Objectif :** avoir une présence web qui convertit des prospects en leads via WhatsApp.

| # | Tâche                              | Estimation |
| - | ---------------------------------- | ---------- |
| 1 | Port maquette HTML → Next.js 15    | 3h         |
| 2 | Copywriting FR final               | 2h         |
| 3 | Grille tarifaire finalisée         | 1h         |
| 4 | Vidéo démo 90 secondes             | 2h         |
| 5 | Déploiement Vercel + domaine       | 1h         |
| 6 | SEO basique (meta, sitemap, og)    | 1h         |

**Critère de sortie :** un lien partageable sur WhatsApp/LinkedIn qui présente le produit et redirige vers une conversation WhatsApp préformatée.

### 4.3 Sprint "premier client réel"

**Objectif :** avoir validé le produit avec du hardware réel et un utilisateur qui n'est pas toi.

| # | Tâche                                         | Estimation           |
| - | --------------------------------------------- | -------------------- |
| 1 | Commande et livraison GPS403D                 | 1-2 semaines externe |
| 2 | Mise en service du boîtier (SMS d'init)       | 1h                   |
| 3 | Validation E2E avec hardware réel             | 2h                   |
| 4 | Correction des divergences parser si besoin   | Variable             |
| 5 | Remplissage du tableau §9.2 doc protocole     | 1h                   |
| 6 | Onboarding UX : fleet → user → tracker < 5min | 3h                   |
| 7 | Démo commerciale prospect #1                  | 1h                   |

### 4.4 Sprint "production-grade"

**Objectif :** préparer le passage à l'échelle (10+ clients actifs).

| # | Tâche                                      | Estimation |
| - | ------------------------------------------ | ---------- |
| 1 | Polling confirmation commande (§7.3 doc)   | 3h         |
| 2 | CI GitHub Actions (test + build + deploy)  | 2h         |
| 3 | Monitoring (Pino → Loki ou équivalent)     | 3h         |
| 4 | Backup automatisé Postgres                 | 1h         |
| 5 | Reverse proxy Traefik + Let's Encrypt      | 2h         |
| 6 | Migration vers un VPS dédié                | 2h         |
| 7 | Rate limiting sur endpoints sensibles      | 1h         |
| 8 | Rotation JWT secrets                       | 1h         |

---

## 5. Critères de "vendable"

Un prospect doit pouvoir, lors d'une démo de 15 minutes :

1. Voir ses véhicules bouger en temps réel sur une carte
2. Cliquer sur un véhicule pour voir sa fiche détail
3. Déclencher une coupure moteur avec double confirmation
4. Voir l'historique d'audit de la commande
5. Recevoir une alerte SOS simulée et l'acquitter
6. Créer un nouveau véhicule et l'associer à un tracker
7. Comprendre le prix en < 30 secondes

**État au 2026-04-09 :** 0/7 faisable via UI. 5/7 faisable via API (1, 3, 4, 6 via curl, 5 visible en logs).

**Cible post-sprint vendable :** 7/7 via UI.

---

## 6. Décisions d'architecture importantes

Référence : ces décisions sont verrouillées et doivent être reprises à l'identique pour toute nouvelle feature, sauf si explicitement remise en cause dans une session.

### 6.1 Stack et conventions

- **Monorepo Turborepo + pnpm workspaces** (divergence assumée vs Manager/Leads qui sont des repos standalone — justifié par le partage des types protocole)
- **NestJS 11 + Prisma 6.19.3 adapter-pg** (alignement Manager/Leads, pas Prisma 7 preview)
- **Angular 20 standalone + signals** (pas de NgModule, `@if`/`@for`)
- **Tailwind 4** (config CSS pas JS, `@tailwindcss/postcss`)
- **Auth : bcrypt + jsonwebtoken direct** (pas Passport, pas `@nestjs/jwt`)
- **Validation : class-validator pour DTO + Zod 4 pour env uniquement**

### 6.2 Sécurité coupure moteur (non-négociable)

- Garde-fou côté serveur obligatoire, double du hardware Coban
- Seuil vitesse : `> 20 km/h` refusé (condition stricte, pas `>=`)
- Seuil position stale : `> 60 secondes` refusé
- Check `valid: true` obligatoire (pas de coupure sur fix GPS invalide)
- Commandes REJECTED persistées **avant** le throw pour audit trail
- RESTORE jamais soumis au garde-fou
- `SUPER_ADMIN` bypass la vérification multi-tenant, pas le garde-fou

### 6.3 Multi-tenancy

- Row-level isolation via `fleetId` sur toutes les entités métier
- Pas de schéma par client (choix assumé pour la simplicité opérationnelle)
- `SUPER_ADMIN` voit toutes les flottes, les autres rôles voient uniquement la leur
- Tous les services prennent un paramètre `requestedBy: { userId, role, fleetId }`

### 6.4 WebSocket

- Namespace unique `/realtime`
- JWT validé à la connexion, socket disconnecté si invalide
- Rooms par `fleet:${fleetId}`, SUPER_ADMIN dans `fleet:*`
- Events typés dans `@vizyo/shared`, jamais de strings en dur
- Signals immutables côté Angular (nouvelle Map à chaque update)

### 6.5 Protocole Coban

- Parser et encoder dans `@vizyo/shared`, code 100% pur sans I/O
- Parser ne throw JAMAIS, toute erreur → `CobanUnknownFrame`
- Encoder throw autorisé (erreurs de programmation)
- Commandes mono-lettre (`J`, `K`, `L`, `M`, etc.) — version firmware `out`
- Port TCP : `.env` (`COBAN_TCP_PORT`), actuellement 5023 en dev, 5001 en prod cible
- SocketRegistry en mémoire (Map), pas de persistance Redis (OK pour V1, à revoir pour multi-instances)

### 6.6 Persistance positions

- Source unique : `PositionsService.ingest(CobanPositionFrame)`
- Positions avec `valid: false` ne sont PAS persistées
- Colonnes PostGIS (`location`, `geometry`) remplies via raw SQL après l'insert Prisma
- Broadcast WebSocket uniquement si `tracker.vehicle` existe

### 6.7 Mock emitter dev

- Double garde : `MOCK_POSITIONS=true` ET `NODE_ENV !== 'production'`
- Passe par `PositionsService.ingest` comme le vrai TCP (source unique)
- **Limite connue :** écrase les positions des trackers ciblés plus vite qu'un test netcat peut en envoyer. Pour tester netcat, utiliser un tracker dédié non-mocké.

---

## 7. Points à valider avec un vrai GPS403D

À remplir quand le hardware sera disponible et installé en test.

- [ ] Login packet réel matche `##,imei:<IMEI>,A`
- [ ] Trames de position en déplacement (format principal ou alternatif ?)
- [ ] Heartbeat toutes les 60s confirmé
- [ ] Firmware accepte bien les codes mono-lettre (`J`, `K`) — sinon bascule SMS `protocol123456 18 out`
- [ ] Mode `protocol 18` activé → champs `ignition`, `door`, `fuel1`, `fuel2` présents
- [ ] Alarme SOS (bouton 3s) → trame `help me` reçue + ACK `E;` arrête la répétition
- [ ] Alarme `ac alarm` en débranchant l'alimentation
- [ ] Commande CUT à vitesse 0 → coupure effective + `ignition=0` confirmé dans position suivante
- [ ] Commande CUT à vitesse > 20 km/h côté serveur → rejetée avant envoi hardware
- [ ] Commande RESTORE → moteur redémarre
- [ ] Reconnexion auto après coupure GPRS simulée (30s avion)
- [ ] Latence commande → exécution < 5s P95
- [ ] Captures Wireshark ajoutées à `docs/03-protocol-coban-gps403d.md` §9.2

---

## 8. Risques et zones d'ombre

### 8.1 Techniques

| Risque                                                   | Probabilité | Impact | Mitigation                                                  |
| -------------------------------------------------------- | ----------- | ------ | ----------------------------------------------------------- |
| Firmware Coban divergent sur un vrai boîtier             | Moyenne     | Fort   | Tests fixtures actuels + adaptation si besoin, doc §9.2     |
| Parser plante sur une trame corrompue inattendue         | Faible      | Fort   | Règle no-throw + log → Unknown, déjà implémenté             |
| Socket TCP fuit si mauvais cleanup                       | Moyenne     | Moyen  | `socket.on('close')` + `sessions.detach()` déjà en place    |
| Scale horizontal API cassé par SocketRegistry in-memory  | Certaine    | Moyen  | V1 single-instance OK, v1.1 : Redis pubsub ou sticky sessions |
| Garde-fou 60s trop strict → CUT impossibles en ville      | Moyenne     | Moyen  | Monitorer en prod, ajuster si retour terrain                |
| PostGIS inserts via raw SQL fragile                      | Faible      | Faible | Tests E2E manuels, à couvrir en tests d'intégration         |

### 8.2 Produit

| Risque                                                   | Mitigation                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| Aucun client n'accepte la double confirmation (friction) | UX à affiner avec le premier client réel                      |
| Concurrents moins chers (TK103, GPSWOX) déjà installés    | Différencier sur le support local + UI + conformité RGPD      |
| Latence réseau Maroc/France pour WebSocket temps réel    | Hébergement multi-région à envisager si première cible Maroc  |

### 8.3 Légal et conformité

- **RGPD** : les positions GPS sont des données personnelles (conducteur identifiable). Il faudra un DPA signé avec chaque client, une politique de rétention documentée, et un droit à l'effacement fonctionnel (pas juste soft delete).
- **Coupure moteur** : responsabilité légale en cas d'accident déclenché par une commande Vizyo. Documenter dans les CGV que Tracky est un outil d'assistance, que la décision reste du manager, et que Vizyo n'est pas responsable si le manager coupe le moteur d'un conducteur qu'il n'aurait pas dû couper. **À faire valider par un avocat avant premier client payant.**

---

## 9. Glossaire

- **Coban / Baanool** : nom du fabricant OEM chinois des traceurs GPS103/403D
- **IMEI** : identifiant unique 15 chiffres d'un traceur (comme un mobile)
- **Protocole gps103** : nom du protocole texte ASCII utilisé par la famille Coban
- **Fleet** : flotte de véhicules d'un client Tracky
- **Tracker** : entité logique représentant un boîtier Coban, identifié par IMEI
- **Vehicle** : entité logique représentant un véhicule, lié à 0 ou 1 tracker
- **Position** : point GPS horodaté avec vitesse, cap, validité
- **Command** : ordre envoyé du serveur vers le tracker (CUT/RESTORE/etc.)
- **Alert** : événement généré à partir d'une alarme Coban reçue, visible par le manager
- **Geofence** : zone géographique (rectangle ou polygone) surveillée pour entrée/sortie
- **Trip** : segment de déplacement entre deux arrêts prolongés

---

## 10. Journal des sessions

| Date       | Sprint                   | Livrables                                                                                                                                                                        |
| ---------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-09 | Bootstrap monorepo       | Turborepo + pnpm, Docker Compose, schema Prisma 9 modèles, AuthModule JWT, TcpServerService stub, RealtimeGateway vide, Angular 20 + Tailwind 4 + design system, login + dashboard placeholder, validation 5/5 |
| 2026-04-09 | Étape 1 — EngineControl  | EngineControlModule avec 12 tests, garde-fou stale 120s (ajusté 60s plus tard) + vitesse 20 km/h, RolesGuard réutilisable dans `auth/`, REJECTED persisté avant throw                |
| 2026-04-09 | Étape 2 — CRUD métier    | VehiclesModule (8 tests), TrackersModule (10 tests), assignation IMEI↔véhicule en transaction, 30 tests cumulés, scénario E2E curl complet validé                                |
| 2026-04-09 | Étape 3 — Temps réel     | MockPositionEmitter dev-only, RealtimeGateway avec JWT + fleet rooms, events typés dans `@vizyo/shared`, RealtimeService Angular avec signals, dashboard liste live                 |
| 2026-04-09 | Étape 4 — Carte Leaflet  | MapComponent plein écran, markers SVG par vitesse, trails pointillés, overlay glassmorphism, heading arrow, auto fitBounds première frame, cleanup HMR, build prod OK               |
| 2026-04-09 | Étape 5a — Parser Coban  | `@vizyo/shared/protocol` : types, utils, parser no-throw, encoder, 42 tests, fixtures depuis §9.1 doc protocole                                                                     |
| 2026-04-09 | Étape 5b — Intégration   | SocketRegistry `@Global()`, PositionsService centralisé, MockEmitter refactoré, TcpServerService avec vrai parser, EngineControl dispatch réel via encodeCommand + socket.write, schema `Position.valid`, seuil stale 60s + test valid GPS, stub supprimé, 31 tests API + 42 shared |
| 2026-04-09 | Validation E2E           | Scénario netcat complet : login TCP → LOAD, heartbeat → ON, position parsée persistée broadcastée, CUT → `**,imei:...,J;` reçu, RESTORE → `K;` reçu, garde-fou vitesse 55 km/h refuse le CUT avec 403 |

---

## 11. Références

- `docs/03-protocol-coban-gps403d.md` — spec protocole Coban GPS403D (source de vérité pour le parser/encoder)
- `packages/shared/src/protocol/` — implémentation parser/encoder Coban
- `apps/api/src/engine-control/` — module de coupure moteur avec garde-fou
- Repos internes Vizyo Manager et Vizyo Leads — source des conventions stack
- Traccar `Gps103ProtocolEncoder.java` — référence pour le format des commandes
- Flespi `coban` protocol docs — référence pour les alarmes complètes

---

## 12. Journal des modifications de ce document

| Version | Date       | Auteur  | Notes                                                                                             |
| ------- | ---------- | ------- | ------------------------------------------------------------------------------------------------- |
| V1      | 2026-04-09 | Youness | Création initiale après validation E2E complète de l'étape 5b. État au milestone "techniquement fonctionnel". |
