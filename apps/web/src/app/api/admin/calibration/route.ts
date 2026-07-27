import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: publish a new blitz payout curve for one game.
 *
 * No money moves here, which is exactly why it is worth logging loudly: this
 * decides what every future blitz run pays, so a bad curve is a slow leak
 * rather than a single bad transaction. The row carries the whole curve, so an
 * investigation into "why did payouts change on the 14th" has the answer in the
 * trail instead of having to diff two BlitzConfig versions by hand.
 */
export const dynamic = "force-dynamic";

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

export const POST = withAdminAudit(
  // "system": the target is the platform's payout configuration, not any one
  // player. The game it applies to is the label, set once the body is read.
  { action: "config.blitz-calibration", targetType: "system" },
  async ({ req, audit }) => {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid curve" }, { status: 400 });
    const { gameKey, breakEvenScore, zeroScore, maxMultBps } = parsed.data;
    const curve = [...parsed.data.curve].sort((a, b) => a.score - b.score);

    // Recorded before the game lookup, so a curve aimed at a game key that does
    // not exist still records what was being attempted.
    audit.label(gameKey);
    audit.meta({ gameKey, breakEvenScore, zeroScore, maxMultBps, curve });

    const game = await prisma.game.findUnique({ where: { key: gameKey } });
    if (!game) return NextResponse.json({ error: "Unknown game" }, { status: 400 });
    // The game's display name once it is known; the id goes in the metadata
    // rather than in targetId, because the target of a config change is the
    // platform's payout rules and filing it against a game row would imply the
    // game itself was edited.
    audit.label(game.name);
    audit.meta({ gameId: game.id });

    // A new active version supersedes the old — player payout tables read the
    // active config, so they update the instant this is saved.
    const latest = await prisma.blitzConfig.findFirst({
      where: { gameId: game.id },
      orderBy: { version: "desc" },
    });

    // Both versions, because the curve is immutable per version: the pair is
    // enough to reconstruct exactly what was in force before and after.
    audit.meta({ previousVersion: latest?.version ?? null, version: (latest?.version ?? 0) + 1 });

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
);
