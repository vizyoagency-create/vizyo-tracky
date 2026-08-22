# Déploiement Tracky sur VPS — v2 (pixel-perfect)

> ⚠️ **Historique — guide d'installation initiale (avril 2026)** *(bandeau posé le
> 2026-08-22)*. Ce fichier (double extension `.md.md`, artefact d'écriture — renommage à
> décider par le propriétaire) décrit l'installation *from scratch* du VPS. La procédure
> de déploiement **courante** est `docs/DEPLOYMENT-VPS.md`. Conserver : il contient les
> Dockerfiles/compose et le contexte que l'autre n'a pas.

> **Contexte** : VPS Ubuntu 24.04, Docker 29.1.3, Traefik v3.6.6 déjà en place (container `foodsqan-traefik`, réseau `foodsqan-public`, cert resolver `letsencrypt`). Pas de staging, pas de backup pour le moment. Repo Tracky à `/opt/vizyo-tracky`.
>
> **Décisions architecture figées** :
>
> - 1 seul domaine HTTP : `app-tracky.vizyoagency.com` (UI + API + WS via PathPrefix)
> - 1 domaine LP : `tracky.vizyoagency.com`
> - TCP tracker : `app-tracky.vizyoagency.com:5023` (port publié directement sur l'host)
> - Auth déléguée à `https://api.auth.vizyoagency.com` (service partagé Vizyo)
> - Compose prod dans `deploy/vps/`, réseau interne `vizyo-tracky`, réseau externe `foodsqan-public`
> - Pas de staging (ajout ultérieur si besoin)

---

## 1. Vue d'ensemble

| Composant          | Domaine / Port                        | Conteneur                            |
| ------------------ | ------------------------------------- | ------------------------------------ |
| Landing page       | `tracky.vizyoagency.com`              | `tracky-lp` (nginx statique)         |
| Angular web        | `app-tracky.vizyoagency.com/`         | `tracky-web` (nginx servant le dist) |
| API REST           | `app-tracky.vizyoagency.com/api/*`    | `tracky-api` (NestJS)                |
| WebSocket          | `app-tracky.vizyoagency.com/realtime` | `tracky-api` (NestJS Socket.IO)      |
| TCP trackers       | `app-tracky.vizyoagency.com:5023`     | `tracky-api` (port 5023 publié host) |
| Postgres + PostGIS | interne uniquement                    | `tracky-postgres`                    |
| Redis              | interne uniquement                    | `tracky-redis`                       |

**Flux réseau** :

```
Internet ─┬─ 80/443 ──→ foodsqan-traefik ──→ foodsqan-public ─┬─→ tracky-lp
          │                                                   ├─→ tracky-web
          │                                                   └─→ tracky-api
          │
          └─ 5023 ─────────────────────────────────────────────→ tracky-api

                                                 vizyo-tracky (interne) :
                                                 tracky-api ↔ tracky-postgres
                                                 tracky-api ↔ tracky-redis
```

---

## 2. Vérifications préalables

```bash
# Repo à jour
cd /opt/vizyo-tracky
git pull origin main
git log --oneline -3

# Réseau Traefik existe bien
docker network inspect foodsqan-public --format '{{.Name}} — {{.IPAM.Config}}'
# Attendu : foodsqan-public — [{172.18.0.0/16 ...}]

# Traefik up et healthy
docker ps --filter "name=foodsqan-traefik" --format '{{.Names}} {{.Status}}'

# Ports libres
sudo ss -tlnp | grep -E ':(5023|5024)\s' || echo "5023 et 5024 libres ✓"

# UFW status
sudo ufw status | grep -E '(22|80|443)'
# Attendu : 22, 80, 443 ALLOW

# DNS (après création des A records — voir section 3)
dig +short tracky.vizyoagency.com
dig +short app-tracky.vizyoagency.com
# Les deux doivent retourner 72.62.26.240
```

Si un seul de ces checks échoue : STOP et corriger avant de continuer.

---

## 3. DNS — records à créer

Chez le registrar de `vizyoagency.com` :

| Type | Nom          | Valeur         | TTL |
| ---- | ------------ | -------------- | --- |
| A    | `tracky`     | `72.62.26.240` | 300 |
| A    | `app-tracky` | `72.62.26.240` | 300 |

**Ne pas créer** `api.tracky` ni `gps` ni `tracky-staging` — inutiles avec l'archi unifiée.

**Vérifier propagation avant de déployer** :

```bash
dig +short tracky.vizyoagency.com @8.8.8.8
dig +short app-tracky.vizyoagency.com @8.8.8.8
# Les deux doivent retourner 72.62.26.240
# Si NXDOMAIN → attendre la propagation (5-30 min)
```

---

## 4. Fichiers à créer

Structure cible dans le repo :

```
/opt/vizyo-tracky/
├── apps/
├── packages/
├── lp/
├── docker/                          # existant, inchangé
├── docker-compose.yml               # existant (DEV uniquement — ne pas toucher)
└── deploy/
    └── vps/
        ├── .gitignore               # ignore les .env
        ├── .env.prod.example        # committed
        ├── .env.prod                # NE PAS COMMITTER
        ├── docker-compose.prod.yml
        ├── docker-compose.lp.yml
        ├── Dockerfile.api
        ├── Dockerfile.web
        ├── Dockerfile.lp
        ├── nginx.web.conf
        ├── nginx.lp.conf
        └── README.md                # pointeur vers DEPLOYMENT-VPS.md
```

### 4.1 `deploy/vps/.gitignore`

```
.env.prod
.env.staging
```

### 4.2 `deploy/vps/.env.prod.example`

```bash
# === Traefik (infra existante foodsqan) ===
TRAEFIK_NETWORK=foodsqan-public
TRAEFIK_CERT_RESOLVER=letsencrypt
TRAEFIK_ENTRYPOINT=websecure

# === Domaines ===
APP_DOMAIN=app-tracky.vizyoagency.com
LP_DOMAIN=tracky.vizyoagency.com
APP_URL=https://app-tracky.vizyoagency.com

# === Postgres ===
POSTGRES_DB=tracky_prod
POSTGRES_USER=tracky
POSTGRES_PASSWORD=__GENERATE_WITH_openssl_rand_-base64_32__

# === Vizyo Auth (service partagé) ===
VIZYO_AUTH_URL=https://api.auth.vizyoagency.com
# JWT_SECRET doit correspondre à celui du service Vizyo Auth
JWT_SECRET=__SAME_AS_VIZYO_AUTH_SERVICE__
JWT_EXPIRES_IN=7d

# === Observability ===
WIRE_LOG_ENABLED=true
LOG_LEVEL=info

# === TCP ===
COBAN_TCP_PORT=5023

# === Sécurité ===
MOCK_POSITIONS=false
CORS_ORIGIN=https://app-tracky.vizyoagency.com
```

### 4.3 `deploy/vps/Dockerfile.api`

```dockerfile
# Dockerfile.api — build multi-stage NestJS + Prisma
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .
RUN pnpm --filter @vizyo/tracky-shared build
RUN cd apps/api && pnpm prisma generate
RUN pnpm --filter @vizyo/tracky-api build

FROM node:20-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
RUN apk add --no-cache wget
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s \
  CMD wget -qO- http://localhost:3000/api/health 2>&1 | grep -q "ok\|healthy" \
      || wget -S --spider http://localhost:3000/api 2>&1 | grep -qE "(401|404|200)" \
      || exit 1

EXPOSE 3000 5023
WORKDIR /app/apps/api

CMD ["sh", "-c", "pnpm prisma migrate deploy && node dist/src/main.js"]
```

> Le healthcheck accepte 401/404 car l'API requiert auth sur la plupart des routes. C'est la même logique que testée en local.

### 4.4 `deploy/vps/Dockerfile.web`

```dockerfile
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .
RUN pnpm --filter @vizyo/tracky-shared build
RUN pnpm --filter @vizyo/tracky-web build --configuration=production

FROM nginx:alpine AS runtime
# Le build Angular par défaut génère /browser/ ou directement dans outputPath.
# On copie tout sous-dossier existant, le premier qui match gagne.
COPY --from=builder /app/apps/web/dist /tmp/dist
RUN if [ -d /tmp/dist/tracky-web/browser ]; then \
      cp -r /tmp/dist/tracky-web/browser/* /usr/share/nginx/html/; \
    elif [ -d /tmp/dist/tracky-web ]; then \
      cp -r /tmp/dist/tracky-web/* /usr/share/nginx/html/; \
    else \
      cp -r /tmp/dist/*/* /usr/share/nginx/html/; \
    fi && \
    rm -rf /tmp/dist
COPY deploy/vps/nginx.web.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

### 4.5 `deploy/vps/nginx.web.conf`

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Headers de sécurité
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 256;

    # Angular SPA routing — fallback vers index.html pour toute route non trouvée
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache long pour assets hashés
    location ~* \.(js|css|woff2?|png|jpg|jpeg|svg|ico|webp)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Pas de cache sur index.html (pour les déploiements)
    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }
}
```

### 4.6 `deploy/vps/Dockerfile.lp`

```dockerfile
FROM nginx:alpine
COPY lp/ /usr/share/nginx/html/
COPY deploy/vps/nginx.lp.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

> Adapter `COPY lp/` si la LP est dans un autre sous-dossier. Vérifier avec `ls /opt/vizyo-tracky/lp/` qu'il contient bien `index.html`.

### 4.7 `deploy/vps/nginx.lp.conf`

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    gzip on;
    gzip_types text/plain text/css application/javascript text/html image/svg+xml;
    gzip_min_length 256;

    location / {
        try_files $uri $uri/ =404;
    }

    location ~* \.(js|css|woff2?|png|jpg|jpeg|svg|ico|webp)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

### 4.8 `deploy/vps/docker-compose.prod.yml`

```yaml
name: tracky-prod

networks:
  foodsqan-public:
    external: true
    name: ${TRAEFIK_NETWORK}
  vizyo-tracky:
    driver: bridge
    name: vizyo-tracky

volumes:
  tracky-postgres-data:
    name: tracky-postgres-data
  tracky-redis-data:
    name: tracky-redis-data
  tracky-api-logs:
    name: tracky-api-logs

services:
  postgres:
    image: postgis/postgis:16-3.4-alpine
    container_name: tracky-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - tracky-postgres-data:/var/lib/postgresql/data
      - ../../docker/postgres/init-postgis.sql:/docker-entrypoint-initdb.d/init-postgis.sql:ro
    networks:
      - vizyo-tracky
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s

  redis:
    image: redis:7-alpine
    container_name: tracky-redis
    restart: unless-stopped
    command: redis-server --appendonly yes
    volumes:
      - tracky-redis-data:/data
    networks:
      - vizyo-tracky
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  api:
    build:
      context: ../..
      dockerfile: deploy/vps/Dockerfile.api
    image: tracky-api:latest
    container_name: tracky-api
    restart: unless-stopped
    env_file:
      - .env.prod
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}?schema=public
      REDIS_HOST: redis
      REDIS_PORT: 6379
      API_PORT: 3000
      COBAN_TCP_PORT: 5023
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    ports:
      - "5023:5023"
    volumes:
      - tracky-api-logs:/app/apps/api/logs
    networks:
      - vizyo-tracky
      - foodsqan-public
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=${TRAEFIK_NETWORK}"
      # Router API — capte /api/* et /realtime/* sur app-tracky
      - "traefik.http.routers.tracky-api.rule=Host(`${APP_DOMAIN}`) && (PathPrefix(`/api`) || PathPrefix(`/realtime`))"
      - "traefik.http.routers.tracky-api.entrypoints=${TRAEFIK_ENTRYPOINT}"
      - "traefik.http.routers.tracky-api.tls=true"
      - "traefik.http.routers.tracky-api.tls.certresolver=${TRAEFIK_CERT_RESOLVER}"
      - "traefik.http.routers.tracky-api.priority=10"
      - "traefik.http.services.tracky-api.loadbalancer.server.port=3000"
      # Headers pour WebSocket
      - "traefik.http.middlewares.tracky-api-ws.headers.customrequestheaders.X-Forwarded-Proto=https"

  web:
    build:
      context: ../..
      dockerfile: deploy/vps/Dockerfile.web
    image: tracky-web:latest
    container_name: tracky-web
    restart: unless-stopped
    networks:
      - foodsqan-public
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=${TRAEFIK_NETWORK}"
      # Router Web — catch-all sur app-tracky (priorité plus basse que l'API)
      - "traefik.http.routers.tracky-web.rule=Host(`${APP_DOMAIN}`)"
      - "traefik.http.routers.tracky-web.entrypoints=${TRAEFIK_ENTRYPOINT}"
      - "traefik.http.routers.tracky-web.tls=true"
      - "traefik.http.routers.tracky-web.tls.certresolver=${TRAEFIK_CERT_RESOLVER}"
      - "traefik.http.routers.tracky-web.priority=1"
      - "traefik.http.services.tracky-web.loadbalancer.server.port=80"
