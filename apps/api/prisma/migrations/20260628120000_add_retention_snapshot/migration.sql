-- Sprint 6 — Rétention & archivage des positions.

-- 1) Index sur positions(createdAt) : ancrage de la purge par date d'ajout (heure
--    serveur, fiable). L'index existant (trackerId, timestamp) ne couvre pas une purge
--    GLOBALE par createdAt. IF NOT EXISTS = idempotent : en PRODUCTION l'index est créé
--    `CREATE INDEX CONCURRENTLY` hors-transaction (AUCUN lock) AVANT ce `migrate deploy`,
--    ce qui rend l'instruction ci-dessous un no-op ; sur une base neuve (dev / CI / test)
--    elle le crée ici (table vide ou petite => instantané).
CREATE INDEX IF NOT EXISTS "positions_createdAt_idx" ON "positions"("createdAt");

-- 2) Snapshots de rétention : alimentés par le cron (DataRetentionService), lus par les
--    vues de suivi pour éviter de scanner `positions` (table volumineuse) à chaque lecture.
--    Une ligne `scope='GLOBAL'` + une par flotte.
CREATE TABLE IF NOT EXISTS "retention_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" TEXT NOT NULL,
    "fleetName" TEXT NOT NULL DEFAULT '',
    "activeCount" INTEGER NOT NULL DEFAULT 0,
    "archiveCount" INTEGER NOT NULL DEFAULT 0,
    "toDeleteCount" INTEGER NOT NULL DEFAULT 0,
    "oldestCreatedAt" TIMESTAMP(3),
    "nextDeletionAt" TIMESTAMP(3),
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "retention_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "retention_snapshots_scope_key" ON "retention_snapshots"("scope");
