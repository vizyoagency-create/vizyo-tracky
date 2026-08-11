# Déploiement VPS — procédure

> Référencé par `deploy/vps/README.md`. Le déploiement est **manuel** : aucun workflow
> GitHub sur ce dépôt, **pousser ne déploie rien**.

## Ce qu'il faut savoir avant de déployer `feat/refonte-tracky-v2`

### 1. La branche n'apporte pas que l'espace dépôt

Au 2026-08-11 elle est **42 commits devant `origin/main`**. Déployer la branche met donc
aussi en ligne :

- le lot **B-kit** (kit partagé refondu : confirmations, `app-zone`, toasts en haut sur
  mobile, palette) ;
- le lot **B-pages, EN COURS** — 24 lignes sur 57. Des écrans sont refondus, d'autres pas
  encore : le **shell est explicitement gardé pour la fin**, donc la navigation est encore
  celle d'avant pendant que certaines pages ont déjà changé.

C'est utilisable pour une **recette**, ce n'est pas un état « fini ». À dire aux personnes
qui testent, sinon elles remonteront comme défauts des écrans simplement pas encore faits.

### 2. Quatre migrations s'appliquent automatiquement

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
git checkout feat/refonte-tracky-v2
git pull origin feat/refonte-tracky-v2
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

Un conteneur « up » peut redémarrer en boucle. Les deux contrôles :

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml logs api --tail 100 | grep -icE "UnknownDependencies|Nest can't resolve"
```

→ **0 attendu**.

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://tracky-api.vizyoagency.com/api/health
```

→ **200 attendu**. Puis vérifier que les migrations sont passées :

```bash
docker logs tracky-api 2>&1 | grep -iE "migration|prisma" | tail -20
```

---

## La boucle « tester et ajuster »

Une fois la branche sortie sur le VPS, chaque itération se réduit à :

```bash
cd /opt/vizyo-tracky && git pull origin feat/refonte-tracky-v2 && cd deploy/vps && docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
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
- [ ] `pnpm --filter @vizyo/tracky-web exec ng build` vert
- [ ] Aucun secret, aucune clé, aucune URL de développement dans le diff
- [ ] Variables d'environnement vérifiées dans `deploy/vps/.env.prod`, **jamais** dans
      `.env.example` (elles diffèrent : `VIZYO_AUTH_API_URL` vaut une adresse *interne* en
      production — cf. `docs/VERIFIER-AVANT-DE-DEPLOYER.md`)
- [ ] Sauvegarde de la base datée du jour
