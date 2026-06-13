# Sprint 0.2 — Diagnostic CPU VPS

> Date : 2026-06-13 ~16h UTC
> VPS : Hostinger KVM, 2 vCPU (AMD EPYC 9354P), 8 GB RAM, Ubuntu 24.04
> Uptime : 179 jours
> Load average au moment du diagnostic : **8.17, 6.82, 8.29** (4x la capacite)

---

## 1. Etat general

| Metrique          | Valeur      | Verdict                 |
|-------------------|-------------|-------------------------|
| CPU               | 100 % (plateau depuis ~8 juin) | **CRITIQUE** |
| Memoire           | 33 %        | OK                      |
| Disque            | 45 / 100 GB | OK                      |
| Bande passante    | Negligeable | OK                      |
| Conteneurs actifs | **34**      | **EXCESSIF pour 2 vCPU**|

---

## 2. Repartition CPU par conteneur (2 snapshots)

### Snapshot 1 (16:00 UTC)

| Conteneur              | CPU %   | Role                    |
|------------------------|---------|-------------------------|
| **tracky-api**         | **85 %**| App Tracky (NestJS)     |
| **tracky-postgres**    | **73 %**| DB Tracky (PostGIS)     |
| vizyo-leads-postgres   | 59 %    | DB Leads                |
| vizyo-manager-postgres | 46 %    | DB Manager              |
| maalem-redis           | 37 %    | Redis Maalem prod       |
| vizyo-leads-redis      | 36 %    | Redis Leads             |
| maalem-admin           | 35 %    | Maalem admin            |
| capcom6-worker         | 31 %    | SMS gateway worker      |
| maalem-minio           | 30 %    | MinIO Maalem prod       |
| vizyo-leads-postgres-1 | 29 %    | DB Leads (doublon!)     |
| vizyo-tracky-redis     | 21 %    | Redis Tracky **DEV** (doublon) |
| tracky-redis           | 20 %    | Redis Tracky prod       |
| maalem-dev-minio       | 25 %    | MinIO Maalem **DEV**    |
| maalem-dev-redis       | 26 %    | Redis Maalem **DEV**    |
| maalem-dev-postgres    | 16 %    | Postgres Maalem **DEV** |
| **Total estime**       | **~700 %** | sur 200 % dispo      |

### Snapshot 2 (16:15 UTC)

| Conteneur              | CPU %   |
|------------------------|---------|
| capcom6-mysql          | 72 %    |
| vizyo-tracky-redis     | 57 %    |
| tracky-api             | 54 %    |
| tracky-postgres        | 36 %    |
| tracky-redis           | 29 %    |
| capcom6-server         | 26 %    |
| vizyo-manager-postgres | 23 %    |
| maalem-admin           | 23 %    |

> La charge fluctue entre conteneurs mais le total reste **largement au-dessus de 200 %**.

---

## 3. Causes identifiees

### Cause 1 (INFRA) — Surpopulation de conteneurs : 34 sur 2 vCPU

**Probleme** : Le VPS heberge 34 conteneurs dont :
- **5 conteneurs DEV Maalem** (`maalem-dev-postgres`, `maalem-dev-minio`, `maalem-dev-redis`, `maalem-dev-admin`, `maalem-dev-web`) qui n'ont rien a faire en prod
- **1 Redis DEV Tracky** (`vizyo-tracky-redis`) issu du `docker-compose.yml` de dev, demarre par erreur a cote du `docker-compose.prod.yml`
- **2 Postgres Leads** (`vizyo-leads-postgres` + `vizyo-leads-postgres-1`) — probablement un doublon
- **6 instances Redis** au total, **7 instances Postgres** au total

**Impact estime** : les conteneurs non-Tracky + doublons consomment ~200-300 % CPU, soit l'equivalent de **1 a 1.5 vCPU sur 2**.

### Cause 2 (APPLICATIF) — tracky-api : ingestion + crons + audit non purge

**tracky-api consomme 54-85 % CPU** (un seul process Node.js). Decomposition :

#### 2a. Table `position_sampling_decisions` : 733K lignes, 234 MB, AUCUNE purge

- Chaque trame GPS (meme skippee) cree un row d'audit dans `position_sampling_decisions`.
- **Aucun job de nettoyage n'existe** pour cette table — le code mentionne "rolling-7d" dans un commentaire mais la purge n'est pas implementee.
- Avec ~14 trackers envoyant une trame toutes les ~30s : ~40K lignes/jour, 733K lignes accumulees depuis le 27 avril.
- La table `wire_logs` (224K lignes, 89 MB) est purgee a 7 jours, mais `position_sampling_decisions` ne l'est pas.

#### 2b. Seq scans massifs sur petites tables

