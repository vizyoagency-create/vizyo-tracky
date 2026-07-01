-- Palier 3 — Rapports d'observation IA de l'activité utilisateur (persistés) + planification réglable.

-- CreateEnum
CREATE TYPE "ActivityReportStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "activity_reports" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" UUID,
    "targetUserIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "fromAt" TIMESTAMP(3) NOT NULL,
    "toAt" TIMESTAMP(3) NOT NULL,
    "status" "ActivityReportStatus" NOT NULL DEFAULT 'READY',
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "title" TEXT,
    "content" JSONB,
    "error" TEXT,
    "model" TEXT,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "activity_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_reports_createdAt_idx" ON "activity_reports"("createdAt");

-- CreateTable
CREATE TABLE "activity_report_schedule" (
    "id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "frequency" TEXT NOT NULL DEFAULT 'weekly',
    "scope" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastRunAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" UUID,

    CONSTRAINT "activity_report_schedule_pkey" PRIMARY KEY ("id")
);
