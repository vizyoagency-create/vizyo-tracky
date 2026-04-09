# Vizyo Tracky

Plateforme interne de gestion de flottes GPS. Monorepo Angular + NestJS + PostgreSQL/PostGIS.

## Stack

- **API** : NestJS 11, Prisma 7 (`@prisma/adapter-pg`), PostgreSQL 16 + PostGIS, Redis, BullMQ, Socket.IO
- **Web** : Angular 20 (standalone + signals), Tailwind 4, Leaflet
- **Shared** : types DTO + WS events partagés entre API et Web
- **Infra** : Docker Compose (Postgres + Redis), Turborepo + pnpm workspaces

## Prérequis

- Node >= 20.18
- pnpm >= 9
- Docker Desktop

## Démarrage

```bash
# 1. Installer les dépendances
pnpm install

# 2. Démarrer Postgres + Redis
pnpm docker:up

# 3. Générer le client Prisma + première migration
cd apps/api
pnpm prisma:generate
pnpm prisma migrate dev --name init
# ⚠️ Édite ensuite le fichier migration.sql généré pour ajouter les colonnes PostGIS :
#    ALTER TABLE "positions" ADD COLUMN "location" geography(Point, 4326);
#    CREATE INDEX "positions_location_gix" ON "positions" USING GIST ("location");
#    ALTER TABLE "geofences" ADD COLUMN "geometry" geography(Geometry, 4326) NOT NULL DEFAULT ST_GeogFromText('POINT(0 0)');
#    CREATE INDEX "geofences_geometry_gix" ON "geofences" USING GIST ("geometry");
# Puis relance : pnpm prisma migrate dev
cd ../..

# 4. Lancer tout (api + web en parallèle via Turbo)
pnpm dev
```

## Ports

| Service | Port |
|---------|------|
| API REST | http://localhost:3000/api |
| WebSocket | ws://localhost:3000/realtime |
| TCP Coban trackers | :5023 |
| Angular | http://localhost:4200 |
| Postgres | :5432 |
| Redis | :6379 |

## Structure

```
vizyo-tracky/
├── apps/
│   ├── api/        # NestJS + Prisma + TCP server Coban
│   └── web/        # Angular 20 standalone + Tailwind 4
├── packages/
│   └── shared/     # DTO + WS events partagés (source TS consommée directement)
├── docker/         # init scripts Postgres
├── docker-compose.yml
└── turbo.json
```

## Règles métier critiques

- **Coupure moteur** : la dernière position connue doit indiquer une vitesse < 20 km/h avant d'envoyer la commande au tracker. Non-négociable (sécurité routière).
- **Multi-tenancy** : row-level isolation via `fleetId` sur toutes les entités métier.
- **Socket trackers** : le serveur NE PEUT PAS initier la connexion. Il maintient un `SocketRegistryService` en mémoire des sockets entrants indexés par IMEI.