| Table              | seq_scan    | n_live_tup | Commentaire                         |
|--------------------|-------------|------------|-------------------------------------|
| **trackers**       | **2 658 759** | 14       | Lookup par IMEI sur chaque frame    |
| **vehicles**       | **732 102**   | 14       | Join via `include: { vehicle }`     |
| vehicle_schedules  | 83 467        | 2        | Cron every minute `findMany`        |
| tracker_commands   | 53 356        | 295      | Cron every 30s `findMany`           |
| alerts             | 23 750        | 1658     | Alertes sans index fleetId          |

> Sur 14 lignes, Postgres choisit legitimement un seq_scan. Le probleme n'est pas l'absence d'index mais la **frequence d'appel** : ~2.6M lookups tracker en ~3 jours.

#### 2c. Double lookup tracker sur les trames avec alarme

Dans `tcp-server.service.ts:203` : apres `positions.ingest(frame)` (qui fait deja un `findUnique` tracker avec join vehicle+fleet), le code refait un `findUnique` identique pour les alarmes. Chaque trame avec alarme = 2 requetes identiques.

#### 2d. Crons cumules

| Cron                        | Frequence    | Requete                                     |
|-----------------------------|-------------|----------------------------------------------|
| tracker-commands-scheduler  | **30s**     | `findMany` sur tracker_commands + join tracker+vehicle |
| schedule-cron               | 60s         | `findMany` vehicleSchedule + join vehicle+tracker |
| surveillance-scheduler      | 60s         | `findMany` surveillanceProfile + join vehicle |
| escalation-cron             | 60s         | Non analyse                                  |
| trips timeout               | 60s         | Non analyse                                  |
| ignition-inferred-cleanup   | 60s         | Non analyse                                  |
| position-batch-buffer       | **100ms**   | Flush timer meme quand buffer vide           |
| position-broadcast-buffer   | 1s          | Interval WS coalescing                       |

Sous throttle CPU, chaque cron prend plus longtemps et peut chevaucher le suivant.

### Cause 3 (APPLICATIF) — tracky-postgres : 36-73 % CPU

Directement lie a la Cause 2 : les requetes repetitives de tracky-api saturent PostgreSQL.
- 6 connexions idle + 1 active au moment du diagnostic (sur max 100).
- Pas de requetes longues detectees (toutes < 1s).
- Le probleme est le **debit** (2.6M seq_scans) pas la duree.

### Cause 4 (INFRA) — Process `claude` sur le VPS

Le process `claude` (cette session) consomme **5.9 % CPU** et **337 MB RAM**. Sur un VPS deja sature, c'est un contributeur non negligeable.

---

## 4. Verdict sur l'hypothese "ingestion positions"

### PARTIELLEMENT CONFIRMEE

L'ingestion GPS est bien le **premier consommateur CPU cote applicatif** (tracky-api a 54-85%). Cependant :

- La cause racine n'est **pas uniquement** l'ingestion qui scale avec les devices (14 trackers = charge moderee).
- C'est la **combinaison** de :
  1. **34 conteneurs** (dont ~10 inutiles) qui saturent les 2 vCPU avant meme que Tracky ne fasse quoi que ce soit
  2. L'**absence de purge** de `position_sampling_decisions` (733K lignes, 234 MB)
  3. Les **crons cumules** qui interrogent la DB toutes les 30-60s
  4. Le process `claude` (5.9% CPU)

Avec seulement 14 trackers, l'ingestion elle-meme est raisonnable (sampling adaptatif, batch buffer). Mais sur un VPS deja asphyxie par les conteneurs parasites, tout devient lent, ce qui cree un cercle vicieux (throttle Hostinger → requetes plus longues → file d'attente → CPU encore plus charge).

---

## 5. Separation applicatif vs infra

### Corrigeable cote CODE APPLICATIF

| ID  | Probleme                                          | Impact CPU estime |
|-----|---------------------------------------------------|-------------------|
| A1  | Pas de purge `position_sampling_decisions`         | Moyen (table 234MB, index bloat) |
| A2  | Double lookup tracker sur alarmes                  | Faible (~5% des trames) |
| A3  | `position-batch-buffer` flush timer 100ms          | Faible (wake-up inutile) |
| A4  | Sampling decisions INSERT sur chaque trame         | Moyen (40K inserts/jour non purges) |

### Relevant de la CONFIG INFRA

| ID  | Probleme                                          | Impact CPU estime |
|-----|---------------------------------------------------|-------------------|
| I1  | 5 conteneurs DEV Maalem en prod                   | **Eleve** (~50-100% CPU) |
| I2  | Redis DEV Tracky (`vizyo-tracky-redis`) doublon    | Moyen (~20-57% CPU) |
| I3  | Postgres Leads doublon (`vizyo-leads-postgres-1`)  | Moyen (~30-60% CPU) |
| I4  | 34 conteneurs sur 2 vCPU (scheduling overhead)    | Eleve (context switching) |
| I5  | Process `claude` residuel                          | Faible (~6% CPU) |
| I6  | Pas de CPU limits Docker                           | Moyen (un conteneur peut en affamer d'autres) |