```

> **Priorités Traefik** : router API à 10 (plus spécifique, doit matcher en premier pour `/api` et `/realtime`), router Web à 1 (catch-all pour tout le reste). Sans priorités explicites, Traefik pourrait se tromper.

### 4.9 `deploy/vps/docker-compose.lp.yml`

```yaml
name: tracky-lp

networks:
  foodsqan-public:
    external: true
    name: ${TRAEFIK_NETWORK}

services:
  lp:
    build:
      context: ../..
      dockerfile: deploy/vps/Dockerfile.lp
    image: tracky-lp:latest
    container_name: tracky-lp
    restart: unless-stopped
    networks:
      - foodsqan-public
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=${TRAEFIK_NETWORK}"
      - "traefik.http.routers.tracky-lp.rule=Host(`${LP_DOMAIN}`)"
      - "traefik.http.routers.tracky-lp.entrypoints=${TRAEFIK_ENTRYPOINT}"
      - "traefik.http.routers.tracky-lp.tls=true"
      - "traefik.http.routers.tracky-lp.tls.certresolver=${TRAEFIK_CERT_RESOLVER}"
      - "traefik.http.services.tracky-lp.loadbalancer.server.port=80"
```

### 4.10 `deploy/vps/README.md`

```markdown
# Déploiement VPS Tracky

