# Incident du 17/09/2026 — une migration ratée a tenu l'API à terre 56 min : 28 véhicules coupés au réveil

> **Cause racine : une erreur de préparation, entièrement de mon fait** (Claude, session du lot A des RDV).
> Le fichier de migration portait un bloc en double et n'avait jamais été rejoué de bout en bout.
> Conséquence : l'API a refusé de démarrer de **04:56 à 05:52 UTC** (06:56 → 07:52 Paris), et comme
> c'est elle seule qui envoie les reprises du coupe-circuit à l'ouverture des plages du matin,
> **les véhicules ne démarraient pas**. Tout est rentré dans l'ordre à 06:07 UTC. Ce document dit
> ce qui s'est passé, minute par minute, et ce qui empêche désormais que ça se reproduise.

---

## 1. Chronologie (UTC ; Paris = UTC + 2)

| Heure | Fait | Source |
|---|---|---|
| 04:46:44 | `deploy.sh --attendre` lancé pour le lot A (`5e9d613e`). Un passage d'automatisation tourne : le script patiente. | `/tmp/deploy-lot-a.log` |
| 04:47:47 | Passage terminé, construction des images (≈ 8 min). | idem |
| 04:56:31 | Recréation du conteneur `tracky-api`. Son démarrage joue `prisma migrate deploy`. | idem |
| 04:56:35 | La migration `20260917090000_rdv_lot_a_…` **échoue** : `constraint "installation_bookings_fleetId_fkey" … already exists` — le fichier créait la contrainte **deux fois**. Postgres annule la transaction : **rien n'est appliqué**. Prisma marque la migration « échouée ». | `_prisma_migrations.logs` |
| 04:56:32 | Le script écrit « Déploiement terminé » avec l'API en `health: starting`. **Il ne regarde pas si elle devient saine.** | log du script |
| 04:56 → 05:52 | `tracky-api` redémarre en boucle : `Error: P3009 — migrate found failed migrations… new migrations will not be applied` puis sortie, ×∞ (`Restarting (1)`). **Aucune reprise du coupe-circuit n'est envoyée.** | `docker logs` |
| 04:50 → 05:51 | Mon guetteur (`until pgrep -f deploy.sh…`) **se surveillait lui-même** (sa propre ligne de commande contenait le motif) : il n'a jamais rendu la main. Je suis resté aveugle. | transcription |
| 05:51 | Le propriétaire : « URGENT LES VOITURES NE DÉMARRENT PAS ». | — |
| 05:52:34 | Migration marquée « annulée » (`rolled_back_at`), puis **`deploy.sh --repli avant-20260917-0447-87ae29c9`** : conteneur sain en 20 s, 0 redémarrage. | log, `docker inspect` |
| 05:53 | L'API calcule d'un coup les 28 transitions en retard (« Schedule transition → RESTORE ») et les envoie : 22 acquittées par SMS en 6 min. | `docker logs`, `engine_control_commands` |
| 06:03 | Relance manuelle par l'API des 5 RESTORE encore non acquittés (réarmement des intentions parquées). | script `relancer-restore.js` |
| 06:06:56 / 06:06:59 | BP-434-RD et HD-584-BF (« TCP seul », SIM injoignable par SMS) se reconnectent ; RESTORE envoyée en TCP, acquittée en ≈ 330 ms. | `docker logs` |
| 06:08 | **29 RESTORE sur 29 acquittées, 0 coupure en vol.** | `engine_control_commands` |

Effet secondaire vu ensuite : la page Horaires d'un onglet resté ouvert affichait « 2 coupés » (CDEF) alors que
tout était rallumé — les événements de reprise avaient échappé à l'onglet pendant la panne, et l'overlay
temps réel passait avant la ligne relue. Corrigé (§ 4.4).

---

## 2. Pourquoi le fichier était faux, et pourquoi personne ne l'a vu

1. **Un script de patch joué deux fois.** Après un `prisma format` intempestif (qui réécrit tout le schéma),
   j'ai refait le schéma depuis `HEAD` et rejoué mes deux scripts de patch ; le second a **ré-ajouté** au
   fichier de migration le bloc `fleetId_fkey` + `visits.fleetId nullable`, déjà présent. Le point d'ancrage
   de la substitution était encore unique, la substitution est passée.
2. **Jamais rejoué de bout en bout.** Sur la base de dev, la migration avait été appliquée AVANT ce patch ;
   j'ai passé les deux instructions ajoutées à la main et recalé la somme de contrôle Prisma. Le fichier
   complet — celui que la prod allait jouer — n'a été exécuté nulle part.
