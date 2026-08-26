-- ═══════════════════════════════════════════════════════════════════════════════
-- Collecte du centre d'alerte Tracky — instantané complet, une seule passe.
--
-- Usage (depuis la racine du dépôt, sur le poste local) :
--   ssh root@72.62.26.240 'docker exec -i tracky-postgres psql -U tracky -d tracky_prod -X -A -F "|" -q' < docs/centre-alerte/collecte.sql
--
-- ⚠️ La base est `tracky_prod`, PAS `tracky` ni `vizyo_tracky`. Le fichier
--    /opt/vizyo-tracky/.env est PÉRIMÉ sur ce point (il annonce `vizyo_tracky` sur
--    localhost). La vérité est dans `docker inspect tracky-api` → DATABASE_URL.
-- ⚠️ Les TABLES sont en snake_case (`error_logs`) mais les COLONNES en camelCase
--    et donc à guillemeter ("createdAt"). Un `created_at` échoue.
-- ═══════════════════════════════════════════════════════════════════════════════

\echo ### SECTION volumetrie
-- ARCHIVAGE (22/08) : `resolvedAt` non nul = ligne CLASSEE par un humain. Elle reste
-- en base — « clear » ne supprime rien — mais elle ne compte PLUS comme une erreur
-- active. Un `count(*)` nu confondrait les deux et gonflerait le bilan de tout ce qui
-- a deja ete traite.
--
-- 🔴 TRK-037 (2026-08-26) : `defauts_actifs` est LE chiffre du rapport, pas `actives`.
-- Le niveau `DEGRADATION` marque une dependance tierce degradee dont le repli a FONCTIONNE
-- et dont le proprietaire a accepte la contrepartie : la ligne reste ecrite et consultable,
-- mais personne n'a rien a faire. Le 26/08, **14 des 18 lignes actives** etaient de cette
-- espece (Overpass injoignable) — un exploitant lisait « 18 erreurs » sans pouvoir savoir
-- que 14 n'appelaient aucune action.
-- ⚠️ Ce n'est PAS un correctif qui vide l'ecran : rien n'est supprime ni archive, et
-- `degradations` reste rendu ci-dessous. On NOMME, on ne cache pas.
SELECT count(*) AS total,
       count(*) FILTER (WHERE "resolvedAt" IS NULL)     AS actives,
       count(*) FILTER (WHERE "resolvedAt" IS NULL AND level <> 'DEGRADATION') AS defauts_actifs,
       count(*) FILTER (WHERE "resolvedAt" IS NULL AND level =  'DEGRADATION') AS degradations,
       count(*) FILTER (WHERE "resolvedAt" IS NOT NULL) AS archivees,
       count(*) FILTER (WHERE "createdAt" > now() - interval '24 hours' AND "resolvedAt" IS NULL AND level <> 'DEGRADATION') AS defauts_24h,
       count(*) FILTER (WHERE "createdAt" > now() - interval '24 hours' AND "resolvedAt" IS NULL) AS actives_24h,
       count(*) FILTER (WHERE "createdAt" > now() - interval '24 hours') AS last_24h,
       count(*) FILTER (WHERE "createdAt" > now() - interval '7 days')   AS last_7d,
       min("createdAt") AS plus_ancienne,
       max("createdAt") AS plus_recente
FROM error_logs;

\echo ### SECTION par_source
-- ⚠️ Lire la colonne `level` : `DEGRADATION` (TRK-037) n'est pas un defaut a traiter.
SELECT source, level, count(*) AS n,
       count(*) FILTER (WHERE "resolvedAt" IS NULL) AS actives,
       min("createdAt") AS premiere, max("createdAt") AS derniere
FROM error_logs
GROUP BY 1, 2
ORDER BY n DESC;

\echo ### SECTION erreurs_detail
-- Tout ce que la table contient encore. La retention reelle est de **90 j**, pas 30
-- (mesuree le 22/08 dans le `meta` du cron `logs_purged` : `errorDays: 90`).
-- `context` est tronque : il sert a identifier la page/l'utilisateur, pas a tout relire.
--
-- `etat` distingue ACTIVE de ARCHIVEE, et les actives sortent EN PREMIER. Une ligne
-- classee a deja ete jugee par un humain : elle n'est plus a instruire, mais elle reste
-- LISIBLE — c'est toute la difference entre archiver et supprimer.
SELECT CASE WHEN "resolvedAt" IS NULL THEN 'ACTIVE' ELSE 'ARCHIVEE' END AS etat,
       "createdAt", level, source,
       coalesce(imei, '-')               AS imei,
       coalesce("userId"::text, '-')      AS user_id,
       replace(left(message, 400), E'\n', ' ')            AS message,
       replace(left(coalesce(context::text, '-'), 500), E'\n', ' ') AS contexte,
       coalesce("resolvedAt"::text, '-')  AS archivee_le,
       coalesce("resolvedNote", '-')      AS motif_archivage
