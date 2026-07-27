-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "botFilledAt" TIMESTAMP(3),
ADD COLUMN     "botsSeated" INTEGER NOT NULL DEFAULT 0;
