# Roadmap des correctifs — session du 2026-08-25

> Chantier demandé par le propriétaire après l'audit du 25/08 : corriger TRK-046, TRK-048 et
> TRK-047 sur des branches dédiées avec tests, instruire le volume de journalisation des
> connexions (TRK-035), et repenser le traitement des pertes GPS en lieu validé — un parking
> souterrain n'est pas une panne.
>
> Règles de la session : un lot = une branche = une PR, travail en `git worktree` (dépôt
> partagé), **aucun merge et aucun déploiement sans décision humaine**. Statut `CORRECTIF
> PROPOSÉ` tant que le code n'est pas fusionné ET vérifié sur l'artefact servi.

## Vue d'ensemble

| # | Lot | Fiche(s) | Branche | Statut |
|---|---|---|---|---|
| 1 | Coupe programmée vs véhicule hors champ GPS : présomption de stationnement (parking validé), report honnête ailleurs, alerte de sortie hors horaire | TRK-046 | PR #133 | 🚀 **FUSIONNÉE ET DÉPLOYÉE** le 25/08 09:22 UTC · ⚠️ non exercé, test daté ce soir 18:00 |
| 2 | Cadence enregistrée périmée : « non mesurable » plutôt qu'un chiffre faux | TRK-048 | PR #134 | 🚀 **DÉPLOYÉE ET EXERCÉE** — 5 émetteurs réels / 2 vestiges séparés |
| 3 | Seuil anti-fausse-alerte du recalcul calibré sur les positions stockées | TRK-047 | PR #135 | 🚀 **FUSIONNÉE ET DÉPLOYÉE** · ⚠️ non exercé, test daté à 7 j |
| 4 | Enquête : journalisation des connexions (volume ×3,4, fenêtre d'enquête) | TRK-035 (volet) | — (enquête) | 🚀 **REMÈDE APPLIQUÉ le 25/08** — `rotate 14`, validé à blanc (exit 0) · ⚠️ 1ʳᵉ rotation réelle demain 00:00 UTC |
| 5 🆕 | **Traitement de fond invisible depuis le 24/08** — trouvé en vérifiant le cumul | TRK-049 | `a8300adb` | 🚀 **CORRIGÉ ET DÉPLOYÉ** |

## 🚀 Déploiement du 25/08 — ce qui s'est passé

Les trois PR ont été fusionnées puis déployées à **09:22 UTC**. Séquence et résultats :

| Étape | Résultat |
|---|---|
| Vérification du **cumul** (les 3 lots ensemble, jamais testés ainsi) | 🔴 **1 échec** → TRK-049, voir ci-dessous |
| Après correctif : typecheck · smoke-boot DI · suite API · `ng build` · Karma | ✅ 5/5 · **181 suites / 2 709 tests** · ✅ · 11/11 |
| Build **séquentiel** api puis web (jamais en parallèle sur 2 vCPU) | ✅ codes retour 0 |
| Smoke-boot jetable AVANT bascule | ✅ `SMOKE_OK` — **1 orphelin `api-run` produit et nettoyé** (sans ça : 2ᵉ instance d'API, tous les crons en double) |
| Bascule api + web | ✅ `healthy`, `restarts=0`, `/api/health` ok, base connectée |
| Migration `20260825120000_trk046…` | ✅ appliquée, `rolled_back_at` NULL, valeur d'enum présente en base |
| Marqueurs dans le `dist/` **servi** | ✅ les 8 vérifiés (règle nº 0 : jamais sur le commit) |

### 🆕 TRK-049 — ce que la vérification du cumul a trouvé

La suite complète est passée de « 181 suites vertes » à **un échec** : le garde d'exhaustivité du
catalogue des traitements de fond. Diagnostic : **la campagne TRK-018 du 24/08 avait ajouté un
`@Cron` sans l'inscrire au catalogue**. Vérifié sur la version *servie* d'avant (`f508405`) : le
cron y est, le catalogue ne le revendique pas — **défaut préexistant, garde rouge depuis 24 h**.
La clôture des commandes moteur, cœur même de TRK-018, tournait **invisible** dans
`/admin/background-tasks`.

> 🔑 **Un test de complétude ne protège que si on lit son verdict.** Ce garde avait été écrit le
> 19/08 après *exactement* le même oubli — sur la sonde chargée de détecter les tâches
> silencieuses. Cinq jours plus tard, l'oubli se répète, le garde crie, et le déploiement passe
> outre. Corrigé et déployé dans la foulée.

### ⚠️ Ce qui n'est PAS encore prouvé — et c'est le plus important

**0 `REJECTED_SPEED` depuis la bascule ne prouve rien.** FZ-862-VY a retrouvé son fix à 09:26, et
il est 09:26 UTC — donc dans la plage autorisée : *aucune coupe n'est tentée*. Un compteur à zéro
peut être un capteur éteint.

🗓️ **Le test daté de TRK-046 est la coupe de 18:00 UTC ce soir.** À vérifier au prochain audit :
- un véhicule hors champ **dans un lieu validé** → journal « considéré stationné », **zéro**
  `REJECTED_SPEED`, **zéro** ligne « coupe impossible » ;
- un véhicule hors champ **en lieu inconnu** → report honnête « hors champ GPS depuis N min » ;
- une **sortie en roulant hors plage** → alerte `OFF_SCHEDULE_MOVEMENT`.

Contexte à la bascule : **6 zones parking validées sur 6 véhicules**, **1 véhicule hors champ**.
TRK-047 court sur 7 jours. TRK-048, lui, **est déjà exercé** : FS-253-HR, sans trame valide depuis
18,8 h, porte toujours `1 s` en base (champ volontairement non réécrit) et la nouvelle section
`cadence_reelle` le classe juste — **5 émetteurs rapides réels, 2 vestiges séparés**.

## Lot 1 — TRK-046 et le système « parking souterrain » (spécification validée par le propriétaire)

Le scénario réel : une position toutes les ~20 s ; entre deux positions le véhicule entre dans
un souterrain ; la dernière vitesse connue reste figée (ex. 27,15 km/h) alors que le boîtier est
hors champ GPS. Comportements attendus :

1. **La vitesse ne condamne que si elle est fraîche.** La coupe automatique ne doit plus être
   refusée en boucle sur une vitesse périmée (le bug mesuré : 13 refus en 5 h).
2. **Lieu validé = comportement normal, pas une erreur.** Si la dernière position est dans une
   zone validée « parking souterrain » : le véhicule est **considéré stationné** — affiché
   « off » avec un message explicite, aucune erreur récurrente au centre d'alerte, pas de
   spam de commandes (elles n'atteignent de toute façon pas le véhicule).
3. **Le filet de sécurité est la sortie.** Si le véhicule réapparaît **en roulant** pendant la
   plage où il devrait être coupé → alerte « Véhicule hors champ — roule hors horaire
   autorisé », dédupliquée en base sur 6 h acquittée ou non (même régime persistant que
   GPS_LOST — jamais un anti-répétition en mémoire, leçon TRK-038).
4. **Lieu NON validé = signal réel conservé.** Hors zone validée, la coupe est différée avec un
   message honnête (« hors champ GPS depuis N min »), et l'alerte « coupe impossible » continue
   d'exister — c'est elle qui révèle les vrais problèmes.
5. **Exclusion de sécurité** : un véhicule avec suspicion de coupure d'alimentation (TRK-040)
   n'est jamais « considéré stationné ».

Tests : méthode « le test d'abord, vérifié EN ÉCHEC sur l'ancien code » pour la garde ; instants
figés (leçon TRK-044) pour la fenêtre horaire et la transition sans-fix → fix.

## Lot 2 — TRK-048

`currentFixIntervalS` n'est plus rafraîchi sans fix GPS : un boîtier à 20 s pile est enregistré
à 1 s. Correctif : la valeur devient « non mesurable » quand `lastValidFrameAt` est trop vieux
(péremption relative à la cible), partout où elle est consommée — écrans admin, sélection
d'auto-alignement, balayage de récupération, et sections `cadence_*` du SQL de collecte.
**Ne pas** réécrire le champ : l'information juste est l'absence d'information.

## Lot 3 — TRK-047

`FENETRE_MIN_ALERTE_MS = 60 s` est calibré sur la cadence des trames (20 s) alors que la
grandeur jugée est l'espacement des positions **stockées** (~5 min à l'arrêt, 87 % des trames
étant écartées par l'échantillonnage). Correctif : n'alerter que si la tranche vide est réelle à
l'échelle du stockage (encadrement par des positions rapprochées, et/ou seuil dérivé de la
constante d'échantillonnage à l'arrêt — pas un nombre magique).

## Lot 4 — Enquête journalisation (TRK-035, volet volume) — RENDUE

Le chiffre du matin était bon (~4-5 Mo/j en régime réel), **la causalité était fausse**. Refait
sur une fenêtre de 8 h 29 (2,06 Mo mesurés) :

1. **Chaque connexion écrit DEUX lignes** (`connection received` + `connection authorized`) —
   67 % du fichier. L'estimation de 1,4 Mo/j ne comptait que la sonde `pg_isready`
   (2 880 conn./j) ; l'API en ouvre en réalité **~5-7/min** (~8-10 000/j).
2. **La cause du churn : la configuration Prisma par défaut.** `DATABASE_URL` ne porte ni
   `connection_limit` (pool = 2 × cœurs + 1 = **5**) ni `application_name` (aucune attribution
   possible). Les rafales des crons de 5 min gonflent le pool, le moissonneur interne ferme les
   connexions oisives (~300 s), la rafale suivante rouvre — pics mesurés à 9-14 conn./min sur
   les minutes :10/:20. Structurel, pas une fuite (3 connexions au repos).
3. 🎯 **La pièce subtile : la fenêtre n'a JAMAIS été de ~21 jours.**
   `/etc/logrotate.d/docker-containers` fait tourner **tous** les journaux de conteneurs de
   l'hôte **chaque jour** avec `rotate 3` (+ `copytruncate`, `maxsize 50M`). La fenêtre est de
   3-4 jours pour tout conteneur, **quel que soit le volume** — la hausse ne rétrécit rien.
4. *(Annexe : une requête SQL en ERREUR journalise son STATEMENT complet même avec
   `log_statement=none` — les requêtes ratées de la collecte du matin ont écrit ~630 Ko. Le SQL
   d'audit se teste avant de se lancer ; la nouvelle section `cadence_reelle` l'a été.)*

**Remèdes proposés — décision du propriétaire, rien n'a été touché :**

| Option | Effet | Coût / risque |
|---|---|---|
| **(a) `rotate 14`** — ✅ **APPLIQUÉ le 25/08** | témoin TRK-035 : ~2 semaines de mémoire | ~130-250 Mo de disque sur 45 Go libres, zéro redémarrage |
| (b) `application_name=tracky-api` (+ `connection_limit` calibré) dans `DATABASE_URL` | attribution nette ; moins de churn | redémarrage API (à coupler à un déploiement) ; calibrage du pool à mesurer (risque de famine sur les rafales) — **non appliqué** |
| (c) Statu quo + moisson quotidienne par l'audit | mémoire longue déjà dans les rapports git | aucun — **conservé en complément** |

### ✅ Remède (a) appliqué le 25/08 — mais PAS sous la forme annoncée, et voici pourquoi

La recommandation initiale disait « **stanza dédiée** à `tracky-postgres` ». Testée à blanc avant
toute écriture, elle a été **écartée sur deux mesures** :

| Mesure | Verdict |
|---|---|
| `logrotate -d` avec les deux stanzas | `error: duplicate log entry` → **exit code 1 à chaque passage** |
| Le chemin d'une stanza dédiée | embarque **l'ID du conteneur** |

La seconde est la décisive : au premier `recreate` de `tracky-postgres` (mise à jour, changement
de compose), la stanza pointerait dans le vide, `missingok` l'avalerait **en silence**, et la
fenêtre retomberait à 3 jours **sans que rien ne le signale**. *Un correctif qui se désarme tout
seul est pire que pas de correctif* — et un échec quotidien en code 1 masquerait de vraies pannes.

**Appliqué à la place : `rotate 3` → `rotate 14` sur la stanza générique existante**
(`/etc/logrotate.d/docker-containers`), qui est un **glob** : elle suit le conteneur quel que soit
son ID, et couvre du même coup les 33 conteneurs de l'hôte (l'audit VPS y gagne aussi).

| Contrôle | Résultat |
|---|---|
| Sauvegarde avant modification | `/root/backups-config/docker-containers.avant-rotate14.2026-08-25` |
| `logrotate -d /etc/logrotate.conf` (config entière, à blanc) | **exit 0**, aucune erreur, aucun doublon |
| Règle vue par logrotate | `after 1 days (14 rotations)` |
| Journal de `tracky-postgres` couvert | ✅ |
| Déclencheur | `logrotate.timer` **enabled + active**, dernier passage `SUCCESS` |
| Coût projeté | 11 Mo courants (33 conteneurs) + ~8,7 Mo/génération → **~130 Mo**, jusqu'à ~250 Mo si le rythme actuel de postgres tient. **45 Go libres.** |

⚠️ **Ce qui n'est pas encore prouvé** : la validation est un **essai à blanc**. La première
rotation réelle a lieu **demain 00:00 UTC**. 🗓️ **Test daté** : à partir du 27/08, le journal de
`tracky-postgres` doit porter des fichiers `.log.4` et au-delà — aujourd'hui il s'arrête à `.log.3`.
Si le compte reste bloqué à 3, la ligne n'a pas pris effet.

## Ce qui reste ouvert par ailleurs (non demandé explicitement dans cette session)

| Fiche | Reste à faire | Notes |
|---|---|---|
| TRK-018 (nº 4) | L'écran « immobilisations non confirmées » — les 314 `SENT_UNCONFIRMED` sont nommées, pas montrées | correctifs 1-3 déjà vérifiés le 25/08 |
| TRK-020 | Deux colonnes d'acquittement ; la collecte lit celle qui ne vient pas du boîtier | bloque l'interprétation des 57 `fix_continuous ACKNOWLEDGED` apparus le 25/08 |
| TRK-021 | `availableVia` n'est lu nulle part : 19 templates SMS-only partent en TCP | gravité 1, ancien |
| TRK-013 / TRK-014 / TRK-016 / TRK-024 | backlog ancien (clôture par échéance, ACK `fix_*`, map-matching, OFFLINE qui survit aux trames) | suivis par l'audit quotidien |
| TRK-035 (moitié restante) | Séparation réelle des rôles PostgreSQL — impossible par `REVOKE` (rôle superutilisateur et propriétaire), chantier avec fenêtre de maintenance | décision/planification propriétaire |

## Ce qui reste à décider / à surveiller

1. ✅ ~~Relire et fusionner les PR~~ — **fait le 25/08**, déployé et vérifié sur l'artefact servi.
2. 🗓️ **Lire le verdict du test daté après la coupe de 18:00 UTC** (l'audit de cette nuit le fera).
   FZ-862-VY est ressorti seul ce matin ; son lieu de perte n'a pas encore de zone validée, il
   passera donc au report honnête tant que le lieu n'est pas qualifié.
3. ✅ ~~Choisir un remède de journalisation~~ — **(a) appliqué le 25/08** (`rotate 14`, glob
   générique plutôt que stanza dédiée : voir le pourquoi ci-dessus). 🗓️ À confirmer le 27/08 :
   des fichiers `.log.4` et au-delà doivent apparaître. L'option (b) — `application_name` et
   calibrage du pool dans `DATABASE_URL` — **reste ouverte** : elle exige un redémarrage d'API et
   une mesure dédiée du pool, à coupler à un prochain déploiement.
4. ⚠️ **Chaque redémarrage d'API déconnecte tous les utilisateurs** (`localStorage` perd jeton et
   refresh) — c'est arrivé à 09:22. Défaut préexistant **non instruit** ; il mériterait sa fiche.

## Journal de session

- 2026-08-25 — roadmap créée ; worktree `wt-fix-trk046` posé sur `origin/main` ; exploration du
  code en cours (3 lecteurs parallèles : horaires/coupe, zones GPS, alertes/front).
- 2026-08-25 — **Lot 1 implémenté et testé** (branche `fix/trk046-coupe-hors-champ-gps`) :
  - prédicats purs `presomption-stationnement.ts` (hors champ = GPS_LOST partagé OU silence
    ≥ 90 min ; zone validée = bénigne + nature parking, parité avec le front) ;
  - engine-control : exception TYPÉE `PresumedParkedException` (le cron discrimine par type,
    jamais par texte — revue existante respectée), présomption avant toute coupe SCHEDULER,
    report honnête « hors champ GPS depuis N min » pour les lieux non validés — **plus jamais
    de REJECTED_SPEED sur une vitesse figée** ; découverte en route : le correctif proposé
    par la fiche d'audit (« autoriser la coupe si périmé ») était DANGEREUX — un tunnel ne
    produit aucune position, le scan d'immobilité y est aveugle ; on ne coupe donc jamais à
    l'aveugle un véhicule perdu en mouvement ;
  - schedule-cron : état calme (pas d'alerte « coupe impossible », pas de backoff d'échec,
    clôture des lignes de blocage antérieures, re-vérification 10 min) ;
  - alerte `OFF_SCHEDULE_MOVEMENT` (CRITICAL) + migration enum ; détection de sortie à
    l'ingestion (trou ≥ 10 min + mouvement + signature trames L ou parking validé), filtres :
    plage autorisée, override manuel, RESTORE né pendant l'obscurité ;
  - DTO serveur `presumedParkedZone` (liste + fiche + snapshot, zones chargées en lot) ;
    front : état `PRESUMED_PARKED` « Stationné · parking souterrain » (badge central + fiche,
    vitesse figée remplacée par « À l'arrêt ») ; 4 tables d'alerte front mises à jour ;
  - tests : 6 nouveaux specs engine-control (**4 vérifiés EN ÉCHEC sur l'ancien code**),
    4 cron, 5 ingestion, 6 sortie-hors-horaire, 12 prédicats, 2 alertes — API : 236 tests
    verts sur les suites touchées.
- 2026-08-25 — **Lot 2 implémenté, testé, PR #134 ouverte** : `cadenceMesurePerimee` (3 × la
  mesure, plancher 3 min), « non mesurable » sur les écrans admin, balayage de récupération
  borné par `lastValidFrameAt`, section `cadence_reelle` ajoutée à la collecte (testée sur la
  prod : 4 émetteurs rapides réels en journée, 2 vestiges démasqués).
- 2026-08-25 — **Lot 3 implémenté, testé, PR #135 ouverte** : le trou se juge à l'espacement
  MÉDIAN MESURÉ des positions voisines (3 ×, fail-open vers le signal) ; `STOPPED_THROTTLE_MS`
  exporté comme LA constante de calibrage.
- 2026-08-25 — **Lot 4 rendu** : voir la section dédiée — la fenêtre de 3-4 jours vient du
  logrotate de l'hôte, pas du volume ; 3 remèdes proposés, aucun appliqué.
- 2026-08-25 — référentiel, wiki.json et collecte.sql mis à jour (statuts 🟠 CORRECTIF PROPOSÉ,
  passage « passe de correction », section `cadence_reelle`) ; publication VPS refaite.
- 2026-08-25 — **DÉPLOIEMENT** : 3 PR fusionnées, cumul vérifié (181 suites / 2 709 tests),
  TRK-049 trouvée et corrigée en route, build séquentiel + smoke-boot jetable, api/web basculés,
  marqueurs vérifiés sur l'artefact servi, migration appliquée. Documentation republiée.
- 2026-08-25 — **Remède journalisation appliqué** : `rotate 3` → `rotate 14` sur la stanza
  générique (la stanza dédiée a été testée puis écartée — doublon en exit 1 et fragilité à l'ID
  du conteneur). Sauvegarde posée, config validée à blanc en exit 0. Test daté au 27/08.
