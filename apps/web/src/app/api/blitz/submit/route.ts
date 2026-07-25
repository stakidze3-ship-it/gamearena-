import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AccountKeys, getBalanceTetri, prisma, payBlitzPrizeIn } from "@gamearena/db";
import { blitzPayoutTetri, type CurvePoint } from "@gamearena/shared";
import { getGameDefinition, simulate } from "@gamearena/games";
import { getCurrentUser } from "@/lib/auth";

// GRID is 8×8, three slots, 60s → generous caps that still bound abuse.
const submitSchema = z.object({
  runId: z.string().min(1),
  inputs: z
    .array(
      z.object({
        t: z.number().int().min(0).max(120_000),
        s: z.number().int().min(0).max(2),
        r: z.number().int().min(0).max(7),
        c: z.number().int().min(0).max(7),
      })
    )
    .max(3000),
});

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = submitSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { runId, inputs } = parsed.data;

  const run = await prisma.blitzRun.findUnique({
    where: { id: runId },
    include: { config: true, game: true },
  });
  if (!run || run.userId !== user.id) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  // Idempotent: a re-submit of an already-settled run returns the same result.
  if (run.status === "SETTLED") {
    return NextResponse.json({
      serverScore: run.serverScore,
      multBps: run.multBps,
      payoutTetri: run.payoutTetri,
      seed: run.seed,
      entryTetri: run.entryTetri,
      alreadySettled: true,
    });
  }
  if (run.status !== "PENDING") {
    return NextResponse.json({ error: "Run not playable" }, { status: 409 });
  }

  const def = getGameDefinition(run.game.key);
  if (!def) return NextResponse.json({ error: "Unknown game" }, { status: 400 });

  // ── The authoritative bit: recompute the score server-side from the raw
  //    inputs, through the exact same engine. The client's score is ignored. ──
  const durationMs = run.game.durationS * 1000;
  const sim = simulate(def, run.seed, inputs, durationMs);
  const serverScore = sim.score;

  const curve = run.config.curve as unknown as CurvePoint[];
  const { multBps, payoutTetri } = blitzPayoutTetri(
    run.entryTetri,
    curve,
    serverScore,
    run.config.maxMultBps
  );

  await prisma.$transaction(async (db) => {
    // Pay the prize (no-op when payout is 0). Idempotency-keyed in the ledger.
    await payBlitzPrizeIn(db, run.id, user.id, payoutTetri);
    await db.blitzRun.update({
      where: { id: run.id },
      data: {
        status: "SETTLED",
        serverScore,
        multBps,
        payoutTetri,
        inputLog: inputs, // the replay
        inputCount: sim.applied,
        settledAt: new Date(),
      },
    });
  });

  const newBalanceTetri = await getBalanceTetri(prisma, AccountKeys.userCash(user.id));

  return NextResponse.json({
    serverScore,
    multBps,
    payoutTetri,
    entryTetri: run.entryTetri,
    seed: run.seed,
    seedHash: run.seedHash,
    breakEvenScore: run.config.breakEvenScore,
    applied: sim.applied,
    rejected: sim.rejected,
    newBalanceTetri,
  });
}
