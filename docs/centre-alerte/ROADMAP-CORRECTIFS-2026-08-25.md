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
| 1 | Coupe programmée vs véhicule hors champ GPS : présomption de stationnement (parking validé), report honnête ailleurs, alerte de sortie hors horaire | TRK-046 | `fix/trk046-coupe-hors-champ-gps` | ✅ **PR #133 ouverte** — en attente de relecture |
| 2 | Cadence enregistrée périmée : « non mesurable » plutôt qu'un chiffre faux | TRK-048 | `fix/trk048-cadence-perimee` | ✅ **PR #134 ouverte** — en attente de relecture |
| 3 | Seuil anti-fausse-alerte du recalcul calibré sur les positions stockées | TRK-047 | `fix/trk047-seuil-recalcul` | ✅ **PR #135 ouverte** — en attente de relecture |
| 4 | Enquête : journalisation des connexions (volume ×3,4, fenêtre d'enquête) | TRK-035 (volet) | — (enquête) | ✅ **rendue** — 3 remèdes proposés, AUCUN appliqué (décision propriétaire) |

**Aucun merge, aucun déploiement** : les trois PR attendent une relecture humaine. La migration
(`ALTER TYPE "AlertType" ADD VALUE`) part avec la PR #133.

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
| **(a) Stanza logrotate dédiée** `tracky-postgres` (`rotate 14`) | témoin TRK-035 : ~2 semaines de mémoire | ~60-70 Mo de disque, zéro redémarrage — **la plus simple** |
| (b) `application_name=tracky-api` (+ `connection_limit` calibré) dans `DATABASE_URL` | attribution nette ; moins de churn | redémarrage API (à coupler à un déploiement) ; calibrage du pool à mesurer (risque de famine sur les rafales) |
| (c) Statu quo + moisson quotidienne par l'audit | mémoire longue déjà dans les rapports git | aucun — comportement actuel |

## Ce qui reste ouvert par ailleurs (non demandé explicitement dans cette session)

| Fiche | Reste à faire | Notes |
|---|---|---|
| TRK-018 (nº 4) | L'écran « immobilisations non confirmées » — les 314 `SENT_UNCONFIRMED` sont nommées, pas montrées | correctifs 1-3 déjà vérifiés le 25/08 |
| TRK-020 | Deux colonnes d'acquittement ; la collecte lit celle qui ne vient pas du boîtier | bloque l'interprétation des 57 `fix_continuous ACKNOWLEDGED` apparus le 25/08 |
| TRK-021 | `availableVia` n'est lu nulle part : 19 templates SMS-only partent en TCP | gravité 1, ancien |
| TRK-013 / TRK-014 / TRK-016 / TRK-024 | backlog ancien (clôture par échéance, ACK `fix_*`, map-matching, OFFLINE qui survit aux trames) | suivis par l'audit quotidien |
| TRK-035 (moitié restante) | Séparation réelle des rôles PostgreSQL — impossible par `REVOKE` (rôle superutilisateur et propriétaire), chantier avec fenêtre de maintenance | décision/planification propriétaire |

## Ce que le propriétaire doit décider maintenant

1. **Relire et fusionner (ou amender) les PR #133, #134, #135** — puis déployer (la #133 porte
   une migration d'enum, même précédent que TRK-018).
2. **FZ-862-VY n'est toujours pas immobilisé** (l'alerte de blocage court depuis le 24/08
   20:00) : coupe manuelle depuis la fiche boîtier si souhaité — un admin n'est pas soumis à la
   règle du scheduler. Après déploiement, valider le lieu de sa perte (ou laisser
   l'auto-qualification faire à la 2ᵉ occurrence) activera la présomption de stationnement.
3. **Choisir un remède de journalisation** (a/b/c ci-dessus) — recommandation : (a), simple et
   sans redémarrage.

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