FROM error_logs
ORDER BY ("resolvedAt" IS NOT NULL), "createdAt" DESC
LIMIT 200;

\echo ### SECTION disparitions
-- TRK-035 — LE TEMOIN. Une ligne par INSTRUCTION de suppression sur error_logs ou
-- alerts, ecrite par un declencheur PostgreSQL, jamais par le code applicatif.
--
-- POURQUOI CETTE SECTION EXISTE : le 22/08, 73 lignes ont disparu de error_logs en
-- 20,7 h pendant que le cron de retention consignait `errorDeleted: 0` cinq jours de
-- suite. La base ne journalise rien (`log_statement = none`) et un seul role porte
-- DELETE et TRUNCATE : rien ne pouvait nommer l'auteur.
--
-- COMMENT LIRE `origine` — c'est le champ qui tranche :
--   NULL / '(socket locale)' = connexion par socket UNIX, donc un shell DANS le
--                              conteneur : un humain, ou un outil lance a la main.
--   172.23.0.x               = l'API de production.
--   toute autre adresse      = un tiers. A instruire immediatement.
--
-- ZERO LIGNE ICI EST UN BON RESULTAT — mais seulement si les declencheurs existent
-- encore : la section `temoin_arme` juste apres le verifie. Un temoin desarme rend
-- exactement le meme zero qu'une journee sans suppression.
SELECT "createdAt", "tableCible", operation, lignes,
       coalesce("adresseClient", '(socket locale)') AS origine,
       coalesce(application, '-')                   AS application,
       utilisateur, "pidBackend",
       coalesce("plusAncienneSupprimee"::text, '-') AS plus_ancienne_supprimee,
       coalesce("plusRecenteSupprimee"::text, '-')  AS plus_recente_supprimee,
       replace(left(coalesce(requete, '-'), 300), E'\n', ' ') AS requete
FROM disparitions_lignes
ORDER BY "createdAt" DESC
LIMIT 50;

\echo ### SECTION temoin_arme
-- Le controle qui rend la section precedente interpretable. On attend QUATRE lignes :
-- AFTER DELETE + BEFORE TRUNCATE sur error_logs ET sur alerts, toutes `actif = O`.
--
-- Moins de quatre, ou un `moment` a AFTER sur un TRUNCATE, et le temoin est aveugle :
-- un declencheur AFTER TRUNCATE compte une table DEJA VIDEE et rend « 0 ligne ».
SELECT c.relname AS table_surveillee, t.tgname AS declencheur,
       CASE WHEN (t.tgtype & 2) > 0 THEN 'BEFORE' ELSE 'AFTER' END AS moment,
       CASE WHEN (t.tgtype & 8) > 0 THEN 'DELETE'
            WHEN (t.tgtype & 32) > 0 THEN 'TRUNCATE' ELSE '?' END AS evenement,
       t.tgenabled AS actif
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
WHERE NOT t.tgisinternal AND t.tgname LIKE 'trg_disparition%'
ORDER BY c.relname, t.tgname;

