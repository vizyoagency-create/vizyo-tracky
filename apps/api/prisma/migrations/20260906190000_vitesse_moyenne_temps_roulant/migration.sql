-- ═════════════════════════════════════════════════════════════════════════════════════════
-- « VITESSE MOYENNE » = DISTANCE ÷ TEMPS ROULANT, POUR TOUS LES TRAJETS DÉJÀ EN BASE
-- ═════════════════════════════════════════════════════════════════════════════════════════
--
-- `Trip.avgSpeed` portait la moyenne ARITHMÉTIQUE des vitesses des points GPS. Elle pondère
-- chaque relevé pareil quelle que soit sa durée, donc elle dépend de la cadence du boîtier et
-- non de la conduite. Mesuré sur les 12 314 trajets analysés de la production : elle sort
-- 7,7 km/h EN DESSOUS de la distance ÷ temps roulant (28,7 contre 36,5 de moyenne).
--
-- ⚠️ SANS CETTE REPRISE, LA CORRECTION SERAIT PIRE QUE LE DÉFAUT : les trajets créés après le
-- déploiement porteraient la nouvelle définition et les 16 550 anciens l'ancienne, dans la
-- MÊME colonne, la même liste et la même colonne triable. Deux définitions mélangées sans
-- marqueur, c'est exactement ce que ce lot répare.
--
-- ── LA GARDE DE PLAUSIBILITÉ, ET POURQUOI ELLE EST INDISPENSABLE ICI ─────────────────────
--
-- La distance s'accumule sur TOUS les intervalles ; le temps roulant saute les trous de
-- signal de plus de 5 minutes. Sur un trajet où le boîtier s'est tu EN ROULANT, le numérateur
-- contient des kilomètres dont le dénominateur n'a pas les secondes.
--
-- Un galop d'essai de cette migration, joué en transaction annulée sur la production, s'est
-- arrêté sur la contrainte `trips_avg_speed_in_range` : 23,98 km pour 302 s de roulage
-- observé, soit 286 km/h, sur un véhicule dont la pointe mesurée est de 72 km/h. 31 trajets
-- dépassent 130 km/h de moyenne, 7 dépassent 200.
--
-- On ne compare à aucune vitesse « raisonnable » : couvrir d kilomètres demande au minimum
-- d / (vitesse max du trajet) heures. Si le temps roulant est INFÉRIEUR à ce minimum, il est
-- prouvé incomplet, et l'on retombe sur la durée totale — le seul dénominateur restant qui
-- contienne à coup sûr toutes les secondes des kilomètres comptés. Même règle que
-- `vitesseMoyenneTrajet` dans `common/vitesse-moyenne.ts`.

ALTER TABLE "trips" ADD COLUMN "movingSeconds" INTEGER NOT NULL DEFAULT 0;

-- ── 1. Les trajets analysés : le temps roulant vient de l'analyse ────────────────────────
-- L'analyse est la référence de la règle du temps roulant ; la recalculer ici en produirait
-- une seconde écriture, donc un risque de divergence au premier ajustement de seuil.
UPDATE "trips" t
SET "movingSeconds" = a."movingSec",
    "avgSpeed" = ROUND((
      t."distanceKm" / (NULLIF(
        CASE
          WHEN t."maxSpeed" > 0 AND a."movingSec" < (t."distanceKm" / t."maxSpeed") * 3600
            THEN GREATEST(a."movingSec", t."durationSeconds")
          ELSE a."movingSec"
        END, 0) / 3600.0)
    )::numeric, 2)
FROM "trip_analyses" a
WHERE a."tripId" = t.id
  AND a."movingSec" > 0
  AND t."distanceKm" > 0;

