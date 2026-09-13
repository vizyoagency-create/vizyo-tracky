-- CreateTable
CREATE TABLE "pauses_agents_locaux" (
    "id" UUID NOT NULL,
    "poseeA" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cause" TEXT NOT NULL,
    "motif" TEXT NOT NULL,
    "poseePar" TEXT NOT NULL,
    "jusqua" TIMESTAMP(3),
    "leveeA" TIMESTAMP(3),
    "leveePar" TEXT,
    "notifieeA" TIMESTAMP(3),

    CONSTRAINT "pauses_agents_locaux_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pauses_agents_locaux_leveeA_poseeA_idx" ON "pauses_agents_locaux"("leveeA", "poseeA" DESC);

