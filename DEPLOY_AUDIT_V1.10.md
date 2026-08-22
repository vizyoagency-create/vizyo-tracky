# Déploiement audit V1.10 — guide pas à pas

> ⚠️ **Historique — déploiement V1.10 réalisé** *(bandeau posé le 2026-08-22)*. La
> procédure courante est `docs/DEPLOYMENT-VPS.md`. En particulier : les migrations sont
> appliquées par l'**entrypoint** au démarrage du conteneur — ne jamais rejouer
> `prisma migrate deploy` ni du DDL à la main en production (P3009, API en boucle,
> incident payé le 21/08).

État local : commit merge `8d9e1ae` sur `main` qui rassemble 9 commits Sprint
1→6 + le commit `d3dca0c` (reports modal) qui avait été poussé en parallèle.

## 1. Push depuis ta machine

```bash
cd D:/www/vizyo-agency/vizyo-tracky/vizyo-tracky
git push origin main
```

Si l'auth GitHub te demande un PAT et que tu en as pas : `gh auth login` ou
configure `git credential.helper manager` (Windows).

## 2. Sur le VPS

### 2.1 Backup avant tout

```bash
# DB backup (selon ton setup pg_dump local ou rclone)
docker exec vizyo-tracky-postgres pg_dump -U vizyo vizyo_tracky | gzip > /backups/vizyo-tracky-pre-v1.10.sql.gz

# Code backup (au cas où)
cp -r /srv/vizyo-tracky /srv/vizyo-tracky.backup.$(date +%Y%m%d)
```

### 2.2 Pull + install + migrate

```bash
cd /srv/vizyo-tracky

# 1. Pull
git fetch origin
git checkout main
git pull origin main

# 2. Install (nouvelles deps : cookie-parser, @socket.io/redis-adapter, @types/cookie-parser)
pnpm install --frozen-lockfile

# 3. Build le package shared (sinon api/web cassent à l'import)
pnpm --filter @vizyo/tracky-shared build

# 4. Generate Prisma client
cd apps/api
npx prisma generate

# 5. Appliquer la nouvelle migration (alerts/invitations/engine_control_commands indexes)
npx prisma migrate deploy
cd ../..

# 6. Build api + web
pnpm --filter @vizyo/tracky-api build
pnpm --filter @vizyo/tracky-web build
```

### 2.3 Vérifier les variables d'env

```bash
# Verifier que ces 2 variables sont posées (déjà OK si REDIS_URL existait avant) :
grep "REDIS_URL\|connection_limit" /srv/vizyo-tracky/.env
```

Ajouter `?connection_limit=40` au `DATABASE_URL` si manquant :

```bash
# Exemple :
# DATABASE_URL=postgresql://vizyo:****@localhost:5432/vizyo_tracky?schema=public&connection_limit=40
```

### 2.4 Restart les services

```bash
# Si tu utilises docker compose :
docker compose -f docker-compose.prod.yml restart api web
docker compose -f docker-compose.prod.yml logs -f api --tail=50
```

ou avec systemd :

```bash
sudo systemctl restart vizyo-tracky-api vizyo-tracky-web
sudo journalctl -u vizyo-tracky-api -f
```

### 2.5 Smoke tests prod

Au démarrage de l'API, tu dois voir dans les logs :

```
[ws-adapter] Redis adapter prepared (multi-instance ready)
Nest application successfully started
Coban TCP server listening on :5023
API ready on http://localhost:3000/api
```

Tests rapides :

```bash
# Health
curl -i https://api.tracky.vizyoagency.com/api/health
# Doit retourner 200

# Auth guard
curl -i https://api.tracky.vizyoagency.com/api/vehicles
# Doit retourner 401 Unauthorized

# Login (avec un compte test)
curl -i -c cookies.txt -X POST https://api.tracky.vizyoagency.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@test.com","password":"..."}'
# Doit retourner 200 + Set-Cookie tracky_at + tracky_rt

# Vehicles avec cookie
curl -i -b cookies.txt https://api.tracky.vizyoagency.com/api/vehicles
# Doit retourner 200 + liste
```

## 3. Points de vigilance

### 3.1 JWT cookies httpOnly

Le frontend continue d'envoyer le header `Authorization: Bearer` en parallèle
des cookies (`withCredentials: true`). Le backend lit prioritairement le cookie.
La transition est **graduelle** : les sessions existantes restent valides.

À surveiller dans les logs :
- Aucune erreur 401 inattendue dans les requêtes du frontend.

### 3.2 Migration partitioning Position (NON appliquée)

Le script SQL `apps/api/prisma/migrations-manual/positions-partitioning.sql`
n'est **PAS** exécuté par `prisma migrate deploy`. Il est intentionnellement
hors du dossier `migrations/`.

À planifier séparément avec un DBA (cf. `docs/20-position-partitioning-plan.md`).

### 3.3 Permissions backend

Le `PermissionsGuard` est appliqué sur quelques endpoints critiques (vehicles
create/edit/delete, alerts acknowledge, geofences). Si tu vois des 403 en prod
sur des actions de FLEET_MANAGER qui marchaient avant, c'est probable que
l'user n'a pas la permission JSON correspondante dans `User.permissions`.

Fix rapide : `UPDATE users SET permissions = '{...}' WHERE id = '...'` avec
le mapping du rôle (cf. `apps/api/src/users/default-permissions.ts`).

### 3.4 Redis adapter Socket.io

Si tu vois `[ws-adapter] REDIS_URL absent — memory adapter (single instance)`
c'est que `REDIS_URL` n'est pas dans l'env. Pas critique pour 1 instance API,
mais empêche le scale horizontal.

## 4. Rollback si problème

```bash
cd /srv/vizyo-tracky
git reset --hard d3dca0c   # commit juste avant le merge audit
pnpm --filter @vizyo/tracky-api build
pnpm --filter @vizyo/tracky-web build
docker compose -f docker-compose.prod.yml restart api web
```

Les indexes Prisma ajoutés (alerts/invitations/engine_control_commands) sont
non-destructifs — pas besoin de rollback DB.

Si vraiment besoin de rollback la migration :

```bash
docker exec -it vizyo-tracky-postgres psql -U vizyo vizyo_tracky -c "
DROP INDEX IF EXISTS \"alerts_fleetId_severity_createdAt_idx\";
DROP INDEX IF EXISTS \"invitations_fleetId_idx\";
DROP INDEX IF EXISTS \"engine_control_commands_trackerId_createdAt_idx\";
DELETE FROM _prisma_migrations WHERE migration_name = '20260520120000_perf_indexes_v2';
"
```

## 5. Suivi des items audit

| Sprint | Commit | Sujet |
|---|---|---|
| 1 + 1.5 | 4f026a8 + 15867db | 13 + 5 IDOR cross-fleet |
| 2 | d1df199 | Scaling 100+ véhicules |
| 3 | eced550 | Map (fuites, jank, dedup DOM) |
| 4 | 7fb425b | Notifs (escalade, debounce, prompt) |
| 5 | dcbd6de | Stabilité frontend (toast, freshness, leaks) |
| 6 | b70308a + fdfc8fe | Finition (Redis, JWT cookies, partitioning, permissions) |
| Tests | 3e210fb | 217/217 jest passent |
| **Merge** | **8d9e1ae** | **`main` après merge** |
