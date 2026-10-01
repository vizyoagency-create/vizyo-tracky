# Constat du 30/09/2026 — la construction de `deploy.sh` rate le cache : `.git` et le `node_modules` de l'hôte sont dans le contexte

> **Statut** : cause **prouvée par expérience sur le VPS** (constructions seules, aucun conteneur
> recréé) ; correctif validé sur une copie du dépôt ; ✅ **EN PRODUCTION depuis le 01/10/2026 à
> 00:09 UTC** (commit `98f05329`, déployé avec la migration Node 24 du document 40).
>
> **Mesuré au déploiement** : après une pré-construction, la construction de `deploy.sh` a pris
> **2 s** (00:08:31 → 00:08:33) — contre ~4 min le 30/09 à 13:38 dans la même situation. Le bundle
> servi est passé à Angular **20.3.27** (vérifié dans le conteneur et dans le navigateur,
> `ng-version`), d'abord sur la démo, puis en production. Le `node_modules` de l'hôte a été rangé
> dans `/root/archives/vizyo-tracky-node_modules-hote-20260513/` (§ 9).

## En une phrase

Les trois Dockerfile construisent depuis la racine du dépôt **sans `.dockerignore`** : `COPY . .`
emporte `.git`, que le `git checkout` + `git pull` de `deploy.sh` réécrivent **même sans nouveau
commit**. L'étape builder (≈ 3 min) est donc rejouée juste après une pré-construction complète.
Ni les repères `docker tag` / `docker rmi`, ni la résolution de `node:20-alpine`, ni
l'environnement de construction n'y sont pour quelque chose.

---

## 1. Ce qui a été observé le 30/09

| Heure (UTC) | Quoi | Construction |
|---|---|---|
| 10:56 | pré-construction de `813e2bad` | produit `tracky-api` `2b3ebe48aa51` |
| 12:11 | `deploy.sh` (`813e2bad`), juste après une pré-construction | ≈ 5 min — l'image mise en service à 12:18 est `2b3ebe48aa51`, **créée à 10:56**, avec la couche `corepack` du 20/08 |
| 13:32 | construction manuelle de `977efc25` (`/tmp/essai-cache.log`) | **41/41 CACHED**, 15 s |
| 13:38:04 | `deploy.sh` (même commit, arbre propre), lancé par le guetteur `attente_deploiement_gf.sh` | construction prod de 13:38 à **13:42:12** ; à 13:42:22 : « ⛔ Déploiement REFUSÉ (recreation) : il est HH:42 » |
| 16:10 | pré-construction de `45367344` | l'étape deps est rejouée (manifeste modifié par ce commit : légitime) |
| 17:13:58 | `deploy.sh` (`45367344`, **le commit de la pré-construction**) | base en cache, mais `COPY . .` 46,8 s, build api 84,7 s, build web 95,2 s : **3 min 41 s** |

Le guetteur de 13:45 l'écrivait déjà dans son en-tête : *« sur ce VPS la construction de
deploy.sh rate le cache de base (≈ 4 min) »*. Le coût n'est pas que du temps : une construction de
4 min lancée à HH:38 finit dans la fenêtre HH:42–46, où `deploy.sh` refuse de recréer. Le
déploiement de 13:38 a construit pour rien.

## 2. Les hypothèses, et ce qui les tranche

