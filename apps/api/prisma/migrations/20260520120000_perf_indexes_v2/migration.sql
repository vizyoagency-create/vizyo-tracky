-- V1.10 (Sprint 2 perf) — Indexes complementaires pour les queries les plus
-- chaudes a 100+ vehicules.
--
-- Pourquoi pas CONCURRENTLY :
--   - Postgres rejette CREATE INDEX CONCURRENTLY dans une transaction. Prisma
--     execute les migrations dans une transaction par defaut.
--   - Les 3 tables touchees (alerts, invitations, engine_control_commands) sont
--     assez petites pour qu'un CREATE INDEX standard verrouille brievement
--     (<1s typiquement). En cas de prod sensible, lancer manuellement la
--     version CONCURRENTLY documentee en commentaire ci-dessous AVANT d'appliquer
--     cette migration, puis re-execute idempotente avec IF NOT EXISTS.

-- 1) alerts(fleetId, severity, createdAt DESC) — KPI dashboard "alertes critiques recentes"
-- Variante concurrente prod :
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "alerts_fleetId_severity_createdAt_idx"
--     ON "alerts" ("fleetId", "severity", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "alerts_fleetId_severity_createdAt_idx"
  ON "alerts" ("fleetId", "severity", "createdAt" DESC);

-- 2) invitations(fleetId) — list par fleet sur /admin/invitations
-- Variante concurrente prod :
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "invitations_fleetId_idx"
--     ON "invitations" ("fleetId");
CREATE INDEX IF NOT EXISTS "invitations_fleetId_idx"
  ON "invitations" ("fleetId");

-- 3) engine_control_commands(trackerId, createdAt DESC) — recherche du dernier
-- CUT/RESTORE depuis vehicles.snapshot et positions.service. L'index actuel
-- [trackerId, status] ne couvre pas l'orderBy createdAt → table sort.
-- Variante concurrente prod :
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "engine_control_commands_trackerId_createdAt_idx"
--     ON "engine_control_commands" ("trackerId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "engine_control_commands_trackerId_createdAt_idx"
  ON "engine_control_commands" ("trackerId", "createdAt" DESC);
