import { NextRequest, NextResponse } from "next/server";
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { prisma, InsufficientFundsError, payBlitzEntryIn } from "@gamearena/db";
import { BLITZ_ENTRIES_TETRI } from "@gamearena/shared";
import { getGameDefinition } from "@gamearena/games";
import { getCurrentUser } from "@/lib/auth";

const startSchema = z.object({
  gameKey: z.string(),
  entryTetri: z.number().int().positive(),
});

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (user.selfExcludedUntil && user.selfExcludedUntil > new Date()) {
    return NextResponse.json({ error: "Self-exclusion active" }, { status: 403 });
  }

  const parsed = startSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { gameKey, entryTetri } = parsed.data;

  if (!BLITZ_ENTRIES_TETRI.includes(entryTetri as (typeof BLITZ_ENTRIES_TETRI)[number])) {
    return NextResponse.json({ error: "Invalid entry amount" }, { status: 400 });
  }
  if (!getGameDefinition(gameKey)) {
    return NextResponse.json({ error: "Unknown game" }, { status: 400 });
  }

  const game = await prisma.game.findUnique({ where: { key: gameKey } });
  if (!game || !game.enabled) {
    return NextResponse.json({ error: "Game unavailable" }, { status: 400 });
  }
  const config = await prisma.blitzConfig.findFirst({
    where: { gameId: game.id, active: true },
  });
  if (!config) return NextResponse.json({ error: "No active Blitz config" }, { status: 400 });

  // Unpredictable numeric seed; commit its hash now, reveal the seed after play.
  const seed = randomInt(100_000, 1_000_000).toString();
  const seedHash = sha256(seed);

  try {
    const run = await prisma.$transaction(async (db) => {
      const created = await db.blitzRun.create({
        data: {
          userId: user.id,
          gameId: game.id,
          configId: config.id,
          entryTetri,
          seed,
          seedHash,
          status: "PENDING",
        },
      });
      // Charge the entry into the house (treasury) through the ledger.
      await payBlitzEntryIn(db, created.id, user.id, entryTetri);
      return created;
    });

    return NextResponse.json({
      runId: run.id,
      seed, // solo mode: client needs the seed to render; also recorded for verify
      seedHash,
      durationS: game.durationS,
      gameKey,
      entryTetri,
    });
  } catch (e) {
    if (e instanceof InsufficientFundsError) {
      return NextResponse.json({ error: "Not enough demo credits" }, { status: 402 });
    }
    throw e;
  }
}