Voir `docs/DEPLOYMENT-VPS.md` pour la procédure complète.

## Commandes rapides

    # Depuis /opt/vizyo-tracky/deploy/vps/
    docker compose -f docker-compose.lp.yml up -d --build   # Landing page
    docker compose -f docker-compose.prod.yml up -d --build # App prod

    # Logs
    docker logs -f tracky-api
    docker compose -f docker-compose.prod.yml logs -f

    # Redéploiement après git pull
    cd /opt/vizyo-tracky && git pull origin main
    cd deploy/vps && docker compose -f docker-compose.prod.yml up -d --build
```

---

## 5. Ajustements du code — pré-requis

Avant le premier déploiement, 2 points à vérifier côté code applicatif (ne nécessitent pas forcément de modif, mais à contrôler) :

### 5.1 Endpoint `/api/health`

Le healthcheck Docker essaie `/api/health`. Si cet endpoint n'existe pas, il retombera sur `/api` (accepte 401/404). Pour un healthcheck propre, ajouter :

```bash
grep -r "@Get('health')" apps/api/src/ || echo "⚠️ Endpoint /api/health absent"
```

Si absent, c'est **non-bloquant** (fallback opérationnel), mais à ajouter dans un commit ultérieur.

### 5.2 CORS configuré sur l'URL unifiée

Avec l'architecture unifiée (même domaine pour UI et API), techniquement **aucun CORS n'est nécessaire** puisque tout passe par `app-tracky.vizyoagency.com`. Mais vérifier que l'API n'a pas un CORS trop strict qui bloquerait même same-origin :

```bash
grep -n "cors\|enableCors" apps/api/src/main.ts
```

Si CORS activé avec whitelist stricte : ajouter `https://app-tracky.vizyoagency.com` via la variable `CORS_ORIGIN` du `.env.prod`.