| Hypothèse | Verdict | Ce qui le prouve |
|---|---|---|
| Les repères `docker tag` / `docker rmi` d'`etiqueter_repli`, sous le magasin d'images containerd | ❌ **innocents** | B2 (§ 3) : `tag` + `rmi` sur les trois images, **plus** la construction puis la suppression d'une vraie image `FROM node:20-alpine` (son dernier nom : l'image disparaît) → **41/41 CACHED en 7 s**. Et le passage de 17:13 a élagué un vrai repère (`avant-20260930-0700-…`, image supprimée) sans perdre l'étape de base. |
| La résolution de `node:20-alpine`, absente de `docker images` | ❌ **innocente** | Toutes les constructions lues (13:32, 17:14, B0–B4, C1–C4) résolvent `node:20-alpine@sha256:fb4cd12c85ee…` au registre (0,7–0,9 s). L'enregistrement `RUN corepack enable && corepack prepare pnpm@9.12.0` du cache BuildKit date du **2026-08-20** et sert toujours. Une image de base tirée par BuildKit n'apparaît jamais dans `docker images` : c'est le fonctionnement normal. |
| L'environnement de construction | ❌ **innocent** | Même commande, même constructeur (`default`, pilote `docker`, BuildKit v0.26.2 dans dockerd 29.1.3, Compose v5.0.0 → bake), aucune variable `DOCKER_*` / `BUILDKIT_*` / `COMPOSE_*`, aucun `args:` dans le compose ; le guetteur lance `deploy.sh` en `setsid nohup` depuis la même session root. |
| **Le contexte de construction** | ✅ **coupable** | Pas de `.dockerignore` : le contexte est **tout** l'arbre de travail du VPS, `.git` compris. B3 (§ 3) : `git checkout -q main && git pull --ff-only origin main` — « Already up to date », même commit — réécrivent **`.git/logs/HEAD`** et **`.git/ORIG_HEAD`** → **181 s**, `COPY . .` et tous les `pnpm … build` rejoués. |
| Aggravant : le ramasse-miettes du cache BuildKit | ⚠️ **aggrave** | B4, **sans aucun changement** : 119 s, la chaîne web rejouée. Le GC (`/etc/docker/daemon.json`, `builder.gc` : `keepStorage` 10 Go « all ») avait évincé ce que B3 venait de construire : 81 enregistrements avant B3, 67 après, alors que B3 en avait créé une douzaine. Chaque `COPY . .` pèse **1,37 Go** — c'est le `node_modules` de l'hôte (§ 4.1) — et le cache tourne à 11–12,6 Go pour une borne de 10 Go. |

> ℹ️ Le contenu compte, pas la date. BuildKit calcule la somme d'un fichier du contexte sans son
> `mtime` : `git status` qui réécrit `.git/index` à l'identique ne casse rien (B0, 41/41 CACHED
> alors que `.git/index` avait été réécrit depuis la construction précédente). `git checkout` et
> `git pull`, eux, **ajoutent une ligne** au journal des références : le contenu change.

### « Même `[api base 2/3] RUN corepack` n'était pas en cache » — non reproduit

Dans toutes les constructions lues ou jouées ce jour (13:32, 17:14, B0–B4, C1–C4), `base 2/3`
est **CACHED à chaque fois**, y compris dans B3, qui rejoue exactement la séquence de `deploy.sh`. La sortie de 13:38 n'existe
plus (le passage de 17:13 a réécrit le même fichier `/root/attente_deploiement_gf.sortie`, et le
journal du guetteur filtre les lignes `#`), donc on ne peut pas la relire. Deux éléments pèsent
contre une base rejouée :

- l'image que le passage de **12:11** a mise en service porte la couche `corepack` du 20/08 ;
- les lignes `#N [api base 1/3] FROM docker.io/library/node:20-alpine@sha256:…` **n'affichent
  jamais « CACHED »** (elles disent `resolve … done` puis `DONE 0.1s`). Qui cherche les étapes
  non cachées les voit passer en tête de liste.

Les ≈ 4 min de 13:38 s'expliquent entièrement par l'étape builder (B3 : 181 s ; 17:14 : 3 min 41 s).

## 3. L'expérience — 30/09, 18:38 → 18:44 UTC

Script `/root/essai-cache-buildkit/essai.sh` (lancé en `setsid nohup`, `timeout` devant chaque
`docker`). Chaque construction est **la commande exacte de `deploy.sh`**
(`docker compose --env-file .env.prod -f docker-compose.prod.yml build`), sur `ba041c2d` — le
commit déjà en production. **Aucun conteneur n'a été recréé** ; `tracky-api:latest` et
`tracky-web:latest` ont été reconstruits sur ce même commit (`:en-service` protège les images qui
tournent, V42).

