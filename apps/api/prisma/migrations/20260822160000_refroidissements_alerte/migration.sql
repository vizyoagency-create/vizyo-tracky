-- CreateTable
CREATE TABLE "refroidissements_alerte" (
    "cle" TEXT NOT NULL,
    "derniereEmissionAt" TIMESTAMP(3) NOT NULL,
    "emissions" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refroidissements_alerte_pkey" PRIMARY KEY ("cle")
);