### 5.3 Base URL côté Angular

L'Angular build doit utiliser des chemins **relatifs** (`/api`, `/realtime`) et non absolus. Vérifier :

```bash
grep -rn "environment.apiUrl\|API_URL" apps/web/src/environments/ | head -10
```

L'environnement de production doit avoir :

```ts
export const environment = {
	production: true,
	apiUrl: "/api",
	wsUrl: "/realtime",
};
```

Si les URLs sont absolues (`http://localhost:3000/api`) dans `environment.prod.ts`, **les corriger** avant de builder. Sinon le web va chercher localhost en prod.

---

## 6. Procédure de déploiement initial

### 6.1 Créer les secrets

```bash
cd /opt/vizyo-tracky/deploy/vps
cp .env.prod.example .env.prod

# Générer un password Postgres fort
openssl rand -base64 32
# → copier dans POSTGRES_PASSWORD

# Récupérer le JWT_SECRET depuis le service Vizyo Auth
# (doit être IDENTIQUE pour que les tokens soient validés)
docker exec vizyo-auth-api env | grep JWT_SECRET
# → copier exactement dans JWT_SECRET

nano .env.prod
# Remplir tous les champs, vérifier aucun __GENERATE__ ni __SAME_AS__ ne reste
grep -E "(__GENERATE|__SAME_AS)" .env.prod && echo "⚠️ Secrets non remplis" || echo "✓ Tous les secrets sont définis"
```

