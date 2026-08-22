-- AlterTable
ALTER TABLE "error_logs" ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" UUID,
ADD COLUMN     "resolvedNote" TEXT;

-- CreateIndex
CREATE INDEX "error_logs_resolvedAt_createdAt_idx" ON "error_logs"("resolvedAt", "createdAt" DESC);

