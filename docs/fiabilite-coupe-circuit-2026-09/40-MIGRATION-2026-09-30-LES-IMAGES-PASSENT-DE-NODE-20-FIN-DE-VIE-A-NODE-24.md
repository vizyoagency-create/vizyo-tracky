# Migration du 30/09/2026 — les images Tracky passent de Node 20 (fin de vie) à Node 24 LTS

> **Statut** : validée en local (constructions, artefacts comparés, tests et démarrage réel sous
> Node 24) ; ✅ **EN PRODUCTION depuis le 01/10/2026 à 00:09 UTC** (commit `5ba42241`), avec le
> `.dockerignore` du document 39.
>
> **Comment, et ce qui a été vérifié** (§ 6) : sauvegarde d'abord (184 Mo, 36 s, par l'unité systemd —
> premier passage réel du nouveau `backup-db.sh`) ; pré-construction en 6 min 10 s, rien recréé ;
> **démo d'abord** — saine en 15 s, Node v24.21.0 dans le conteneur, Angular 20.3.27 au bundle et à
> l'exécution, 0 `DeprecationWarning` ; puis la production par `deploy.sh`, sans `--force`, à 02:08
> heure de Paris, après avoir relu qu'aucun client n'était actif (0 en 60 min), qu'aucune commande
> moteur n'était en cours et qu'aucun passage ne tournait. Après : `node --version` = **v24.21.0** dans
> `tracky-api`, API saine en 11 s sans redémarrage, **35 boîtiers sur 35 reconnectés**, 0 erreur au
> journal et au centre d'alerte. Repli possible : `deploy.sh --repli avant-20261001-0008-b2f4e204`.

## En une phrase

La production tourne sur **Node 20.20.2**, une version en **fin de vie depuis le 30/04/2026** (plus
aucun correctif de sécurité). Les deux Dockerfile passent à **Node 24.21.0** (LTS, fin de vie le
30/04/2028), **épinglée par empreinte**. Rien d'autre dans le dépôt ne dépendait de Node 20.

## 1. Pourquoi Node 24, et pas 22

| Version | Fin de vie | Verdict |
|---|---|---|
| Node 20 | **30/04/2026** — dépassée | ce qui tourne aujourd'hui (`node:20-alpine`, figé en 20.20.2) |
| Node 22 | 30/04/2027 — dans sept mois | une deuxième migration dès le printemps ; et `geoip-lite` l'exclut |
| **Node 24** | **30/04/2028** | la LTS en cours ; toutes les dépendances l'acceptent |

