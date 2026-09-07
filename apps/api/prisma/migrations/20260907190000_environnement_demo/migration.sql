-- Environnement de démonstration (2026-09) — docs/environnement-demo/PLAN-2026-09-07.md
--
-- La matière du DIRECT de la démo : une semaine de positions réelles (pseudonymisées),
-- réindexée par jour de semaine ISO et seconde du jour en heure locale. Toutes les dix
-- secondes, le rejeu prend les trames du jour de semaine courant dont la seconde vient de
-- passer et les injecte dans le pipeline d'ingestion NORMAL — trajets, alertes et analyses
-- naissent du produit réel, pas d'une copie.
--
-- En production cette table existe et reste VIDE : seul l'importeur de la démo y écrit, et il
-- refuse d'écrire ailleurs que dans une base marquée « démonstration ».

CREATE TABLE "demo_replay_frames" (
    "id"          SERIAL NOT NULL,
    "imei"        TEXT NOT NULL,
    "weekday"     INTEGER NOT NULL,
    "secondOfDay" INTEGER NOT NULL,
    "lat"         DOUBLE PRECISION NOT NULL,
    "lng"         DOUBLE PRECISION NOT NULL,
    "speedKmh"    DOUBLE PRECISION NOT NULL DEFAULT 0,
    "heading"     DOUBLE PRECISION NOT NULL DEFAULT 0,
    "altitude"    DOUBLE PRECISION,
    "ignition"    BOOLEAN,
    "valid"       BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "demo_replay_frames_pkey" PRIMARY KEY ("id")
);

-- La requête du rejeu : « les trames de CE boîtier, CE jour de semaine, entre deux secondes ».
CREATE INDEX "demo_replay_frames_imei_weekday_secondOfDay_idx"
    ON "demo_replay_frames"("imei", "weekday", "secondOfDay");