### 6.2 Ouvrir le port TCP 5023

```bash
sudo ufw allow 5023/tcp comment "Tracky GPS TCP Coban"
sudo ufw reload
sudo ufw status numbered | grep 5023
```

### 6.3 Déployer la LP en premier

```bash
cd /opt/vizyo-tracky/deploy/vps
docker compose -f docker-compose.lp.yml --env-file .env.prod up -d --build

# Suivre le build
docker compose -f docker-compose.lp.yml logs -f lp
# Ctrl+C une fois "Starting nginx" vu

# Vérifier
docker ps --filter "name=tracky-lp" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Vérifier HTTP/HTTPS
curl -sI http://tracky.vizyoagency.com | head -5
# Attendu : 308 redirect vers HTTPS

curl -sI https://tracky.vizyoagency.com | head -5
# Attendu : 200 OK avec certificat Let's Encrypt valide
```

**Si erreur cert SSL** : attendre 1-2 min (émission ACME), puis retester. Si échec persistant après 5 min :

```bash
docker logs foodsqan-traefik --tail 50 | grep -iE "(acme|tracky|error)"
```

### 6.4 Déployer la stack prod (API + Web + DB + Redis)

```bash
cd /opt/vizyo-tracky/deploy/vps
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

# Suivre le démarrage (Postgres doit passer healthy avant que l'API démarre)
docker compose -f docker-compose.prod.yml logs -f
# Attendre :
#   tracky-postgres : "database system is ready to accept connections"
#   tracky-redis    : "Ready to accept connections"
#   tracky-api      : "Prisma migrations applied" puis "Nest application successfully started" puis "Coban TCP server listening on :5023"
#   tracky-web      : "nginx ... start worker process"
# Ctrl+C une fois stabilisé

# État des containers
docker ps --filter "name=tracky-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
# Les 4 doivent être "Up (healthy)" ou "Up" pour web/lp
```

### 6.5 Seed initial

```bash
# Vérifier que les migrations sont passées
docker exec tracky-api sh -c "cd /app/apps/api && pnpm prisma migrate status"

# Exécuter le seed (crée admin + flotte démo + vehicle mock)
docker exec -it tracky-api sh -c "cd /app/apps/api && pnpm prisma db seed"
```

---

## 7. Vérifications post-déploiement

### 7.1 HTTP endpoints

```bash
# LP
curl -sI https://tracky.vizyoagency.com | head -3
# Attendu : HTTP/2 200

# Angular app
curl -sI https://app-tracky.vizyoagency.com | head -3
# Attendu : HTTP/2 200, content-type: text/html

# API — retour attendu = erreur auth formatée par AllExceptionsFilter
curl -s -X POST https://app-tracky.vizyoagency.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"x","password":"x"}' | jq .
# Attendu : {"error":{"code":"...","message":"...","requestId":"..."}}
```

### 7.2 TCP 5023 joignable depuis internet

```bash
# Depuis une MACHINE EXTERNE (pas depuis le VPS lui-même) :
nc -vz app-tracky.vizyoagency.com 5023
# Attendu : "Connection to app-tracky.vizyoagency.com 5023 port [tcp/*] succeeded!"

# Depuis le VPS (moins probant mais confirme que le port écoute)
nc -vz localhost 5023
```

### 7.3 Pipeline wire_logs fonctionnel en prod

```bash
# Vider wire_logs
docker exec tracky-postgres psql -U tracky -d tracky_prod -c "TRUNCATE wire_logs;"

# Se logger sur https://app-tracky.vizyoagency.com avec le compte admin seed
# Déclencher un CUT ou RESTORE sur le tracker mock

# Vérifier
docker exec tracky-postgres psql -U tracky -d tracky_prod -c \
  "SELECT direction, frame_type, substring(raw from 1 for 60), command_id, created_at \
   FROM wire_logs ORDER BY created_at DESC LIMIT 5;"
# Attendu : au moins 1 ligne OUT avec frame_type='command'
```

### 7.4 Logs en live

```bash
docker logs -f tracky-api
# Les logs Pino JSON doivent apparaître structurés

# Filtrer les erreurs
docker logs tracky-api 2>&1 | grep -E '"level":(40|50|60)'
```

