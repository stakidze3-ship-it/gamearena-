-- CreateEnum
CREATE TYPE "TournamentFormat" AS ENUM ('LEADERBOARD', 'KNOCKOUT');

-- CreateEnum
CREATE TYPE "BracketMatchStatus" AS ENUM ('PENDING', 'OPEN', 'DONE');

-- AlterTable
ALTER TABLE "Tournament" ADD COLUMN     "bracketStartedAt" TIMESTAMP(3),
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "format" "TournamentFormat" NOT NULL DEFAULT 'LEADERBOARD',
ADD COLUMN     "readyWindowS" INTEGER NOT NULL DEFAULT 600,
ADD COLUMN     "roundDurationS" INTEGER NOT NULL DEFAULT 600,
ADD COLUMN     "seed" TEXT,
ADD COLUMN     "seedHash" TEXT;

-- CreateTable
CREATE TABLE "BracketMatch" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,
    "seed" TEXT,
    "seedHash" TEXT,
    "openedAt" TIMESTAMP(3),
    "aUserId" TEXT,
    "bUserId" TEXT,
    "aScore" INTEGER,
    "bScore" INTEGER,
    "aPlayed" BOOLEAN NOT NULL DEFAULT false,
    "bPlayed" BOOLEAN NOT NULL DEFAULT false,
    "winnerUserId" TEXT,
    "status" "BracketMatchStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "BracketMatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BracketMatch_tournamentId_round_idx" ON "BracketMatch"("tournamentId", "round");

-- CreateIndex
CREATE UNIQUE INDEX "BracketMatch_tournamentId_round_slot_key" ON "BracketMatch"("tournamentId", "round", "slot");

-- AddForeignKey
ALTER TABLE "BracketMatch" ADD CONSTRAINT "BracketMatch_tournamentId_fkey" FOREIGN KEY ("tournamentId") REFERENCES "Tournament"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

