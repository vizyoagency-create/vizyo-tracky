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
SELECT count(*) AS total,
       count(*) FILTER (WHERE "createdAt" > now() - interval '24 hours') AS last_24h,
       count(*) FILTER (WHERE "createdAt" > now() - interval '7 days')   AS last_7d,
       min("createdAt") AS plus_ancienne,
       max("createdAt") AS plus_recente
FROM error_logs;

\echo ### SECTION par_source
SELECT source, level, count(*) AS n,
       min("createdAt") AS premiere, max("createdAt") AS derniere
FROM error_logs
GROUP BY 1, 2
ORDER BY n DESC;

\echo ### SECTION erreurs_detail
-- Tout ce que la table contient encore (rétention = 30 j, cf. TRK-010).
-- `context` est tronqué : il sert à identifier la page/l'utilisateur, pas à tout relire.
SELECT "createdAt", level, source,
       coalesce(imei, '-')               AS imei,
       coalesce("userId"::text, '-')      AS user_id,
       replace(left(message, 400), E'\n', ' ')            AS message,
       replace(left(coalesce(context::text, '-'), 500), E'\n', ' ') AS contexte
FROM error_logs
ORDER BY "createdAt" DESC
LIMIT 200;

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
  AND tc."acknowledgedAt" IS NULL
ORDER BY tc."createdAt" DESC
LIMIT 50;

\echo ### SECTION commandes_sante_7j
-- Angle mort connu (TRK-008) : les FAILED n'apparaissent NULLE PART au centre
-- d'alerte. C'est ici qu'on les voit.
SELECT "templateId", status, count(*) AS n,
       count("acknowledgedAt") AS acquittees,
       round(count(*)::numeric / 7, 1) AS par_jour
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