3. **Rien dans `pnpm verify` ne lit le SQL.** `tsc`, Jest, le smoke DI : aucun ne joue une migration.
4. **`deploy.sh` ne vérifiait pas la santé** après recréation, et **migrait au démarrage du conteneur** :
   une migration ratée = un conteneur qui ne démarre pas = plus d'API du tout.
5. **Mon guetteur était faux** (`pgrep -f` qui se trouve lui-même), donc pas d'alerte de mon côté.

---

## 3. Pourquoi ça bloque les voitures

Le coupe-circuit coupe les véhicules hors plage horaire (soir) et **l'API envoie la reprise (`RESTORE`) à
l'ouverture de la plage** (matin), par TCP si le boîtier est connecté, sinon par SMS via le relais Android.
Rien d'autre ne rallume : ni le relais, ni le boîtier de lui-même. Une API morte entre 06:56 et 07:52
Paris, c'est exactement la fenêtre où les conducteurs prennent leur véhicule.

---

## 4. Ce qui empêche la répétition (tout est dans ce dépôt, testé)

### 4.1 `pnpm verif:migrations` — chaque migration se rejoue, et le résultat est comparé au schéma
`scripts/verif-migrations.mjs`, **dans `pnpm verify`** :
- analyse des fichiers : une contrainte / un index / une table / un type créé **deux fois dans le même
  fichier** = échec nommé (c'est le défaut du 17/09 — rejoué sur le fichier fautif, il est attrapé) ;
- rejeu **complet** des 147 migrations sur une base vierge (Postgres de dev, base temporaire supprimée
  après), puis `prisma migrate diff` contre `schema.prisma` : tout écart nouveau est un échec.
  Dette **connue et listée** (`DERIVE_CONNUE`, identique en prod) : cinq valeurs d'`AlertType` jamais
  migrées, un index resté dans les migrations, une précision de type — à résorber par une migration
  dédiée, pas en douce.

### 4.2 `deploy.sh` migre AVANT de recréer le conteneur
`migrer_avant` joue `prisma migrate deploy` **dans un conteneur éphémère de l'image neuve**, pendant que
l'API en place tourne. Échec → **rien n'est recréé**, sortie 3, et la migration est aussitôt marquée
« annulée » (`migrate resolve --rolled-back`) pour qu'un redémarrage de l'API en place ne tombe pas
sur P3009. Au démarrage du conteneur neuf, `migrate deploy` n'a plus rien à faire.

### 4.3 `deploy.sh` attend la santé — sinon repli automatique
`attendre_sante` : après `up -d`, l'API doit être `healthy` sans redémarrage (150 s au plus). Redémarrage,
arrêt, `unhealthy` ou délai dépassé → le journal du conteneur est montré, **le repère posé au départ
redevient `latest`, l'API est recréée, sa santé attendue à nouveau**, sortie 4. Le script ne dit plus
« terminé » sans l'avoir vu ; le journal des déploiements porte `sante` (`healthy`, `repli-auto`, …).

### 4.4 Fenêtre du matin : pas de déploiement entre 05:30 et 09:00 (Paris)
`garde_matin` refuse (sortie 1) au départ et avant la recréation ; `--force` passe outre en le disant ;
un `--repli` n'est jamais retenu (il rétablit le service).

### 4.5 La page Horaires suit la vérité relue
`RealtimeService.seedCutState` réaligne l'overlay « coupé / coupe envoyée » sur chaque rechargement de
la liste (20 s), en laissant la main à un événement WS arrivé pendant la lecture. Trois tests Karma.

### 4.6 Preuves
`bash deploy/vps/deploy.test.sh` : **79 contrôles verts** (20 nouveaux : migration en échec → code 3 sans
`up` ; API qui redémarre → repli automatique, code 4 ; délai dépassé ; `unhealthy` ; repli malade → code 5 ;
fenêtre 05:29 / 05:30 / 09:00 / `--force` / `--repli`). `pnpm verif:migrations` : 147 migrations rejouées en
12 s, schéma conforme. Rejeu de la migration corrigée sur **une copie du schéma de production** (dump
structure + historique `_prisma_migrations`) : appliquée, quatre clés étrangères présentes.

---

## 5. Ce qui reste

- Résorber la dérive connue (§ 4.1) par une migration dédiée, hors urgence.
- Le script de recette prod du lot A (`recette-prod-lot-a.js`) est à rejouer après le redéploiement.
- Règle pour moi : un guetteur ne s'appuie jamais sur `pgrep -f <motif>` qui peut se trouver lui-même ;
  le script de déploiement rend la main **avec** le verdict — c'est ce verdict qu'on attend, en premier plan.