---

## 8. Configuration d'un 403C

Une fois le VPS déployé et joignable, configurer le tracker par SMS (séquence ordonnée) :

```
1. begin<PWD>                              → ACK : begin ok
2. password<OLD> 123456                    → ACK : password ok
3. apn123456 <apn>,<user>,<pass>           → ACK : APN OK
4. adminip123456 72.62.26.240 5023         → ACK : adminip ok
5. gprs123456                              → ACK : GPRS ok
6. time zone123456,0                       → ACK : time zone ok
7. fix030s***n123456                       → ACK : fix030s***n ok
8. protocol123456 18                       → ACK : protocol18 ok (optionnel sur 403C)
9. less gprs123456 on                      → ACK : less gprs on ok
```

**Important** : la plupart des firmwares Coban n'acceptent qu'une **IP directe** dans `adminip`, pas un hostname DNS. On utilise donc `72.62.26.240` directement. Inconvénient : changement de VPS = reflashage des trackers par SMS. Acceptable pour V1.

Surveiller immédiatement la connexion :

```bash
docker logs -f tracky-api | grep -iE "(tracker connected|unknown imei|wire.*IN)"
```

Dès que le tracker se connecte :

- Log INFO `Tracker connected: <IMEI>`
- Ligne IN `frame_type=login` dans `wire_logs`

Si `Unknown IMEI` → le tracker n'est pas seedé en base. Créer manuellement :

```bash
docker exec tracky-postgres psql -U tracky -d tracky_prod -c \
  "INSERT INTO trackers (id, imei, model, status) VALUES
   (gen_random_uuid(), '<IMEI_DU_403C>', 'COBAN_GPS403C', 'OFFLINE');"
```

---

## 9. Redéploiement (après `git pull`)

```bash
cd /opt/vizyo-tracky
git pull origin main

cd deploy/vps
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

# Optionnel : LP si modifiée
docker compose -f docker-compose.lp.yml --env-file .env.prod up -d --build

# Nettoyage images orphelines (périodique)
docker image prune -f
```

Les migrations Prisma sont appliquées automatiquement au démarrage du conteneur API.

---

## 10. Troubleshooting

### 10.1 Le tracker ne se connecte pas

```bash
# DNS OK ?
dig +short app-tracky.vizyoagency.com
# Doit retourner 72.62.26.240

# Port ouvert depuis internet ?
# (test depuis une machine EXTÉRIEURE)
nc -vz 72.62.26.240 5023

# UFW autorise ?
sudo ufw status | grep 5023

# API écoute bien sur 5023 ?
sudo ss -tlnp | grep 5023
# Attendu : 0.0.0.0:5023 (pas 127.0.0.1:5023)

# Logs API
docker logs tracky-api | grep -iE "(tcp server|coban)"

# IMEI seedé ?
docker exec tracky-postgres psql -U tracky -d tracky_prod -c "SELECT imei FROM trackers;"
```

### 10.2 Certificat SSL invalide

```bash
# Logs Traefik ACME
docker logs foodsqan-traefik --tail 100 | grep -iE "(acme|tracky)"

# Si rate limit Let's Encrypt atteint : attendre 1h
# Si "unable to get local issuer certificate" : DNS pas propagé
```

### 10.3 API 502 / 503 derrière Traefik

```bash
# API healthy ?
docker ps --filter "name=tracky-api" --format "{{.Status}}"

# Logs API
docker logs tracky-api --tail 50

# Traefik voit le service ?
docker logs foodsqan-traefik --tail 30 | grep tracky
```

### 10.4 Migration Prisma échouée au démarrage

```bash
docker logs tracky-api 2>&1 | grep -A 30 "Migration"

# Statut
docker exec tracky-api sh -c "cd /app/apps/api && pnpm prisma migrate status"

# Si drift
docker exec tracky-api sh -c "cd /app/apps/api && pnpm prisma migrate resolve --applied <nom_migration>"
```

### 10.5 WebSocket ne connecte pas

```bash
# Depuis le navigateur F12 → Network → WS, vérifier que l'URL est :
# wss://app-tracky.vizyoagency.com/realtime

# Tester depuis le VPS
docker exec tracky-api wget -qO- http://localhost:3000/realtime
# Doit retourner un handshake Socket.IO (400 Bad Request côté HTTP GET, mais normal)

# Traefik peut parfois bloquer les upgrades WS. Vérifier que PathPrefix(/realtime)
# est bien dans la règle du router API.
docker inspect tracky-api | grep -A 2 traefik.http.routers.tracky-api.rule
```

