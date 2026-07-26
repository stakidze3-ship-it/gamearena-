import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { AWAITING_PLAYERS_AT, lariToTetri, type PrizeShare } from "@gamearena/shared";
import { requireAdmin } from "@/lib/auth";

/**
 * Admin-only: create a REAL knockout tournament — one players can see and enter.
 *
 * Distinct from /create-test, which is born flagged `isTest` and is hidden from
 * the player-facing list. This is the live-event path: `isTest` stays false, so
 * it appears on /tournaments the moment it exists.
 *
 * Prizes are given in lari and converted to basis points of the FULL pool
 * (capacity × entry), so what an admin types is what winners are paid. The
 * split is validated against the pool rather than trusted: a structure summing
 * over 100% would promise money the escrow does not hold, and settlement would
 * have to top it up from treasury.
 *
 * Registration opens immediately: `startsAt` is the awaiting-players sentinel,
 * so the event shows as open and the draw fires when the last seat is taken.
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().min(2).max(60),
  gameKey: z.string().default("block-blast"),
  capacity: z.number().int().min(2).max(1024),
  entryLari: z.number().min(0).max(10_000),
  /** Prize per rank, in lari, biggest first. */
  prizesLari: z.array(z.number().min(0)).min(1).max(8),
  roundDurationS: z.number().int().min(30).max(3600).default(180),
  readyWindowS: z.number().int().min(30).max(3600).default(180),
});

export async function POST(req: NextRequest) {
  await requireAdmin();

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid tournament" },
      { status: 400 }
    );
  }
  const d = parsed.data;

  const game = await prisma.game.findUnique({ where: { key: d.gameKey } });
  if (!game) {
    return NextResponse.json({ error: `No game "${d.gameKey}"` }, { status: 400 });
  }
  if (!game.enabled) {
    return NextResponse.json({ error: `${game.name} is not enabled` }, { status: 409 });
  }

  const entryTetri = lariToTetri(d.entryLari);
  const poolTetri = entryTetri * d.capacity;
  const prizeTetri = d.prizesLari.map((l) => lariToTetri(l));
  const totalPrizeTetri = prizeTetri.reduce((n, p) => n + p, 0);

  if (poolTetri === 0) {
    return NextResponse.json({ error: "A paid event needs a non-zero entry" }, { status: 400 });
  }
  if (totalPrizeTetri > poolTetri) {
    return NextResponse.json(
      {
        error: `Prizes total more than the pool — ₾${(totalPrizeTetri / 100).toFixed(2)} promised against ₾${(poolTetri / 100).toFixed(2)} collected.`,
      },
      { status: 400 }
    );
  }

  // Basis points of the pool, so settlement pays exactly the figures given.
  const prizeStructure: PrizeShare[] = prizeTetri.map((tetri, i) => ({
    rank: i + 1,
    shareBps: Math.round((tetri / poolTetri) * 10_000),
  }));

  const t = await prisma.tournament.create({
    data: {
      name: d.name,
      gameId: game.id,
      entryTetri,
      guaranteeTetri: 0,
      prizeStructure: prizeStructure as unknown as object[],
      capacity: d.capacity,
      // Fills-then-starts: visible and open for registration straight away.
      startsAt: AWAITING_PLAYERS_AT,
      format: "KNOCKOUT",
      durationS: game.durationS,
      roundDurationS: d.roundDurationS,
      readyWindowS: d.readyWindowS,
      isTest: false,
      status: "SCHEDULED",
    },
    select: { id: true, name: true, capacity: true, entryTetri: true },
  });

  return NextResponse.json({
    ok: true,
    ...t,
    poolTetri,
    prizes: prizeTetri.map((tetri, i) => ({ rank: i + 1, tetri })),
    rakeTetri: poolTetri - totalPrizeTetri,
  });
}
