-- Scoring-rules version for Block Blast.
--
-- New rows default to 2 (the current rules). Every row that already exists was
-- played and settled under v1, so it is backfilled to 1 — without this, the
-- replay viewer would re-simulate old matches under the new combo scoring and
-- show a score that never matches the one the player was actually paid on.

-- AlterTable
ALTER TABLE "BlitzRun" ADD COLUMN     "rulesVersion" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "rulesVersion" INTEGER NOT NULL DEFAULT 2;

-- Backfill: everything that predates this migration was scored under v1.
UPDATE "BlitzRun" SET "rulesVersion" = 1;
UPDATE "Match" SET "rulesVersion" = 1;