| Étape | Ce qui a changé juste avant | Durée | CACHED | Rejoué |
|---|---|---|---|---|
| B0 | rien depuis la construction de 18:09 (`.git/index` réécrit à l'identique) | 35 s | 41/41 | — |
| B1 | rien | 7 s | 41/41 | — |
| B2 | **facteur D** : `docker tag` + `docker rmi` × 3 (comme `etiqueter_repli`), + une vraie image `FROM node:20-alpine` construite puis supprimée | 7 s | 41/41 | — |
| B3 | **facteur G** : `git checkout -q main && git pull --ff-only origin main` → `.git/logs/HEAD` et `.git/ORIG_HEAD` changés | **181 s** | 31 | `COPY . .` api et web (35 s), `tracky-shared build` × 2, `prisma generate`, build api 76 s, build web 91 s |
| B4 | rien (`.git` identique à B3) | **119 s** | 33 | web : `COPY . .` 47 s, `tracky-shared build`, build web 57 s — éviction par le GC |

## 4. Deux constats de plus, même cause

### 4.1 Le `node_modules` de l'hôte recouvre celui de l'image — la production sert Angular 20.3.18

`/opt/vizyo-tracky` porte un `node_modules` de **960 Mo**, installé le **13/05/2026** avec un
lockfile qui n'est plus celui du dépôt (`node_modules/.pnpm/lock.yaml` ≠ `pnpm-lock.yaml`). L'étape
builder fait `COPY --from=deps …` (le `pnpm install --frozen-lockfile` de l'image), **puis**
`COPY . .` — qui pose les liens et les dossiers de l'hôte **par-dessus**.

| | Lockfile du dépôt | `node_modules` de l'hôte (13/05) | Servi en production |
|---|---|---|---|
| `@angular/core`, `common`, `router`, `forms`… | **20.3.27** | 20.3.18 | **20.3.18** |
| `@angular/build`, `@angular/cli` | 20.3.33 | 20.3.22 | (outil de build : 20.3.22, déduit) |
| `@angular/service-worker` | 20.3.27 | 20.3.19 | **20.3.19** |

Lu dans le bundle servi par `tracky-web` **et** `tracky-demo-web` (image `898882f13f38`) : `"20.3.18"`
et `"20.3.19"` présents, `"20.3.27"` absent. Côté API, les 55 liens de
`apps/api/node_modules` posés par l'hôte sont identiques à ceux de l'image, et aucune dépendance
directe de l'API n'a changé de version entre les deux lockfiles (les 9 ajoutées depuis mai viennent
de l'installation de l'image) : pas de dérive de version côté API. En revanche
`/app/node_modules/.pnpm` porte **343 paquets orphelins** venus de l'hôte : 1 206 paquets et
1,24 Go au lieu de 863 et 0,77 Go.

### 4.2 Des secrets et des sauvegardes dans les couches intermédiaires

Le contexte contenait aussi `.env`, `deploy/vps/.env.prod`, `deploy/vps/.env.demo` et `backups/`.
`COPY . .` les écrivait dans l'étape builder, donc dans le **cache de construction du VPS**. Les
images finales ne les contiennent pas (l'étape runtime ne copie que des chemins précis), mais un
secret n'a rien à faire dans une couche, même intermédiaire.

Les `dist/` de l'hôte (`apps/api/dist` du 06/06, `packages/shared/dist`) n'avaient, eux, **aucun
effet mesurable** : 0 différence sur les 1 654 fichiers de `apps/api/dist` et les 273 de
`packages/shared/dist` avec ou sans eux (`nest-cli.json` a `deleteOutDir: true`).

## 5. Le correctif

### 5.1 Un `.dockerignore` à la racine du dépôt

Règle : **le contexte = les fichiers suivis par git**. Chaque ligne reprend une catégorie du
`.gitignore` — avec la syntaxe de Docker, où un motif sans `**/` ne vise que la racine
(`node_modules` seul laisserait passer `apps/*/node_modules`). Les deux lignes qui règlent le
cache sont **`.git`** et **`**/node_modules`** ; les autres (sorties de construction de l'hôte,
secrets, sauvegardes, outillage local) sont de l'hygiène. Aucun fichier suivi par git n'est exclu :
vérifié sur `git ls-files` (seuls les quatre gabarits `*.env.example` le sont, et aucune construction
ne les lit).

### 5.2 `deploy.sh` : `contexte_de_construction_sain`

Après le `git pull` (le fichier arrive avec le code), avant la construction : si le `.dockerignore`
manque, ou ne porte plus `.git` et `**/node_modules`, le script le dit — « ⚠️ Contexte de
construction NON PROTÉGÉ (…) ». **Il ne refuse rien** : c'est l'information qui a manqué pendant
quatre mois et demi, pas une garde. Pas de contrôle pour `--marketing-seul` (le site public ne
copie que `lp/public`). `pnpm verif:deploiement` : **180 contrôles, tous verts** (170 avant, 10
nouveaux, dont « le `.dockerignore` du dépôt passe le contrôle »).

### 5.3 Validation sur une copie du dépôt — 30/09, 18:56 → 19:01 UTC

Script `/root/essai-cache-buildkit/correctif.sh`. `rsync` de `/opt/vizyo-tracky` vers une copie
(1,4 Go, **avec** son `.git` de 170 Mo et le `node_modules` de l'hôte : la situation réelle), plus
le `.dockerignore` proposé ; `docker buildx build` des trois Dockerfile vers des images
`essai-cache-*:correctif`, supprimées à la fin avec la copie. Rien n'a été écrit dans
`/opt/vizyo-tracky`.

| Étape | Ce qui a changé juste avant | api | web | lp |
|---|---|---|---|---|
| C1 | nouveau contexte (première fois) | 142 s — contexte **54,5 Mo** | 78 s | 1 s |
| C2 | rien | **3 s**, 26/26 CACHED | **1 s**, 15/15 | 0 s, 2/2 |
| C3 | `git checkout -q main` + `git fetch` dans la copie (`.git` changé) | **1 s**, 26/26 CACHED | **1 s**, 15/15 | 1 s, 2/2 |
| C4 | rien | 2 s, 26/26 | 1 s, 15/15 | 1 s, 2/2 |

`origin/main` avait avancé pendant l'essai (`d6a5cbde`, poussé par une autre session vers 19:00) :
la copie a donc fait `checkout` + `fetch` au lieu d'un `pull`, sans changer son code — `.git` a
changé davantage encore, et C3 est resté entièrement en cache. Cache stable de C2 à C4
(90 enregistrements), plus aucune éviction.

Comparaison avec `tracky-api:latest` (même commit, ancien contexte) :

| | Avant | Avec le correctif |
|---|---|---|
| `apps/api/dist` | 1 654 fichiers | **identiques octet pour octet** |
| `packages/shared/dist` | 273 fichiers | **identiques** |
| `/app/node_modules/.pnpm` | 1 206 paquets, 1,24 Go | 863 paquets, 0,77 Go (les 343 orphelins de l'hôte en moins, aucun en plus) |
| image `tracky-api` | 1,85 Go | **1,24 Go** |
| bundle web | Angular `20.3.18` | Angular **`20.3.27`** (lockfile) |
| `COPY . .` dans le cache | 1,37 Go par image | ≈ 50 Mo |

## 6. Ce que le correctif change en production — à lire avant de déployer

1. **Le bundle web change de dépendances** : Angular 20.3.18 → 20.3.27, et le reste des
   dépendances web selon le lockfile (26 lignes d'écart sur les dépendances directes de
   `apps/web`, dont les dix paquets `@angular/*`). C'est ce que le dépôt réclame, mais ce n'est
   **jamais passé en production**. → **Preview sur la démo d'abord** :
   `git pull` + construction sur le VPS, `up -d` de la démo seule, recette de l'application web,
   **puis** `deploy.sh`.
2. **L'API** : code identique ; 343 paquets orphelins en moins dans `node_modules`. Seule une
   dépendance « fantôme » résolue par le dossier de hissage de pnpm pourrait changer de version —
   aucune n'a été vue, la recette sur la démo le couvre aussi.
3. **La première construction après le correctif rejoue l'étape builder une fois** (≈ 2,5 à
   3,5 min : le contexte a changé de nature). Pré-construire d'abord, comme d'habitude ; ensuite,
   `deploy.sh` après une pré-construction du même commit construit en quelques secondes.

## 7. Incident pendant l'enquête : `docker buildx history ls` fait tomber dockerd

À 18:23:04 UTC, un `timeout 20 docker buildx history ls` (lecture de l'historique des
constructions) a provoqué une **panique de dockerd** :

    panic: runtime error: invalid memory address or nil pointer dereference
    github.com/moby/buildkit/solver/llbsolver.filterHistoryEvents.func1
        …/buildkit/solver/llbsolver/history.go:1074
    github.com/moby/buildkit/control.(*Controller).ListenBuildHistory

systemd l'a relancé à 18:23:07 (actif à 18:23:11). `"live-restore": true` a tenu : **les 38
conteneurs ont continué**, `tracky-api` n'a pas redémarré (démarré à 18:12:57, inchangé),
`/api/health` public en 200, **36 connexions TCP de boîtiers établies** sur le 5023 à 18:25 (le
`docker-proxy` du port a été relancé ; le trafic des boîtiers passe par le NAT du noyau, pas par
lui), et aucune rafale de déconnexions dans le journal de l'API : une seule socket fermée, par un
`ETIMEDOUT` ordinaire, à 18:23:42. Pendant ~7 s, l'API Docker et le DNS embarqué des conteneurs
(127.0.0.11) étaient indisponibles ; aucune erreur n'apparaît dans le journal de l'API.

> 🛑 **Ne jamais lancer `docker buildx history …` sur ce VPS** (Docker 29.1.3, BuildKit v0.26.2,
> buildx v0.30.1) : un enregistrement de l'historique fait planter le tri de la liste, et c'est le
> démon entier qui tombe. Pour le cache, `docker buildx du --verbose` est sûr (utilisé tout au long
> de l'enquête, sans incident) ; pour les étapes d'une construction, sa sortie `--progress plain`.

## 8. Traces sur le VPS

`/root/essai-cache-buildkit/` (hors de l'arbre git ; supprimable à tout moment) : `essai.sh`,
`correctif.sh`, `recouvrement.sh`, `forensique.sh` ; `journal.txt` (B0–B4) et
`journal-correctif.txt` (C1–C4) ; les sorties `build-B*.log` et `build-C*-*.log` ; `du-1827.txt`
(les 78 enregistrements du cache avant l'essai) ; les comparaisons `lock-*.txt`, `liens-*.txt`,
`pnpm-*.txt`, `dist-*.txt`.

## 9. Suites

- ✅ **Correctif déployé** le 01/10/2026 à 00:09 UTC, démo d'abord (§ 6), sans `--force`, à un
  moment sans aucune activité client ni commande moteur.
- ✅ **Règle portée dans `CLAUDE.md`** (commit `b2f4e204`) : jamais `docker buildx history` sur le VPS.
- ✅ **`node_modules` de l'hôte** (961 Mo du 13/05) : aucun processus, aucune tâche de l'hôte ne le
  lisait. **Déplacé**, pas supprimé, dans `/root/archives/vizyo-tracky-node_modules-hote-20260513/`
  (le `LISEZMOI.txt` dit comment le remettre) ; supprimable après le 15/10/2026.
- ✅ **Node 20 en fin de vie** : les images sont passées à Node 24.21.0 (document 40), même déploiement.
- Proposition, non faite : un commit de documentation reconstruit encore l'étape builder, car
  `docs/` est dans le contexte (l'image API embarque `docs/centre-alerte` et `docs/vps-audit`).
  Copier ces deux dossiers dans l'étape runtime directement, et restreindre le `COPY . .` de l'étape
  builder au code, l'éviterait — un remaniement des Dockerfile à valider à part.
