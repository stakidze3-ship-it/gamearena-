-- AlterTable
ALTER TABLE "BracketMatch" ADD COLUMN     "aInputLog" JSONB,
ADD COLUMN     "bInputLog" JSONB,
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "rulesVersion" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- Bracket matches that predate this migration were played and settled under
-- the v1 scoring rules, same as Match and BlitzRun. Without this backfill a
-- replay of an old bracket match would re-simulate under v2 and show a score
-- its player was never awarded.
UPDATE "BracketMatch" SET "rulesVersion" = 1;

-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SpectatorHeartbeat" (
    "tournamentId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpectatorHeartbeat_pkey" PRIMARY KEY ("tournamentId","viewerId")
);

-- CreateIndex
CREATE INDEX "BracketMatch_tournamentId_status_idx" ON "BracketMatch"("tournamentId", "status");
