# Déploiement VPS — procédure

> Référencé par `deploy/vps/README.md`. Le déploiement est **manuel** : aucun workflow
> GitHub sur ce dépôt, **pousser ne déploie rien**.
>
> **Serveur** : `ssh root@72.62.26.240`, code dans `/opt/vizyo-tracky`.
> **Adresse publique** : `https://app-tracky.vizyoagency.com`.
>
> **En ligne au 2026-08-11 : `feat/depot-partage` (`68b9e49`).**

## Choisir la branche — elles ne portent pas la même chose

| Branche | Ce qu'elle met en ligne |
|---|---|
| **`feat/depot-partage`** | L'espace dépôt **complet** — rôle DEPOT, isolation, missions, comptes, carte live, historique, documents, lien public de suivi — **plus** le socle B0′. **Aucun** écran de la refonte B-pages. C'est la branche de recette client. |
| `feat/refonte-tracky-v2` | Tout ce qui précède **plus la refonte B-pages, EN COURS**. Des écrans sont refondus, d'autres pas, et le **shell est gardé pour la fin** : la navigation reste celle d'avant pendant que des pages ont déjà changé. |

Dans les deux cas c'est utilisable pour une **recette**, jamais un état « fini ». À dire
aux personnes qui testent, sinon elles remonteront comme défauts des écrans simplement pas
encore faits.

> Les commandes ci-dessous emploient `$BRANCHE`. Le poser une fois évite de déployer
> l'autre branche par inadvertance :
>
> ```bash
> BRANCHE=feat/depot-partage
> ```

## Quatre migrations s'appliquent automatiquement

Elles sont jouées **au démarrage du conteneur api** (`CMD` du `Dockerfile.api`) — donc au
moment du `up -d --build`, sans confirmation :

    20260809180000_add_depot_role_and_missions
    20260809200000_add_mission_event_type
    20260810080000_add_mission_share_links
    20260810120000_surveillance_horaires_locaux

Les trois premières sont additives. **La quatrième convertit des données existantes** :
elle réécrit les horaires de surveillance stockés en UTC vers l'heure locale de la flotte.
Elle est conçue pour ne changer aucune fenêtre de protection, mais c'est une écriture sur
des données réelles — **la sauvegarde n'est pas optionnelle**.

---

## La procédure

### 0. Sauvegarder la base — d'abord, toujours

```bash
sudo BACKUP_DIR=/var/backups/vizyo-tracky bash /opt/vizyo-tracky/deploy/vps/backup-db.sh
ls -lh /var/backups/vizyo-tracky | tail -3
```

Vérifier que le fichier du jour existe et n'est pas vide **avant** de continuer.

### 1. Amener le code sur le VPS

Le VPS suit `main` par défaut. Pour une recette de branche, on la sort explicitement :

```bash
cd /opt/vizyo-tracky
git fetch origin
git checkout $BRANCHE
git pull origin $BRANCHE
git log --oneline -1
```

> ⚠️ Le VPS reste alors **sur la branche**. Un futur `git pull origin main` ne le
> ramènera pas sur `main` : il faudra un `git checkout main` explicite. C'est le principal
> piège de cette option.

### 2. Reconstruire

```bash
cd /opt/vizyo-tracky/deploy/vps
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

**Le `--env-file .env.prod` n'est pas optionnel.** Sans lui, échec sur
`network <vide> declared as external, but could not be found` (cf. `deploy/vps/README.md`).

### 3. Vérifier que l'API a RÉELLEMENT démarré

Un conteneur « up » peut redémarrer en boucle. Trois contrôles.

**a) Aucune erreur de dépendance au démarrage :**

```bash
docker logs tracky-api 2>&1 | grep -icE "UnknownDependencies|Nest can't resolve"
```

→ **0 attendu**.

**b) L'API répond, sur la BONNE adresse :**

```bash
curl -s https://app-tracky.vizyoagency.com/api/health
```

→ **200** et `{"status":"ok",…,"services":{"database":"connected"}}`.

> ⚠️ **`tracky-api.vizyoagency.com` N'EXISTE PAS.** Cette page a longtemps donné ce
> sous-domaine : il ne résout pas en DNS, et la vérification renvoyait `000` sur une API
> parfaitement saine. Corrigé le 2026-08-11 après un déploiement réel. Cf. § « La
> topologie réseau » plus bas — c'est elle qu'il faut avoir en tête, pas une URL apprise
> par cœur.

**c) Les migrations sont passées.** La table est la source de vérité, le journal n'en est
que l'écho :

```bash
docker exec tracky-postgres psql -U tracky -d tracky_prod \
  -tAc "select migration_name, finished_at is not null from _prisma_migrations
        where migration_name >= '20260809' order by migration_name"