\echo ### SECTION comptes_disparition
-- La mesure de repli, valable meme si le temoin venait a sauter. L'ecart
-- `ins - del - live` ne doit JAMAIS croitre : il vaut 13 250 depuis le 21/08, et
-- toute hausse signale un TRUNCATE (qui n'incremente pas `n_tup_del`).
SELECT relname, n_tup_ins, n_tup_del, n_live_tup,
       n_tup_ins - n_tup_del - n_live_tup AS ecart_hors_delete
FROM pg_stat_user_tables
WHERE relname IN ('error_logs', 'alerts')
ORDER BY relname;

\echo ### SECTION retention_declaree
-- Ce que la purge dit avoir supprime, de sa propre main. A confronter aux sections
-- ci-dessus : c'est ce `meta` qui a permis, le 22/08, d'ecarter l'application.
SELECT "createdAt", target,
       meta->>'errorDeleted' AS erreurs_supprimees,
       meta->>'wireDeleted'  AS trames_supprimees,
       meta->>'errorDays'    AS retention_erreurs_jours
FROM system_activity_logs
WHERE category = 'RETENTION' AND action = 'logs_purged'
ORDER BY "createdAt" DESC
LIMIT 5;

\echo ### SECTION trackers_failing
SELECT t.imei, coalesce(v.plate, '(sans vehicule)') AS plaque,
       t."fixCommandFailureCount" AS echecs,
       t."desiredFixIntervalS" AS cible_s, t."currentFixIntervalS" AS reel_s,
       t.status, t."lastSeenAt"
FROM trackers t LEFT JOIN vehicles v ON v.id = t."vehicleId"
WHERE t."fixCommandFailing" = true
ORDER BY t."fixCommandFailureCount" DESC;

\echo ### SECTION trackers_offline
-- `jamais_vu` sépare les boîtiers en stock des vraies pannes (cf. TRK-009).
SELECT t.imei, coalesce(v.plate, '(sans vehicule)') AS plaque,
       coalesce(t."lastSeenAt"::text, 'JAMAIS')    AS derniere_trame,
       (t."lastSeenAt" IS NULL AND t."vehicleId" IS NULL) AS jamais_mis_en_service,
       t.status
FROM trackers t LEFT JOIN vehicles v ON v.id = t."vehicleId"
WHERE t.status = 'OFFLINE'
  AND (t."lastSeenAt" < now() - interval '1 hour' OR t."lastSeenAt" IS NULL)
ORDER BY t."lastSeenAt" NULLS FIRST
LIMIT 50;

\echo ### SECTION commandes_en_attente
SELECT tc."createdAt", tc."templateId", tc.status,
       t.imei, coalesce(v.plate, '-') AS plaque,
       round(extract(epoch FROM (now() - tc."createdAt")) / 60) AS age_min,
       coalesce(tc."outcomeReason", '-')                AS motif_envoi,
       coalesce(left(tc."diagnosticHint", 120), '-')     AS indice
FROM tracker_commands tc
JOIN trackers t ON t.id = tc."trackerId"
LEFT JOIN vehicles v ON v.id = t."vehicleId"
WHERE tc.status IN ('PENDING', 'SENT')
  AND tc."createdAt" < now() - interval '10 minutes'
  -- TRK-020 : « en attente » = aucun acquittement D'AUCUNE SORTE. Filtrer sur le seul
  -- `acknowledgedAt` (humain) laissait passer une commande deja acquittee par le boitier.
  AND tc."acknowledgedAt" IS NULL
  AND tc."ackedAt" IS NULL
ORDER BY tc."createdAt" DESC
LIMIT 50;

\echo ### SECTION commandes_sante_7j
-- Angle mort connu (TRK-008) : les FAILED n'apparaissent NULLE PART au centre
-- d'alerte. C'est ici qu'on les voit.
--
-- 🔴 LIRE `reponse_boitier`, PAS `status` (TRK-051, 2026-08-26). Le statut
-- `ACKNOWLEDGED` NE VEUT PAS DIRE « acquitte par le boitier » : depuis PR #111
-- (23/08), la cloture par echeance ecrit ce statut des que la cadence MESUREE
-- rejoint la cadence demandee, en le disant dans `observedResult` (« ... sans
-- accuse de reception du boitier »). Sur 120 ACKNOWLEDGED des 7 derniers jours,
-- **2** portaient une vraie reponse de boitier. Deux passages d'affilee (24 et
-- 25/08) ont failli en conclure que les boitiers repondaient enfin.
--
-- ⚠️ ET COMPARER LE TOTAL, PAS `FAILED` SEUL. Le 23/08, FAILED est tombe de ~72
-- a 15/j en trois jours pendant que ACKNOWLEDGED montait de 0 a 61 : le TOTAL,
-- lui, n'a pas bouge (69 a 79/j sur neuf jours). C'etait un RE-ETIQUETAGE, pas
-- une amelioration. `total_famille` rend la comparaison possible d'un coup d'oeil.
--
-- 🔴 TRK-020 (corrige le 2026-08-26) : `tracker_commands` porte DEUX colonnes
-- d'acquittement de sens OPPOSES, et l'ancienne etiquette « acquittees » ne disait pas
-- laquelle elle comptait :
--   * `ackedAt` / `ackResponse`      = l'accuse de reception DU BOITIER ;
--   * `acknowledgedAt` / `...By`     = un acquittement HUMAIN, parfois de masse (27 lignes
--                                      partagent la meme milliseconde le 04/06).
-- Elles sont desormais nommees et rendues SEPAREMENT. `acquittees_boitier` est la seule
-- qui autorise a dire qu'un boitier a repondu.
SELECT "templateId", status, count(*) AS n,
       count("ackResponse")     AS acquittees_boitier,
       count("ackedAt")         AS horodatage_boitier,
       count("acknowledgedAt")  AS acquittees_humain,
       round(count(*)::numeric / 7, 1) AS par_jour,
       sum(count(*)) OVER (PARTITION BY "templateId") AS total_famille
