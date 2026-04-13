-- AlterTable: Replace internal auth with Vizyo Auth
ALTER TABLE "users" DROP COLUMN "passwordHash",
ADD COLUMN     "authUserId" TEXT NOT NULL,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE UNIQUE INDEX "users_authUserId_key" ON "users"("authUserId");