`geoip-lite@2.0.3` (la géolocalisation d'une connexion, module `security`) déclare
**`engines: node >=24.0.0`** : il est installé aujourd'hui sur Node 20 malgré sa déclaration. Mesuré
le 30/09 : sa recherche rend **exactement le même résultat sous Node 20 et sous Node 24**
(`8.8.8.8` → US ; `82.67.153.51` → FR / NOR / Saint-Aubin-lès-Elbeuf ; une IPv6 Free → FR) — son code
d'exécution n'utilise aucune API propre à Node 24, le `>=24` vise ses scripts de mise à jour de base.
**Pas de panne cachée en production**, mais Node 24 est la seule version que tout le lockfile accepte.

## 2. Ce qui dépendait de Node 20 — l'inventaire complet

| Endroit | Avant | Après |
|---|---|---|
| `deploy/vps/Dockerfile.api` (étapes `base` **et** `runtime`) | `FROM node:20-alpine` × 2, tag non épinglé | `ARG NODE_IMAGE=node:24-alpine@sha256:ebfe2f90…` en tête, `FROM ${NODE_IMAGE}` × 2 |
| `deploy/vps/Dockerfile.web` (étape `base`) | `FROM node:20-alpine` | la même `ARG NODE_IMAGE` |
| `.nvmrc` | `20.18.0` | `24.21.0` |
| `package.json` → `engines.node` | `>=20.18.0` | `>=22.12.0` (§ 5) |

Et rien d'autre : pas de CI (`setup-node`), pas d'image Node dans le `docker-compose.yml` de dev,
aucune mention de Node 20 dans `docs/`. `@types/node` (API) reste en `^22` : ce sont des types, un
sous-ensemble de ce que Node 24 offre — l'aligner est un confort, pas une nécessité.

**Une seule `ARG` par Dockerfile, pour une raison** : dans `Dockerfile.api`, l'étape `deps` installe
les dépendances sur l'image de `base`, et l'étape `runtime` les exécute. Deux `FROM` écrits à la main
peuvent diverger ; une seule référence, non.

## 3. Ce qui a été vérifié avant de changer quoi que ce soit

| Point | Constat |
|---|---|
| Les 772 paquets du lockfile qui déclarent `engines.node` | **aucun n'exclut 24.21.0** ; un seul exclut 20 et 22 (`geoip-lite`, § 1). Angular 20.3 : `^20.19 \|\| ^22.12 \|\| >=24` ; Nest 11 : `>= 20` ; Prisma 6.19 : `>=18.18` ; Jest 30 : `… \|\| >=24` |
| Notre code (`apps/`, `packages/`, `scripts/`) | aucune API retirée ou dépréciée entre 20 et 24 (`crypto.createCipher`, `util.is*`, `assert { type }`, `url.parse`, `new Buffer`, `process.binding`, `fs.rmdir` récursif, `SlowBuffer`, `punycode`…) |
| Modules natifs | aucun module compilé par `node-gyp` : `onlyBuiltDependencies` = `@nestjs/core`, `@prisma/engines`, `prisma`, `unrs-resolver` — binaires précompilés ou N-API. Le changement d'ABI (115 → 137) ne touche rien |
| Prisma | pas de `binaryTargets` : le moteur est détecté au `prisma generate`, dans la même image que l'exécution ; Alpine 3.23 → 3.24, `libssl.so.3` des deux côtés |
| corepack | 0.34.6 → **0.36.0**, prépare `pnpm@9.12.0` sans erreur. ⚠️ **corepack n'est plus livré à partir de Node 25** : la migration suivante (Node 26, LTS en octobre 2026) devra remplacer `corepack enable` (par exemple `npm i -g pnpm@9.12.0`) |
| OpenSSL embarqué par Node | 3.0.19 → 3.5.8. Les appels TLS sortants vont à des services modernes (Resend, Stripe, Twilio, WhereverSIM, push web, Vizyo Auth derrière Let's Encrypt) : rien d'ancien attendu, à surveiller sur la démo |

## 4. La validation — Docker du poste, 30/09 (rien sur le VPS)

Docker Desktop 29.1.3, VM de 6 CPU et **4 Go**, sans cache préalable. Les images d'essai portent
le préfixe `essai-node24/`.

### 4.1 Les constructions

| Construction | Résultat |
|---|---|
| API, Node 24 (`Dockerfile.api` modifié) | ✅ 458 s ; `FROM` résolu sur l'empreinte épinglée ; `pnpm install --frozen-lockfile` en 52 s |
| Web, Node 24 (`Dockerfile.web` modifié) | ✅ 114 s ; bundle Angular généré en 57,6 s, aucun avertissement de version de Node |
| Web, Node 20 (Dockerfile de `HEAD`, la référence) | ✅ 106 s |

Deux bruits, sans effet : **pnpm 9.12.0 émet `DEP0169`** (`url.parse()` déprécié) sous Node 24,
pendant `pnpm install` seulement — c'est le gestionnaire lui-même ; et les avertissements de budget
de taille du bundle (`798,84 ko` pour 700) existaient déjà. Un premier essai a échoué sur une coupure
réseau de BuildKit en local (corepack, « Error when performing the request », 10 s) : rejoué, l'étape
passe en 3,1 s, et corepack télécharge pnpm sans erreur sous Node 24 comme sous Node 20.

### 4.2 Ce que Node change aux artefacts : rien

| Artefact | Node 20 (référence) ↔ Node 24 |
|---|---|
| `apps/api/dist` — 1 654 fichiers | **0 différence** (référence : l'image Node 20 mesurée sur le VPS, document 39 § 5.3) |
| `packages/shared/dist` — 273 fichiers | **0 différence** |
| paquets de l'image API — 863 | **0 différence** |
| bundle web — 406 fichiers, hors `ngsw.json` (horodaté) | **0 différence** |

Le passage à Node 24 ne change que le moteur qui exécute : pas un octet de ce qu'on construit.

### 4.3 Les tests, sous Node 24

- **Typecheck** de l'API : ✅. **`packages/shared`** : 19 suites, **423 tests, tous verts**.
- **API, suite complète** (2 workers) : 273 suites sur 277 vertes, **smoke-boot ✅** ; deux tests
  en dépassement de délai (5 s) et deux suites tuées par « Jest worker ran out of memory ».
- **Rejouées seules** (règle de `CLAUDE.md`), les quatre passent sous Node 24 : 57/57, 39/39, 18/18,
  5/5. **Les 277 suites de l'API passent donc sous Node 24.**
- **Pourquoi la mémoire**, mesuré en A/B — les MÊMES fichiers, seul le binaire change :

  | Suite, seule | Node 20 | Node 24 |
  |---|---|---|
  | `agents-locaux-sentinelle.service` | 1 937 Mo de tas, 56 s | 1 918 Mo, **43 s** |
  | `positions.service` | 1 925 Mo, 53 s | 1 907 Mo, **38 s** |

  Deux suites demandent chacune ~1,9 Go de tas : deux à la fois dans une VM de 4 Go débordent,
  **quel que soit Node**. Node 24 consomme autant (un peu moins) et va ~25 % plus vite.

### 4.4 Le plafond de tas de V8 — la marge de l'API en production

Le compose de production le rappelle : V8 dérive son tas de la limite du conteneur. Mesuré :

| Limite mémoire | Node 20 | Node 24 |
|---|---|---|
| VM de 4 Go | 2 007 Mo | 2 151 Mo |
| **`-m 1536m`** (la limite de `tracky-api`) | 792 Mo | **864 Mo** (+9 %) |
| `-m 1024m` | 524 Mo | 560 Mo |

Les chiffres Node 20 recoupent le commentaire du compose (« 524 Mo sous 1 Go, ~768 Mo sous 1,5 Go ») :
sous Node 24, l'API gagne ~70 Mo de tas à limite égale — plus de marge pour les gros passages.

### 4.5 Le démarrage réel de l'image Node 24

Contre une base **PostGIS 16-3.4 vierge** et un Redis 7 jetables, avec l'environnement minimal du
smoke-boot et `NODE_ENV=production` :

- **les 154 migrations** jouées (« All migrations have been successfully applied ») — le moteur de
  schéma Prisma fonctionne sur Alpine 3.24 ;
- « Nest application successfully started », conteneur **healthy en 35 s, 0 redémarrage** ;
- `/api/health` : `{"status":"ok", …, "services":{"database":"connected"}}` — le moteur de requêtes
  Prisma aussi ;
- 1 231 lignes de journal, **0 `DeprecationWarning`** à l'exécution, 5 lignes d'erreur — toutes
  structurelles sans secrets (webhooks Resend et Texto « fail-closed », passerelle SMS en mode noop),
  les mêmes que sur la démo.

### 4.6 Le poste

`pnpm install --frozen-lockfile` sous Node 22.18 avec le nouvel `engines` : ✅, lockfile inchangé.

> ℹ️ **Vu en passant** : écrire dans `docs/` pendant une construction a invalidé `COPY . .` (la cible
> `builder` a rejoué 119 s). `docs/` est dans le contexte parce que l'image API embarque
> `docs/centre-alerte` et `docs/vps-audit` : **tout commit de documentation reconstruit donc l'étape
> builder** (~3 min sur le VPS). Copier ces deux dossiers dans l'étape `runtime` directement depuis le
> contexte, et sortir `docs/` du `COPY . .` de l'étape `builder`, l'éviterait — chantier distinct.

## 5. `engines` : `>=22.12.0`, et pas `>=24`

`engines` ne bloque rien ici — **mesuré** : pnpm 9.12.0 sous Node 20.20.2, face à un projet racine
qui demande `>=22.12.0`, écrit `WARN Unsupported engine` et **termine l'installation** (aucun
`.npmrc` du dépôt ni du poste ne met `engine-strict`). C'est donc une **déclaration**, et elle doit
dire vrai :

- Node 20 est en fin de vie : il sort de la plage ;
- Node 22 reste une LTS maintenue jusqu'au 30/04/2027, et tout y fonctionne — le poste de
  développement tourne en **22.18** (tests verts), l'hôte du VPS a **22.21** ; `>=24` leur vaudrait
  un avertissement à chaque installation, pour rien ;
- 22.12 est le plancher d'Angular 20 sur la ligne 22.

`geoip-lite` dit `>=24`, mais sa recherche fonctionne à l'identique en 20 comme en 24 (§ 1) : sa
déclaration est plus stricte que son code. **Passer le poste en Node 24** reste recommandé — les
tests tournent en local sous 22, la production sous 24 ; ce jour-là, `engines` pourra dire `>=24`.

## 6. Déployer — à lire avant

1. **Avec le `.dockerignore`** (document 39), dans la même prévisualisation : les deux changent ce
   qu'il y a dans les images — Angular 20.3.18 → 20.3.27 d'un côté, Node 20 → 24 de l'autre.
2. **La première construction rejoue tout** : l'image de base change, donc corepack, les deux
   `pnpm install` et les deux builds. Pré-construire d'abord (hors HH:42–46), **puis**
   `deploy.sh --attendre`.
3. **Recette sur la démo** : connexion (et la géolocalisation d'un nouvel appareil), carte et
   positions en direct, agenda, rapport PDF (pdfkit), export Excel (exceljs), notifications push.
   ⚠️ Les courriels PARTENT de la démo.
4. **Après le déploiement**, vérifier l'artefact dans le conteneur, pas `docker ps` :
   `timeout 20 docker exec tracky-api node --version` → `v24.21.0`.
5. **Repli** : `deploy.sh --repli avant-…` — les repères posés par ce déploiement pointent les images
   Node 20.

## 7. Monter de version — la procédure, puisque l'image est épinglée

L'empreinte est **voulue** : un tag qui bouge (`node:24-alpine` est republié toutes les quelques
semaines) ferait rejouer toute l'image à la construction suivante, `pnpm install` compris, sans que
personne ne l'ait décidé — exactement le genre de construction de quatre minutes qui pousse un
déploiement dans HH:42–46 (document 39). Les correctifs de sécurité deviennent donc des commits :

1. `docker pull node:24-alpine` puis `docker image inspect --format '{{index .RepoDigests 0}}' node:24-alpine`
   et `docker run --rm node:24-alpine node --version` — sur le poste, pas sur le VPS ;
2. reporter l'empreinte dans `Dockerfile.api` **et** `Dockerfile.web`, la version dans `.nvmrc` ;
3. pré-construire, prévisualiser sur la démo, `deploy.sh`.

Cadence proposée : à chaque version de sécurité de Node 24, et au moins une fois par mois.