-- ── 2. Les trajets jamais analysés : depuis les positions ────────────────────────────────
-- Même règle du temps roulant, écrite en SQL : un intervalle compte s'il dure entre 0 et
-- 300 s et si l'une de ses deux bornes dépasse 4 km/h. Les positions se rattachent au trajet
-- par le boîtier et la fenêtre de temps — il n'y a pas de `tripId` sur `positions`.
WITH bornes AS (
  SELECT t.id AS trip_id,
         p."timestamp",
         p."speedKmh",
         LAG(p."timestamp") OVER (PARTITION BY t.id ORDER BY p."timestamp") AS prec_ts,
         LAG(p."speedKmh")  OVER (PARTITION BY t.id ORDER BY p."timestamp") AS prec_spd
  FROM "trips" t
  JOIN "positions" p
    ON p."trackerId" = t."trackerId"
   AND p."timestamp" >= t."startedAt"
   AND p."timestamp" <= COALESCE(t."endedAt", t."startedAt")
  WHERE t."movingSeconds" = 0
    AND t."distanceKm" > 0
),
roulant AS (
  SELECT trip_id,
         SUM(EXTRACT(EPOCH FROM ("timestamp" - prec_ts)))::int AS sec
  FROM bornes
  WHERE prec_ts IS NOT NULL
    AND EXTRACT(EPOCH FROM ("timestamp" - prec_ts)) > 0
    AND EXTRACT(EPOCH FROM ("timestamp" - prec_ts)) <= 300
    AND (COALESCE("speedKmh", 0) > 4 OR COALESCE(prec_spd, 0) > 4)
  GROUP BY trip_id
)
UPDATE "trips" t
SET "movingSeconds" = r.sec,
    "avgSpeed" = ROUND((
      t."distanceKm" / (NULLIF(
        CASE
          WHEN t."maxSpeed" > 0 AND r.sec < (t."distanceKm" / t."maxSpeed") * 3600
            THEN GREATEST(r.sec, t."durationSeconds")
          ELSE r.sec
        END, 0) / 3600.0)
    )::numeric, 2)
FROM roulant r
WHERE r.trip_id = t.id
  AND r.sec > 0;

-- ── 3. Les analyses portaient la même aberration ─────────────────────────────────────────
-- `TripAnalysis.avgSpeedKmh` alimente le RÉCIT du trajet : sans cette ligne, le texte publié
-- continuerait d'annoncer 286 km/h de moyenne là où la fiche en affiche 46.
UPDATE "trip_analyses" a
SET "avgSpeedKmh" = ROUND((
      a."distanceKm" / (NULLIF(
        CASE
          WHEN a."maxSpeedKmh" > 0 AND a."movingSec" < (a."distanceKm" / a."maxSpeedKmh") * 3600
            THEN GREATEST(a."movingSec", a."durationSec")
          ELSE a."movingSec"
        END, 0) / 3600.0)
    )::numeric, 2)
WHERE a."movingSec" > 0
  AND a."distanceKm" > 0
  AND a."maxSpeedKmh" > 0
  AND a."movingSec" < (a."distanceKm" / a."maxSpeedKmh") * 3600;

-- ── 4. Ce qui reste sans temps roulant : la durée totale, comme le fait le code ───────────
--
-- 3 546 trajets — un cinquième de la base — n'ont ni analyse ni positions : elles ont été
-- purgées par la rétention. Leur temps roulant est donc inconnaissable.
--
-- ⚠️ ON NE MET PAS ZÉRO. Un « 0 km/h » à côté de « 23 km · 45 min » se lit comme une panne
-- d'affichage, et pousse à douter des chiffres voisins, qui sont justes. On applique la MÊME
-- règle que `vitesseMoyenneTrajet` : quand le temps roulant ne peut pas servir de
-- dénominateur, on prend la durée totale — le seul dénominateur restant qui contienne à coup
-- sûr toutes les secondes des kilomètres comptés. La moyenne est alors un peu basse (les
-- arrêts y sont inclus), mais elle est cohérente avec ce que le code produirait, et un
-- gestionnaire peut la refaire de tête.
--
-- ⚠️ ET LE CODE ET LA MIGRATION DOIVENT S'ACCORDER : une reprise qui écrit 0 là où le service
-- écrirait 38 recréerait, à l'intérieur de la même colonne, les deux populations que ce lot
-- existe pour fusionner.
UPDATE "trips"
SET "avgSpeed" = ROUND((("distanceKm" / (NULLIF("durationSeconds", 0) / 3600.0)))::numeric, 2)
WHERE "movingSeconds" = 0
  AND "distanceKm" > 0
  AND "durationSeconds" > 0;

-- Sans durée NI distance, il n'y a rien à diviser : la moyenne ne veut plus rien dire.
UPDATE "trips"
SET "avgSpeed" = 0
WHERE "movingSeconds" = 0
  AND ("distanceKm" <= 0 OR "durationSeconds" <= 0)
  AND "avgSpeed" <> 0;
