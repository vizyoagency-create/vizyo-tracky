-- LOT D DE LA CONCEPTION RDV V2 (docs/rdv-installation/2026-09-16-CONCEPTION-V2-..., § 3.7-3.8) — 2026-09-17.
-- Synchronisation Vizyo Manager -> Tracky et archivage des societes. ADDITIF : colonnes nullables ou a
-- defaut, un index. L'image precedente lit encore chaque table.
-- Rejoue en entier par `pnpm verif:migrations` avant le push (incident du 17/09 matin).

ALTER TABLE "fleets"
    ADD COLUMN "managedByManagerAt" TIMESTAMP(3),
    ADD COLUMN "archivedAt"         TIMESTAMP(3),
    ADD COLUMN "archivedBy"         TEXT,
    ADD COLUMN "contactPhone"       TEXT;
CREATE INDEX "fleets_archivedAt_idx" ON "fleets"("archivedAt");

ALTER TABLE "users" ADD COLUMN "managedByManager" BOOLEAN NOT NULL DEFAULT false;
