import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { AWAITING_PLAYERS_AT, KNOCKOUT_CONFIG } from "@gamearena/shared";
import { requireAdmin } from "@/lib/auth";

/**
 * Admin-only: create a throwaway knockout for testing.
 *
 * Without this, the only way to exercise a bracket is to bot-fill the real
 * flagship event — which would permanently mark the live tournament as a test
 * and settle its prize pool out of treasury credit. A disposable event means
 * the real one is never touched.
 *
 * Born with isTest already set, and with a small capacity and short round
 * window by default so a full bracket runs in a couple of minutes rather than
 * the flagship's eighteen.
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  capacity: z.number().int().min(2).max(64).default(8),
  roundDurationS: z.number().int().min(20).max(600).default(60),
});

export async function POST(req: NextRequest) {
  await requireAdmin();

  const parsed = schema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid capacity or round duration" }, { status: 400 });
  }
  const { capacity, roundDurationS } = parsed.data;

  const game = await prisma.game.findFirst({ where: { key: "block-blast", enabled: true } });
  if (!game) {
    return NextResponse.json(
      { error: "Block Blast is not enabled — seed the reference data first." },
      { status: 409 }
    );
  }

  const t = await prisma.tournament.create({
    data: {
      name: `Test knockout · ${capacity} seats`,
      gameId: game.id,
      entryTetri: KNOCKOUT_CONFIG.entryTetri,
      prizeStructure: KNOCKOUT_CONFIG.prizeStructure as unknown as object[],
      guaranteeTetri: 0,
      // The awaiting-players sentinel: no countdown until the field fills.
      startsAt: AWAITING_PLAYERS_AT,
      capacity,
      format: "KNOCKOUT",
      roundDurationS,
      readyWindowS: roundDurationS,
      durationS: game.durationS,
      isTest: true,
    },
    select: { id: true, name: true, capacity: true },
  });

  return NextResponse.json({ ok: true, ...t });
}