docker logs tracky-api 2>&1 | grep -iE "migration|prisma" | tail -20
```

→ les quatre migrations présentes avec `finished_at` renseigné, et
« **All migrations have been successfully applied.** » dans le journal.

> ⚠️ **Ne pas conclure sur un `docker ps` pris pendant la recréation.** Entre l'arrêt de
> l'ancien conteneur et le démarrage du nouveau, `docker ps -a` affiche brièvement
> `tracky-api | Dead` et `…_tracky-api | Created`. C'est transitoire et normal. Attendre
> que `docker compose … up` rende la main (code 0) avant de juger.

---

## La topologie réseau — ce qui a coûté le plus de temps

Trois faits, tous vérifiés sur le VPS le 2026-08-11 :

| | |
|---|---|
| **Proxy frontal** | **Traefik** (conteneur `foodsqan-traefik`), seul à écouter sur 80/443. Il n'y a **pas** de nginx système : `/etc/nginx/sites-enabled/` n'existe pas. |
| **Routage** | Par étiquettes Docker. `Host('app-tracky.vizyoagency.com')` pour le web ; le même hôte **plus** `PathPrefix('/api')`, `/realtime`, `/socket.io` pour l'API, vers son port **3000 interne**. |
| **Port 5023** | C'est le **port TCP Coban** — le protocole des boîtiers GPS. Ce n'est **pas** de l'HTTP : `curl localhost:5023/api/health` ne répondra jamais. Le port 3000 de l'API n'est **pas** publié sur l'hôte. |

Conséquence pratique : **l'API n'est joignable que par Traefik ou depuis le réseau Docker.**
Pour un diagnostic hors Traefik, passer par le conteneur :

```bash
docker exec tracky-api wget -qO- http://localhost:3000/api/health
```

> ⚠️ **Ce VPS est partagé.** Il héberge aussi `maalem`, `dronely`, `vizyo-verify` et
> `texto`, et Traefik appartient à `foodsqan`. Ne jamais redémarrer un service global :
> les commandes de cette page ne visent que les conteneurs `tracky-*`.

---

## La boucle « tester et ajuster »

Une fois la branche sortie sur le VPS, chaque itération se réduit à :

```bash
cd /opt/vizyo-tracky && git pull origin $BRANCHE && cd deploy/vps && docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

Pour un correctif **web seul** (le cas courant pendant B-pages), on peut ne reconstruire
que le front, ce qui évite de rejouer le démarrage de l'API :

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build web
```

## Revenir en arrière

```bash
cd /opt/vizyo-tracky
git checkout main
cd deploy/vps && docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

⚠️ **Le code revient, pas la base.** Les migrations déjà appliquées restent : Prisma ne
les défait pas. Un retour arrière réel sur le schéma passe par la sauvegarde de l'étape 0.
C'est la raison pour laquelle elle est la première étape et non la dernière.

---

## Avant de pousser en recette — la liste courte

- [ ] `pnpm verify` vert (typecheck + smoke + tests API + web)
- [ ] **Le total des tests WEB est affiché**, pas seulement « verify vert »

      > ⚠️ Un `verify` peut être vert alors que la suite web **n'a exécuté aucun test**.
      > Relevé le 2026-08-11 : `platform.spec.ts` employait `jest.fn()` et `it.each` —
      > des API **Jest** — dans une suite **Karma/Jasmine**. `ng test` s'arrêtait sur
      > « Cannot find name 'jest' » AVANT le premier test, sans que l'échec remonte
      > bruyamment. Trois lancements pris pour des dépassements de délai.
      >
      > La preuve, c'est la ligne `TOTAL: <n> SUCCESS`. Pas de total = pas de tests.

- [ ] `pnpm --filter @vizyo/tracky-web exec ng build` vert
- [ ] Aucun secret, aucune clé, aucune URL de développement dans le diff
- [ ] Variables d'environnement vérifiées dans `deploy/vps/.env.prod`, **jamais** dans
      `.env.example` (elles diffèrent : `VIZYO_AUTH_API_URL` vaut une adresse *interne* en
      production — cf. `docs/VERIFIER-AVANT-DE-DEPLOYER.md`)
- [ ] Sauvegarde de la base datée du jour
