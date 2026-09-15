# 25 — Procédure de déploiement du chantier (T47) : téléphone → relais → Tracky, kill-switch `false`

Date : 14 septembre 2026
Statut : **procédure écrite, pas encore jouée.** Rien de ce document n'a été exécuté en production.
À jouer **ensemble**, dans l'ordre, en cochant. Elle remplace les étapes 3 à 5 du document 13
(« migration et déploiement à la main »), contraires à la décision D1.

## 0. Les règles qui ne se discutent pas

1. **Un seul chemin pour Tracky : `deploy/vps/deploy.sh`** (décision D1 du 13/09). Jamais
   `docker compose up` à la main sur la pile de production. Le script pose les repères de repli,
   relit la garde juste avant la recréation, refuse de HH:42 à HH:46, et journalise le conteneur
   créé — un contournement se voit au centre d'alerte.
2. **Rien ne se déploie avant la fusion dans `main`** et ta relecture (règle « pas de fusion
   automatique »). Le VPS fait `git pull --ff-only origin main`.
3. **`ENGINE_AUTOMATIC_CUT_ENABLED=false`** pendant tout le déploiement, les 24 h de preuve et
   le banc. Le passer à `true` est le geste de T54, sur ta décision (T38), fenêtre par fenêtre.
4. **Les 37 plannings restent désactivés** (0/30 CDEF 31, 0/7 MH Cars) jusqu'à T54.
5. **Aucune écriture dans `/opt/vizyo-tracky/docs/`** sur le VPS (arbre git : un fichier modifié
   fait échouer le `git pull` suivant, et le build d'après tourne sur du code périmé en silence).
6. Toute commande ci-dessous se lit **avant** de la lancer ; une vérification qui échoue arrête la
   phase — on ne « continue pour voir ».

## 1. Ce qui est livré

| Dépôt | Branche | Commits | Base |
|---|---|---|---|
| Tracky | `codex/tracky-cutoff-reliability-2026-09-12` | 12 (+ celui de ce document) : `01756db7` … `1aa1e0f9` — T40, T41, T42, T44, T45 | `main` `049d1d11` |
| Relais Texto | `codex/gateway-health-reliability-2026-09-13` | 4 (+ celui de ce document) : `2de94d8`, `2536ea4`, `784d766`, `ae17b34` — T41, T44, T45 | `origin/main` `5199f1f` |

Vérifié le 14/09 : `main` a avancé de trois commits depuis la base (`8f1a6c3e`, `3a76fede`,
`111ead09` — outils et audits) et **aucun fichier n'est touché des deux côtés** : la fusion est
sans conflit. Le rebase se refait au moment de fusionner, avec la suite complète derrière.

Production au 14/09 (08:20 UTC, chantier rdv déployé par le propriétaire) : Tracky `main` `9afdf52a` (sans le chantier coupe-circuit, fusionné ensuite en `08c5fc2d`) ; relais `origin/main` `5199f1f` ; serveur capcom6
**v1.43.0** (`ghcr.io/android-sms-gateway/server`, étiquette `latest` non épinglée — corrigé dans
ce commit, voir §4.3).

## 2. Prérequis — à faire AVANT la fenêtre (J-1 au plus tard)

| # | Quoi | Qui | Preuve attendue |
|---|---|---|---|
| P1 | **T43** : téléphone (ping 60 s, FIFO, délai min 10 s / max 15 s, limite active, SIM 1), anti-veille One UI, webhooks capcom6 en mode **Individual** — **fait le 14/09** (document 33) : ping prouvé de 60 s en 60 s, FIFO, 10/15 s, 60/h, Local server OFF, veille OFF ; reste la lecture après 30 min écran éteint | fait (toi + moi) | 30 min écran éteint : `lastSeen` avance dans `GET /3rdparty/v1/devices` |
| P2 | Relever l'`id` du S21 (`GET /3rdparty/v1/devices`) et le numéro de sa SIM | toi | les deux notés dans le `.env` du VPS (§4.2), jamais dans un document |
| P3 | Choisir le numéro de la preuve quotidienne (`SMS_DAILY_PROOF_RECIPIENT`, recommandé : la SIM du S21) et **l'ajouter à l'allowlist du tenant Tracky** côté relais (entrée manuelle) | toi | `GET /admin/allowlist` du relais le liste |
| P4 | Relire `GET /3rdparty/v1/webhooks` côté capcom6 : `sms:received`, `sms:sent`, `sms:delivered`, `sms:failed` vers `https://<texto>/internal/capcom6/webhook` (posés le 24/08 — **non vérifié** depuis) | toi | quatre entrées ; `sms:cancelled` s'ajoute après §4.3 |
| P5 | Relire les notes de version capcom6 v1.44 → v1.47 (résumé en §4.3) et choisir l'étiquette cible | ensemble | `CAPCOM6_SERVER_TAG` décidé |
| P6 | Ta relecture des deux branches, puis fusion (§3) | toi | PR fusionnées, `origin/main` à jour des deux côtés |
| P7 | Fenêtre choisie : **hors HH:42–HH:46**, hors 04:25–04:50 et 06:25–06:50 (preuves quotidiennes), hors 19:30–22:30 et 04:30–07:30 (fenêtres véhicules, même désactivées : on ne déploie pas quand on devrait surveiller) — un créneau type : **10:00–11:40** | ensemble | date et heure notées |

### 2 bis. Relevé du 14/09 à 10:45 UTC — ce qui change pour la fenêtre d'aujourd'hui

Tout lu **sans rien écrire** (SQL sur `tracky-postgres` et `texto-postgres`, `printenv` du conteneur,
`GET /3rdparty/v1/devices` depuis `texto-relay`).

| Point | Relevé | Conséquence |
|---|---|---|
| 🔴🔴 **Plannings** | `cdef31` : **30 actifs sur 30** (07:00–22:00 Europe/Paris, tous les jours), réarmés par **le gestionnaire de la flotte CDEF31** — `POST /api/fleet-schedules/bulk` à **07:03:16 UTC** (09:03 Paris), deux aperçus juste avant, journal `system_activity_logs` ; `mh cars` : 0 sur 7. Ligne de base `IN_WINDOW` posée au tick de 07:03:15 UTC, aucune commande moteur depuis le 11/09 18:49 | La production (`9afdf52a`) n'a **ni kill-switch ni interlock** (nés dans `01756db7`, jamais déployé). Sans déploiement, le cron **coupe 25 véhicules CDEF31 ce soir à 22:00** avec le code du 11/09 (30 moins 5 boîtiers muets depuis 13–25 j, ignorés par la dormance : FS-253-HR, FS-808-CE, FZ-862-VY, DZ-034-CA, HD-292-SH) et les remet en route demain 07:00 avec ce même code. **L'attendu « 0/30 » de §4.2 est faux aujourd'hui : ne pas s'arrêter dessus, le noter, continuer.** |
| P1 téléphone | `lastSeen` 10:19:29 pour une lecture à 10:20:04 — ping à 60 s tenu depuis 09:40 | rien à faire |
| P2 Device ID | **un seul appareil enrôlé** (`samsung/o1sxeea`) ; le relais fusionné retient l'unique appareil quand `CAPCOM6_DEVICE_ID` est vide (`selection: "single"`) | **facultatif** ; recommandé quand même — l'`id` se lit sur le VPS pendant la fenêtre (commande de §4.2), pas besoin du téléphone |
| P3 numéro de preuve | la SIM du S21 est la **première valeur de `SMS_HEARTBEAT_RECIPIENTS`** du `.env.prod` ; elle figure dans l'**allowlist manuelle** du tenant `tracky` (17 manuelles, 30 synchronisées) ; la preuve hebdomadaire de 07:00 UTC lui a été **remise** ce matin (`sms-heartbeat` SUCCESS, 7 `delivered` sur 24 h côté relais) | **déjà satisfait** : `SMS_DAILY_PROOF_RECIPIENT` = copier cette valeur ; rien à ajouter à l'allowlist |
| P4 webhooks | vérifiés le 14/09 au matin (quatre) | rien à faire |
| P5 version capcom6 | `latest` en place = 1.43.0 | **aujourd'hui : rester en `v1.43.0`** (l'annulation d'un SMS supplanté reste « non supportée », sans casse). Pas de changement de version du serveur un jour de mise en service ; v1.47.4 une autre semaine, dans sa sous-fenêtre |
| P6 fusion | Tracky `08c5fc2d` (#138), relais `724bcb8` (#9) sur `origin/main` ; suivi `5c708c03` | fait |
| P7 créneau | proposé **13:30–15:10 (Paris)**, hors garde et hors fenêtres véhicules ; un **second passage** de `deploy.sh` (kill-switch à `true`, si décidé) **avant 17:30** pour finir avant 19:30 | à confirmer |
| Variables | `.env.prod` : **aucune** `ENGINE_*`, `SMS_DAILY_PROOF_RECIPIENT` absent (normal : elles arrivent avec le chantier) ; `env_file: .env.prod` transmet **tout** au conteneur ; **`NODE_ENV=production`** dans le conteneur → le kill-switch fail-closed s'applique dès le déploiement. Relais : **aucune** `CAPCOM6_*` dans `/opt/vizyo-texto/deploy/vps/.env` ; `relay` ne dépend que de `postgres` → `up -d relay` ne recrée pas `capcom6` | écrire les 13 lignes Tracky et les 7 lignes relais de §4.2, telles quelles |
| SIM de T61 | `sms_logs` ne porte **aucun** sortant Tracky vers HD-584-BF / BP-434-RD depuis 30 j (les tests du matin sont partis du téléphone) | T62 les tiendra pour **joignables** jusqu'à trois échecs enregistrés par Tracky : la première coupe automatique tentera le SMS (refusé au départ, non facturé) — attendu, pas un défaut |

**Ce soir, deux issues, une seule bonne.** (a) Déployer cet après-midi avec `ENGINE_AUTOMATIC_CUT_ENABLED=false` :
à 22:00 les 25 coupes sont **retenues** (une ligne DÉGRADATION par heure, T49), les RESTORE restent servies ;
puis la décision d'armer = un second `deploy.sh --attendre` avec `=true` avant 17:30, et les coupes partent à
22:00 **sous interlock** (preuve < 24 h, téléphone ONLINE, file < 10) avec la remise en route de 07:00 relancée
en TCP à la reconnexion, SMS cadencés, rappel toutes les 15 min. (b) Désactiver de nouveau les 30 plannings
depuis `/fleet-schedules` — le client les réarmera. **Ne rien faire = coupes ce soir sur le code du 11/09.**

## 3. Fusion (toi, après relecture)

Tracky, depuis le PC, sur un worktree propre — jamais `git add -A`, vérifier la branche à chaque pas :

```bash
cd D:/www/vizyo-agency/vizyo-tracky/vizyo-tracky-reliability-sep2026
git fetch origin
git rebase origin/main                      # attendu : sans conflit (vérifié le 14/09)
pnpm verify                                 # typecheck + smoke-boot DI + suites — TOUT vert, sinon stop
git push origin codex/tracky-cutoff-reliability-2026-09-12
# puis la PR vers main sur GitHub, relecture, fusion (merge commit, pas de squash : chaque commit
# raconte un défaut ou un document — la liste est dans la fiche de fusion, doc 34), et enfin :
git fetch origin && git log --oneline -1 origin/main   # noter le sha fusionné : c'est lui que le VPS tirera
```

Relais, même logique : `git rebase origin/main`, `npm test` (5 variables d'environnement à
l'import, cf. README), push, PR, fusion.

⚠️ Avant de fusionner Tracky : retirer du worktree `main` du PC la copie **non suivie**
`docs/fiabilite-coupe-circuit-2026-09/` (12 documents périmés + le 19) — elle masquerait les
vrais fichiers après fusion. `git status` doit être propre.

## 4. Phase A — préparation sur le VPS (ensemble, lecture puis écriture, ~20 min)

### 4.1 Sauvegardes — trois bases, avant toute écriture

```bash
# Tracky (PostgreSQL/PostGIS 16) — le script du timer quotidien, à la main :
bash /opt/vizyo-tracky/deploy/vps/backup-db.sh          # /var/backups/vizyo-tracky/tracky_prod_<horodatage>.sql.gz
# et un dump au format custom, plus rapide à restaurer partiellement :
docker exec tracky-postgres pg_dump -U tracky -Fc tracky_prod > /var/backups/vizyo-tracky/avant-chantier-$(date -u +%Y%m%d-%H%M).dump

# Relais (PostgreSQL 16) :
docker exec texto-postgres pg_dump -U "$TEXTO_PG_USER" -Fc "$TEXTO_PG_DB" > /var/backups/vizyo-texto-avant-chantier-$(date -u +%Y%m%d-%H%M).dump

# Serveur capcom6 (MariaDB 11) — indispensable si l'on change de version (§4.3) :
docker exec capcom6-mysql sh -c 'mariadb-dump -u root -p"$MARIADB_ROOT_PASSWORD" --single-transaction sms' > /var/backups/capcom6-sms-avant-chantier-$(date -u +%Y%m%d-%H%M).sql   # le mot de passe vit dans l'environnement du conteneur, jamais dans la ligne de commande
ls -la /var/backups/ | tail -n 6            # trois fichiers récents, tailles plausibles (jamais 0)
```

### 4.2 Relever l'état, écrire les variables

```bash
# ce qui tourne (à conserver dans les notes de la fenêtre) :
cd /opt/vizyo-tracky && git status --short && git log --oneline -1          # propre, 9afdf52a attendu (ou le sha déployé depuis — journal.jsonl fait foi)
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep -E 'tracky-(api|web)|sms-gateway/server|vizyo-texto'
curl -s -H "Authorization: Bearer $VIZYO_TEXTO_API_KEY" https://<texto>/v1/texto/health | python3 -m json.tool   # provider.version = 1.43.0 attendu

# plannings toujours désactivés :
docker exec tracky-postgres psql -U tracky -d tracky_prod -c "select f.name, count(*) filter (where s.enabled) as actifs, count(*) as total from vehicle_schedules s join vehicles v on v.id = s.\"vehicleId\" join fleets f on f.id = v.\"fleetId\" group by f.name"
#   attendu : 0/30 et 0/7
```

`/opt/vizyo-tracky/deploy/vps/.env.prod` — ajouter (les valeurs sont celles du document 13 ;
**aucune valeur secrète n'est citée ici**) :

```text
ENGINE_AUTOMATIC_CUT_ENABLED=false
SMS_MIN_INTERVAL_MS=15000
SCHEDULE_CUT_QUEUE_INTERVAL_MS=10000
ENGINE_RESTORE_ACK_TIMEOUT_MS=15000
ENGINE_RESTORE_ALERT_AFTER_MS=60000
ENGINE_RESTORE_MAX_SMS_ATTEMPTS=3
ENGINE_RESTORE_TCP_RETRY_MIN=30
ENGINE_MANUAL_RESPONSE_BUDGET_MS=20000
ENGINE_SMS_UNREACHABLE_STREAK=3
ENGINE_TCP_ONLY_RETRY_MIN=5
ENGINE_RESTORE_EXPIRY_MIN=240
ENGINE_CUT_SMS_TTL_S=900
SMS_DAILY_PROOF_RECIPIENT=<le numéro choisi en P3, E.164>
```

`/opt/vizyo-texto/deploy/vps/.env` — ajouter :

```text
CAPCOM6_DEVICE_ID=<id du S21, P2>
CAPCOM6_SIM_NUMBER=1
CAPCOM6_DEVICE_STALE_SECONDS=240
CAPCOM6_DEVICE_OFFLINE_SECONDS=900
CAPCOM6_REQUEST_TIMEOUT_MS=5000
CAPCOM6_SEND_TIMEOUT_MS=9000
CAPCOM6_SERVER_TAG=v1.43.0            # la version qui tourne ; §4.3 la fait changer, pas ce fichier tout seul
```

⚠️ Ces six `CAPCOM6_*` n'atteignaient **pas** le conteneur `texto-relay` avant ce commit (le
compose ne les transmettait pas — mesuré le 13/09 : `CAPCOM6_SIM_NUMBER` absent de son
environnement). Le compose de la branche les transmet désormais.

Tracky : `VIZYO_TEXTO_URL`, `VIZYO_TEXTO_API_KEY`, `VIZYO_TEXTO_WEBHOOK_SECRET`,
`SMS_HEARTBEAT_RECIPIENTS` existent déjà (le relais est en service) — vérifier qu'ils sont
renseignés, ne rien y changer.

### 4.3 Serveur capcom6 : changer de version, ou pas — un choix explicite

État : `latest` en production = **v1.43.0** (02/06/2026). Le registre est à **v1.47.4** (02/09).
`latest` n'était pas épinglé : ce commit fixe `CAPCOM6_SERVER_TAG` (défaut `v1.43.0`), donc un
`docker compose pull` ne change plus de version tout seul. Les étiquettes du registre sont
préfixées `v` (vérifié le 14/09 : `v1.43.0`, `v1.45.0`, `v1.46.1`, `v1.47.4` existent ;
`latest` = `v1.47.4`, même empreinte `sha256:a24c53ac…`).

Ce que les versions apportent au chantier (notes de version relues le 14/09) :

| Version | Ce qui compte pour nous |
|---|---|
| v1.44.0 | `simCards` dans `/devices` → `sim.configuredPresent` (T44) cesse d'être `null` |
| v1.44.4 | migration MariaDB (défaut JSON) |
| v1.44.6 | `lastSeen` mis à jour **par lots** — à observer après montée : la fraîcheur doit encore avancer à chaque ping (T43) |
| v1.45.0 | **annulation d'un message** (`DELETE /3rdparty/v1/messages/{id}`) → T41 devient effective |
| v1.46.1 | `409` sur l'annulation d'un message déjà pris (T41 le traite) |
| v1.46.5 | état `Pending` inscrit dans l'historique |
| v1.47.0 | webhooks **par lots** (option ; laisser `Individual` — le relais ne lit que les événements unitaires) |
| v1.47.1 | refus des numéros en double dans un envoi (on n'en envoie qu'un) |
| v1.47.2 → v1.47.4 | migrations d'index et dénormalisation de la table des messages |

Recommandation : monter à **`v1.47.4`** (= `latest`, douze jours d'exposition publique) **dans une
sous-fenêtre à part, avant le relais**, avec son propre Go/No-Go ; à défaut `v1.46.5` (dernière de
la ligne 1.46, sans les migrations de table de 1.47.x). Les deux donnent l'annulation.

```bash
cd /opt/vizyo-texto/deploy/vps
# 1. sauvegarde MariaDB faite en §4.1 — sinon STOP
# 2. poser l'étiquette
sed -i 's/^CAPCOM6_SERVER_TAG=.*/CAPCOM6_SERVER_TAG=v1.47.4/' .env
# 3. tirer, puis recréer SEULEMENT le serveur et son worker (le relais et les bases ne bougent pas)
docker compose -f docker-compose.vps.yml pull capcom6 capcom6-worker
docker compose -f docker-compose.vps.yml up -d capcom6 capcom6-worker
# 4. vérifier — le serveur applique ses migrations au démarrage : lire ses journaux jusqu'au bout
docker logs --since 5m capcom6-server 2>&1 | tail -n 40           # aucune erreur de migration
curl -s -u "$CAPCOM6_USERNAME:$CAPCOM6_PASSWORD" https://<capcom6>/api/3rdparty/v1/health | python3 -m json.tool   # version 1.47.4, status pass
curl -s -u "$CAPCOM6_USERNAME:$CAPCOM6_PASSWORD" https://<capcom6>/api/3rdparty/v1/devices  | python3 -m json.tool   # le S21 toujours là, lastSeen récent, simCards visibles
curl -s -u "$CAPCOM6_USERNAME:$CAPCOM6_PASSWORD" https://<capcom6>/api/3rdparty/v1/webhooks | python3 -m json.tool   # les quatre webhooks toujours enregistrés
# 5. sur le téléphone : l'application est connectée (FCM/SSE), pas de demande de ré-enrôlement ;
#    puis ajouter le webhook sms:cancelled (même URL, même clé) et refaire la vérification des webhooks.
```

Go de cette sous-fenêtre : `version` attendue, `status: pass`, le S21 dans `/devices` avec un
`lastSeen` qui avance pendant 10 min écran éteint, quatre webhooks (cinq après ajout).
Rollback : `CAPCOM6_SERVER_TAG=v1.43.0`, **restaurer le dump MariaDB** (les migrations de 1.44.4
et 1.47.x ne se déroulent pas à l'envers), `up -d capcom6 capcom6-worker`.

**Non vérifié** : le comportement de l'application Android en face d'un serveur 1.47.x (compatible
par conception du projet, mais la version de l'application du S21 n'a pas été relevée — la relever
en P1, Settings → À propos).

## 5. Phase B — le relais Texto (ensemble, ~10 min, aucune migration de base)

```bash
cd /opt/vizyo-texto && git status --short && git pull --ff-only origin main && git log --oneline -1   # le sha fusionné en §3
cd deploy/vps
docker compose -f docker-compose.vps.yml build relay                 # construit, ne recrée rien
docker compose -f docker-compose.vps.yml up -d relay                  # recrée le relais seul (les bases, capcom6 : inchangés)
docker logs --since 2m texto-relay 2>&1 | tail -n 30                  # « Nest application successfully started », migrations Prisma : aucune nouvelle
curl -s -H "Authorization: Bearer $VIZYO_TEXTO_API_KEY" https://<texto>/v1/texto/health | python3 -m json.tool
```

Go : `operational: true`, `device.state: "ONLINE"`, `device.selection: "configured"`,
`device.selectedId` = l'id du S21, `sim.configuredNumber: 1`, `sim.configuredPresent: true` (ou
`null` si le serveur est resté en 1.43.0), `provider.version` = la version choisie. Un
`selection: "ambiguous"` ou `"missing"` = `CAPCOM6_DEVICE_ID` faux → corriger le `.env`, `up -d
relay`, revérifier. Ne pas passer à Tracky tant que ce verdict n'est pas vert.

Pousser un statut pour voir la chaîne complète : envoyer un SMS de test au numéro de P3
(`POST /v1/texto/send`, corps quelconque), puis dans les deux minutes :
`GET /v1/texto/<id>` = `delivered`, et côté relais `select status, "callbackUrl" from
webhook_deliveries order by "createdAt" desc limit 3` doit montrer une livraison `delivered` vers
`<callbackUrl>/status` — elle sera refusée par Tracky **tant que Tracky n'est pas déployé**
(`found:false` n'est pas une erreur ; la signature, elle, doit passer : pas de ligne
« signature HMAC invalide » au centre d'alerte).

Rollback : `git checkout 5199f1f && docker compose -f docker-compose.vps.yml build relay && up -d
relay` (le schéma de base n'a pas changé : aucune migration dans les quatre commits).

## 6. Phase C — Tracky (ensemble, ~30 min hors garde)

### 6.1 Tirer le code et construire — sans rien recréer

```bash
cd /opt/vizyo-tracky && git status --short                                  # PROPRE, sinon STOP (docs/ modifié = piège CLAUDE.md)
git pull --ff-only origin main && git log --oneline -1                      # le sha fusionné en §3
cd deploy/vps
docker compose --env-file .env.prod -f docker-compose.prod.yml build api    # ~5 min ; pas un déploiement : rien n'est recréé
```

### 6.2 La migration rejouée sur une COPIE de la production — avant de toucher à la vraie

La migration `20260912110000_engine_delivery_reliability` porte un horodatage **antérieur** aux
trois migrations `20260913*` déjà déployées. Vérifié le 14/09 sur un PostgreSQL local avec le
**même Prisma (6.19.3)** : `migrate status` la voit « not yet applied » et `migrate deploy`
l'applique après les deux autres, sans erreur ni plainte de dérive (`_prisma_migrations` :
`20260913140000`, `20260913200000`, puis `20260912110000`). Et son SQL, rejoué **en une
transaction sur 5 000 commandes et 3 000 `sms_logs` existants** (PostgreSQL 18, sans PostGIS —
la copie ci-dessous est le vrai test) : index uniques posés sur des colonnes toutes nulles, index
du worker, contrainte `CHECK` qui refuse un canal inconnu — tout passe.

```bash
# la copie (hors charge : ~1 min pour la base actuelle)
docker exec tracky-postgres createdb -U tracky tracky_copie
docker exec -i tracky-postgres pg_restore -U tracky -d tracky_copie --no-owner < /var/backups/vizyo-tracky/avant-chantier-<horodatage>.dump
# la migration, avec la NOUVELLE image, contre la copie — DATABASE_URL pointe tracky_copie, jamais tracky_prod
docker run --rm --network vizyo-tracky \
  -e DATABASE_URL="postgresql://tracky:<mot de passe du .env.prod>@tracky-postgres:5432/tracky_copie" \
  tracky-api:latest sh -c "pnpm prisma migrate deploy"          # WORKDIR de l'image = /app/apps/api
#   attendu : « Applying migration 20260912110000_engine_delivery_reliability » puis « All migrations have been successfully applied »
docker exec tracky-postgres psql -U tracky -d tracky_copie -c "select migration_name, finished_at from _prisma_migrations order by finished_at desc limit 4"
docker exec tracky-postgres psql -U tracky -d tracky_copie -c "select count(*) from engine_control_commands where \"activeKey\" is not null"   # 0 attendu
docker exec tracky-postgres dropdb -U tracky tracky_copie
```

Un échec ici = **STOP**, on ne déploie pas ; on lit l'erreur sur la copie, jamais sur la
production.

### 6.3 Déployer — par le script, et rien d'autre

```bash
bash /opt/vizyo-tracky/deploy/vps/deploy.sh            # refuse si un passage tourne ou de HH:42 à HH:46 ; --attendre patiente
```

Le script pose les repères `avant-<horodatage>-<sha déployé, 9afdf52a au 14/09>` (noter l'étiquette affichée : c'est
la commande de repli), reconstruit (cache : rapide), relit la garde, recrée `api` et `web`. La
migration s'applique **au démarrage du conteneur** (`prisma migrate deploy && node dist/main.js`).

### 6.4 Vérifier — l'artefact dans le conteneur, pas `docker ps`

```bash
docker ps --format '{{.Names}} {{.Status}}' | grep -E 'tracky-(api|web)'                 # « Up X minutes » : recréés
docker logs --since 5m tracky-api 2>&1 | grep -E "migrate|Applying|successfully applied|API ready|Nest application" | head
docker inspect -f '{{.RestartCount}} {{.State.Health.Status}}' tracky-api                 # 0 healthy
docker exec tracky-api grep -c "ENGINE_RESTORE_TCP_RETRY_MIN" dist/engine-control/engine-control.service.js   # ≥ 1 : le code T42 est DANS l'image (vérifié : 1 en local)
docker exec tracky-api grep -c "sms-daily-proof" dist/sms/sms-heartbeat.service.js                      # ≥ 1 : T45 (vérifié : ≥ 1 en local)
docker exec tracky-postgres psql -U tracky -d tracky_prod -c "select migration_name from _prisma_migrations order by finished_at desc limit 1"   # 20260912110000_engine_delivery_reliability
tail -n 1 /opt/tracky-deploiements/journal.jsonl                                          # la ligne du déploiement
```

Puis dans l'application (super-admin) :

- `/admin` → Tâches de fond : `sms-daily-proof` et `sms-daily-proof-verify` listés, **aucun**
  bandeau « écart runtime/catalogue » ;
- `/admin` → SMS : « Téléphone Android : vu récemment », verdict sur le S21 (`CAPCOM6_DEVICE_ID`),
  SIM 1, dernière remise terminale ;
- centre d'alerte : **30 min sans nouvelle ligne** `sms-gateway-watchdog`, `engine-control-*`,
  `deploiement-hors-script` ; une ligne « déploiement hors script » = le script n'a pas créé ce
  conteneur → comprendre avant de continuer.
- `POST /api/admin/sms/heartbeat/run-now?kind=quotidien` puis, 15 min plus tard,
  `POST /api/admin/sms/heartbeat/verify?kind=quotidien` → `verdict: "OK"` (accusé poussé par le
  relais, ou écho). Un `INDETERMINE` ici veut dire que les statuts n'arrivent pas : vérifier P4 et
  la livraison `webhook_deliveries` côté relais.

Rollback (à tout moment de 6.3/6.4) : `bash deploy.sh --repli avant-<horodatage>-<sha déployé, 9afdf52a au 14/09>`. La
migration **reste** : elle est additive (colonnes nullables ou avec défaut, table neuve), l'ancien
client Prisma ignore les colonnes qu'il ne connaît pas. Ne jamais vider `engine_control_commands`.

## 7. Phase D — 24 h de preuve avant tout canari

| Heure (Paris) | Ce qu'on attend | Où le lire |
|---|---|---|
| 04:30 / 06:30 | envoi de la preuve quotidienne | journal API : « Preuve SMS quotidienne via vizyo-texto — 1/1 acceptee » |
| 04:45 / 06:45 | `verdict=OK` | journal API ; **aucune** ligne `sms-daily-proof` au centre d'alerte |
| en continu | `lastTerminalSuccessAt` < 24 h, `gateway.operational: true`, file < 10 | `GET /api/admin/sms/status` — ce sont les conditions exactes de l'interlock |
| en continu | sentinelle silencieuse | `sms-gateway-watchdog` : 0 ligne en 24 h (T44 + T43) |
| lundi 09:00/09:20 | la preuve hebdo inchangée | `verdict=OK` |

Deux verdicts `OK` consécutifs et une sentinelle muette 24 h = **Go pour le banc (T54)**. Un seul
`INDETERMINE` ou une ligne de sentinelle = on comprend d'abord.

## 8. Phase E — la recette (T54), puis la réactivation (T38)

Document 19 §3 phase 5 et fiche T54 : boîtier de banc (RESTORE TCP avec ACK ; socket coupée →
15 s → SMS ; RESTORE du lendemain — P0-1 ; CUT puis RESTORE rapprochées avec SMS retardé — P0-2 ;
3 SMS refusés puis reconnexion TCP → K acquittée — T42 ; redémarrage de l'API avec une RESTORE en
attente), puis **un** véhicule MH Cars (19:45–20:30), puis **un** CDEF 31 (21:45–22:30),
`ENGINE_AUTOMATIC_CUT_ENABLED=true` **seulement** pendant la fenêtre et remis à `false` après
(changement de `.env.prod` + `deploy.sh` — le kill-switch se lit au démarrage), présence physique,
réactivation par groupes de 3 à 5, surveillance 04:45–05:30 et 06:45–07:30.

## 9. Rollback — résumé

| Couche | Geste | Ce qui reste |
|---|---|---|
| Tracky | `deploy.sh --repli avant-<horodatage>-<sha déployé, 9afdf52a au 14/09>` ; `ENGINE_AUTOMATIC_CUT_ENABLED=false` ; plannings off | migration conservée (additive) ; `engine_control_commands` jamais vidée |
| Relais | `git checkout 5199f1f`, `build relay`, `up -d relay` | base inchangée (aucune migration) |
| capcom6 | `CAPCOM6_SERVER_TAG=v1.43.0` + **restauration du dump MariaDB** + `up -d capcom6 capcom6-worker` | le téléphone se reconnecte seul |
| Téléphone | rien à défaire (les réglages T43 sont sans risque) | — |

## 10. Go / No-Go — la liste à cocher pendant la fenêtre

- [ ] P1–P7 faits ; sauvegardes des trois bases présentes, non vides
- [ ] `git status` propre sur `/opt/vizyo-tracky` et `/opt/vizyo-texto`
- [ ] plannings 0/30 et 0/7 ; `ENGINE_AUTOMATIC_CUT_ENABLED=false` dans `.env.prod`
- [ ] (si montée capcom6) version attendue, `pass`, S21 présent et frais, webhooks présents
- [ ] relais : `operational: true`, `state: ONLINE`, `selection: configured`, SIM 1
- [ ] migration rejouée sur `tracky_copie` sans erreur, copie supprimée
- [ ] `deploy.sh` terminé, repère de repli noté, journal écrit, conteneurs recréés (« Up X minutes »)
- [ ] artefact vérifié dans le conteneur (T42, T45 présents), `_prisma_migrations` à jour, `0 healthy`
- [ ] tâches de fond sans écart ; écran SMS vert ; 30 min sans ligne au centre d'alerte
- [ ] preuve quotidienne `OK` à la main, puis 24 h de preuve (§7)
- [ ] seulement alors : T54

Un seul point non coché : **No-Go**, horaires toujours désactivés, et on note pourquoi.

## 11. Ce que ce document vérifie lui-même, et ce qu'il ne vérifie pas

Vérifié le 14/09, en local, sans toucher à la production :

- ordre des migrations : Prisma 6.19.3 applique `20260912110000` après les `20260913*` déjà
  appliquées (démonstration sur un cluster PostgreSQL 18 privé, détruit ensuite) ;
- le SQL de la migration passe en une transaction sur des lignes existantes, index et contraintes
  posés (même cluster) ;
- `schema.prisma` porte désormais l'index du worker (`map: engine_control_commands_restore_worker_idx`)
  : plus de dérive à la prochaine migration (T53, partie faite) ; `prisma validate` et
  `prisma generate` verts ;
- les étiquettes du registre capcom6 et l'égalité `latest` = `v1.47.4` (empreintes) ;
- aucun fichier touché à la fois par `main` et par la branche.

**Non vérifié** (ne peut l'être qu'en jouant la procédure) : la migration sur la vraie copie
PostGIS 16 ; le comportement du téléphone face à un serveur 1.47.x ; l'auto-envoi S21 → S21 par
Free ; la présence effective des webhooks posés le 24/08 ; le temps de build sur le VPS à 2 vCPU
(le script construit `api` et `web` ensemble — c'est son choix, mesuré fonctionnel les 08 et
09/09).

## 12. Journal de la fenêtre — jouée le 15/09/2026 de 19:20 à 20:15 (Paris)

Pilotée par Claude sur ordre du propriétaire (« fais-le toi, je supervise »), après la nuit du 14 au 15 sur
l'ancien code (24 coupes, 23 reprises, GS-928-NX immobilisé 2 h 56 en silence — le cas que T42/T51 corrigent).
Tout est horodaté en UTC (Paris = UTC+2).

| Heure | Étape | Résultat |
|---|---|---|
| 17:20 | V28 : `kill 159533 159541` | mort ; le build API passe de 32 min (14/09) à **4 min 21** |
| 17:20 | sauvegardes | `avant-chantier-20260915-1720.dump` 161 Mo (25 s), relais 99 Ko, capcom6 `sms` 73 Ko |
| 17:21 | variables | 13 lignes dans `.env.prod` (**`ENGINE_AUTOMATIC_CUT_ENABLED=true` d'entrée**, `SMS_DAILY_PROOF_RECIPIENT` = 1ʳᵉ valeur de `SMS_HEARTBEAT_RECIPIENTS`), 7 `CAPCOM6_*` dans le `.env` du relais (`CAPCOM6_DEVICE_ID` lu sur `/3rdparty/v1/devices`) ; copies dans `/root/.env.prod.avant-chantier-20260915-1721` et `/root/.env.texto.avant-chantier-20260915-1721` |
| 17:21–17:24 | relais | `git pull` → `724bcb8`, `build relay` 159 s, `up -d relay` (capcom6 et postgres intacts), « Nest application successfully started » ; santé : `provider 1.43.0 pass`, `selection: configured`, `sim.configuredNumber 1` — **`device.state: OFFLINE`** (dernier ping 13:49:42 UTC) |
| 17:25–17:29 | Tracky | `checkout main` (l'arbre était resté sur `feat/rdv-installation-v2`), `pull` → `fa9ff1d1` (contient `08c5fc2d`), `build api` 261 s |
| 17:30 | migration sur copie | `tracky_copie` restaurée en 37 s (0 erreur) ; `migrate deploy` applique `20260912110000_engine_delivery_reliability` **et** `20260914150000_rdv_premier_jour_j_plus_1` (arrivée sur `main` le matin) ; `activeKey` non nul = 0 ; copie supprimée |
| 17:31–17:35 | `deploy.sh --attendre` | `sha fa9ff1d1`, 226 s, api + web recréés à 17:35:05 ; migrations appliquées 17:35:10 ; 6 colonnes neuves ; artefact : T42, T45, T62, kill-switch présents ; `NODE_ENV=production` ; `/api/health` 200 ; 33 boîtiers reconnectés en TCP en 30 s |
| 17:35:30 | ⚠️ écart 1 | premier `alertOverdueRestores` : `alertedAt` NULL sur tout l'historique → ~50 RESTORE `FAILED` de juillet-août réveillées, une ligne CRITICAL (FV-941-LZ, 153 j) puis rappel toutes les 15 min (17:50:45, `reminder: true`) — **correctif `0c9672c9`** (borne `createdAt ≥ now − 24 h`, test T51 étendu, 148 verts) |
| 17:37 | ⚠️ écart 2 | `sms-gateway-watchdog` CRITICAL « téléphone hors ligne : dernier ping il y a 13 638 s » — la sentinelle T44 fait son travail ; **le S21 était verrouillé depuis 15:49 Paris** ; débloqué par le propriétaire, ping repris à 17:51:21 UTC |
| 17:41 → 20:15 | redéploiement | `deploy.sh --attendre` a patienté derrière le passage des trajets de 17:45 (garde TRK-077), puis recréé sur `0c9672c9` |

**Repère de repli** : `deploy.sh --repli avant-20260914-1140-9afdf52a` (image `5da87fd11e72`, celle qui tournait
avant la fenêtre). ⚠️ L'étiquette `avant-20260915-1731-fa9ff1d1` posée par le script pointe l'image
**pré-construite** en §6.1, pas l'ancienne : quand on pré-construit, le « avant » du script n'est plus le
« avant » de la production — lire l'ID d'image, pas l'étiquette.

**Ce qui reste à faire ce soir** : la preuve quotidienne à la main (`/admin` → SMS → envoyer, puis vérifier à
+15 min) — sans remise prouvée de moins de 24 h (dernière : 14/09 07:00 UTC), l'interlock retient les coupes de
22:00 ; relectures programmées 22:07 (coupes) et 07:10 (reprises) ; MH Cars s'arme après une nuit propre.
