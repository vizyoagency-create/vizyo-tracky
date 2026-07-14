-- INCIDENT 2026-07-14 (14 juillet férié) — la coupe automatique les jours fériés était
-- forcée dès qu'un countryCode était présent (défaut 'FR') → 29/30 véhicules cdef31 coupés
-- toute la journée. On rend ce comportement OPT-IN (défaut FALSE) : par défaut un férié suit
-- les horaires normaux du jour. HAND-WRITTEN, colonne NOT NULL DEFAULT false (aucun backfill).
ALTER TABLE "vehicle_schedules" ADD COLUMN "cutOnHolidays" BOOLEAN NOT NULL DEFAULT false;
