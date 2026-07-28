-- AlterTable
ALTER TABLE "notification_preferences" ADD COLUMN     "mutedCategories" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "notification_deliveries" ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'ALERT',
ADD COLUMN     "subjectKey" TEXT;

-- CreateIndex
CREATE INDEX "notification_deliveries_userId_category_subjectKey_createdA_idx" ON "notification_deliveries"("userId", "category", "subjectKey", "createdAt" DESC);

