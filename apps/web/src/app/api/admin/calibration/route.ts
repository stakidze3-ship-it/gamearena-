import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";

const schema = z.object({
  gameKey: z.string(),
  breakEvenScore: z.number().int().min(1).max(100_000),
  zeroScore: z.number().int().min(0).max(100_000),
  maxMultBps: z.number().int().min(10_000).max(100_000),
  curve: z
    .array(z.object({ score: z.number().int().min(0), multBps: z.number().int().min(0).max(100_000) }))
    .min(2)
    .max(12),
});

export async function POST(req: NextRequest) {
  await requireAdmin();

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid curve" }, { status: 400 });
  const { gameKey, breakEvenScore, zeroScore, maxMultBps } = parsed.data;
  const curve = [...parsed.data.curve].sort((a, b) => a.score - b.score);

  const game = await prisma.game.findUnique({ where: { key: gameKey } });
  if (!game) return NextResponse.json({ error: "Unknown game" }, { status: 400 });

  // A new active version supersedes the old — player payout tables read the
  // active config, so they update the instant this is saved.
  const latest = await prisma.blitzConfig.findFirst({
    where: { gameId: game.id },
    orderBy: { version: "desc" },
  });

  await prisma.$transaction(async (db) => {
    await db.blitzConfig.updateMany({ where: { gameId: game.id }, data: { active: false } });
    await db.blitzConfig.create({
      data: {
        gameId: game.id,
        version: (latest?.version ?? 0) + 1,
        breakEvenScore,
        zeroScore,
        maxMultBps,
        curve,
        active: true,
      },
    });
  });

  return NextResponse.json({ ok: true, version: (latest?.version ?? 0) + 1 });
}