FROM tracker_commands
WHERE "createdAt" > now() - interval '7 days'
GROUP BY 1, 2
ORDER BY n DESC;

\echo ### SECTION commandes_motifs_7j
SELECT "templateId", coalesce(left("observedResult", 70), '(null)') AS resultat_observe,
       count(*) AS n
FROM tracker_commands
WHERE "createdAt" > now() - interval '7 days' AND status = 'FAILED'
GROUP BY 1, 2
ORDER BY n DESC
LIMIT 15;

\echo ### SECTION cadence_resume
-- LE chiffre à comparer d'un passage à l'autre (à reporter dans `chiffres` du manifeste).
--
-- Seuil = 20 s = `HARD_CAP_MIN_S`, le minimum OFFICIEL du Coban GPS403D. Ce n'est pas un
-- seuil de confort : sous cette valeur, la cible est physiquement intenable et le boîtier
-- ne peut plus JAMAIS converger. Une version antérieure de ce fichier comptait « sous
-- 10 s », un seuil arbitraire qui sous-estimait le phénomène de moitié.
SELECT count(*) FILTER (WHERE "desiredFixIntervalS" < 20) AS cible_sous_minimum_materiel,
       count(*) FILTER (WHERE "desiredFixIntervalS" < 10) AS dont_sous_10s,
       min("desiredFixIntervalS")                          AS cible_la_plus_basse,
       count(*)                                            AS trackers_total
FROM trackers;

\echo ### SECTION cadence_derive
-- Le détail, pour nommer les véhicules concernés.
--
-- ⚠️ CES VALEURS BOUGENT EN PERMANENCE : l'auto-alignement réécrit la cible à chaque
-- épisode, donc la composition de cette liste change d'une heure à l'autre. Un écart entre
-- deux passages n'est PAS une tendance — voir « Dérive ou fluctuation ? » dans la procédure.
SELECT t."desiredFixIntervalS" AS cible_s, t."currentFixIntervalS" AS reel_s,
       count(*) AS boitiers,
       string_agg(coalesce(v.plate, '(sans vehicule)'), ', ') AS vehicules
FROM trackers t LEFT JOIN vehicles v ON v.id = t."vehicleId"
WHERE t."desiredFixIntervalS" < 20
GROUP BY 1, 2
ORDER BY cible_s;

\echo ### SECTION cadence_reelle
-- TRK-048 — émetteurs réellement RAPIDES, mesure fraîche exigée.
--
-- ⚠️ `currentFixIntervalS` n'est recalculé qu'à partir de `lastValidFrameAt` : un boîtier hors
-- champ GPS garde une valeur FIGÉE sur son dernier régime (FS-253-HR le 25/08 : « 1 s »
-- enregistré en émettant à 20 s pile — et le critère de contrôle de TRK-045 est passé pour la
-- mauvaise raison). Une cadence < 20 s implique une trame VALIDE toutes les < 20 s : on n'admet
-- donc ici que les mesures soutenues par une trame valide de moins de 5 min. La colonne
-- `dont_mesure_perimee` compte les VESTIGES — c'est elle qui dit combien le compteur naïf ment.
SELECT count(*) FILTER (WHERE "currentFixIntervalS" < 20
                          AND "lastValidFrameAt" > now() - interval '5 minutes') AS emetteurs_rapides_reels,
       count(*) FILTER (WHERE "currentFixIntervalS" <= 6
                          AND "lastValidFrameAt" > now() - interval '5 minutes') AS dont_a_6s_ou_moins,
       count(*) FILTER (WHERE "currentFixIntervalS" < 20
                          AND ("lastValidFrameAt" IS NULL
                               OR "lastValidFrameAt" <= now() - interval '5 minutes')) AS dont_mesure_perimee,
       count(*) FILTER (WHERE "currentFixIntervalS" IS NOT NULL) AS mesures_totales
FROM trackers;

\echo ### SECTION gps_sans_fix
-- Boîtier vivant (trame récente) mais position figée > 1 h → famille TRK-001.
SELECT t.imei, coalesce(v.plate, '-') AS plaque,
       t."lastSeenAt", t."lastPositionAt", t."lastNoFixAt",
       round(extract(epoch FROM (now() - t."lastPositionAt")) / 3600, 1) AS heures_sans_fix
FROM trackers t LEFT JOIN vehicles v ON v.id = t."vehicleId"
WHERE t."lastSeenAt" > now() - interval '30 minutes'
  AND t."lastPositionAt" < now() - interval '1 hour'
ORDER BY t."lastPositionAt"
LIMIT 30;

\echo ### SECTION fin
