-- AlterEnum
ALTER TYPE "TrackerCommandStatus" ADD VALUE 'SENT_UNCONFIRMED';

-- AlterTable
ALTER TABLE "tracker_commands" ADD COLUMN     "expiredAt" TIMESTAMP(3);