---

## 11. Opérations courantes

### 11.1 Accéder à la DB en prod

```bash
# psql interactif
docker exec -it tracky-postgres psql -U tracky -d tracky_prod

# Dump one-shot
docker exec tracky-postgres pg_dump -U tracky tracky_prod | gzip > tracky-prod-$(date +%Y%m%d).sql.gz
```

### 11.2 Restart propre

```bash
cd /opt/vizyo-tracky/deploy/vps

# Restart uniquement l'API
docker compose -f docker-compose.prod.yml --env-file .env.prod restart api

# Arrêt complet (DB préservée via volumes)
docker compose -f docker-compose.prod.yml --env-file .env.prod down

# Relance
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

### 11.3 Tail les 3 flux de logs (utile pour debug bench)

Terminal 1 :

```bash
docker logs -f tracky-api
```

Terminal 2 :

```bash
watch -n 2 'docker exec tracky-postgres psql -U tracky -d tracky_prod -c \
  "SELECT direction, frame_type, imei, substring(raw from 1 for 60), created_at \
   FROM wire_logs ORDER BY created_at DESC LIMIT 10;"'
```

Terminal 3 :

```bash
watch -n 5 'docker exec tracky-postgres psql -U tracky -d tracky_prod -c \
  "SELECT source, level, substring(message from 1 for 80), created_at \
   FROM error_logs ORDER BY created_at DESC LIMIT 5;"'
```

### 11.4 Prisma Studio via tunnel SSH

```bash
# Dans le conteneur
docker exec tracky-api sh -c "cd /app/apps/api && pnpm prisma studio --port 5555 --hostname 0.0.0.0 &"

# Depuis ta machine locale
ssh -L 5555:<IP_CONTENEUR>:5555 root@72.62.26.240
# puis ouvrir http://localhost:5555
```

---

## 12. TODO reportés (à traiter plus tard)

Ces points ne sont pas bloquants pour la V1 mais à planifier :

- [ ] **Backup automatique DB** — cron daily comme pour Vizyo Manager (`/var/backups/vizyo-tracky/`)
- [ ] **Environnement staging** — clone du compose prod sous `tracky-staging.vizyoagency.com` + port 5024
- [ ] **Endpoint `/api/health`** — ajouter un vrai healthcheck non-authed dans l'API
- [ ] **Monitoring** — intégrer Uptime Kuma ou Dozzle pour surveiller les 4 services Tracky
- [ ] **Migration Traefik 3.6.13** — opération séparée pour tous les projets
- [ ] **Rotation logs Docker** — `log-opts` dans `/etc/docker/daemon.json` pour limiter la taille

---

## 13. Update du tracker d'exécution

Après déploiement réussi, mettre à jour `docs/EXECUTION-TRACKER.md` :

```markdown
## 🌐 Infrastructure

- **Prod** : https://app-tracky.vizyoagency.com (UI + API + WS)
- **Landing** : https://tracky.vizyoagency.com
- **TCP trackers** : app-tracky.vizyoagency.com:5023 (IP directe 72.62.26.240:5023)
- **VPS** : Hostinger srv1201617 (IP 72.62.26.240)
- **Auth partagée** : api.auth.vizyoagency.com
- **Traefik** : foodsqan-traefik v3.6.6, réseau foodsqan-public, certresolver letsencrypt
- **Pas de staging, pas de backup** (TODO ultérieur)
```

Et dans la section Journal :

```markdown
| 2026-04-XX | Déploiement VPS initial | LP + API + Web + PostGIS + Redis déployés sur VPS Hostinger. DNS créés (tracky, app-tracky). UFW 5023 ouvert. Stack intégrée au réseau foodsqan-public, auth partagée via vizyo-auth. Wire logs validés en prod. |
```

---

## 14. Prêt pour le bench 403C

Une fois ce guide exécuté sans erreur, le bench 403C peut démarrer avec :

- Endpoint tracker : `adminip123456 72.62.26.240 5023` (IP directe)
- UI admin : https://app-tracky.vizyoagency.com/admin/observability
- Logs accessibles en SSH sur le VPS

Retour au guide bench : `docs/prompts/bench-403c.md` — remplacer `ngrok` / `port forward` par le VPS directement.
