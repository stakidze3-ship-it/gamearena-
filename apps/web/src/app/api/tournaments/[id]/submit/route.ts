import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  prisma,
  advanceKnockout,
  currentKnockoutMatch,
  submitKnockoutScore,
} from "@gamearena/db";
import { getGameDefinition, simulate } from "@gamearena/games";
import { getCurrentUser } from "@/lib/auth";
import { tournamentEndsAt } from "@/lib/tournaments";

const schema = z.object({
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

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const t = await prisma.tournament.findUnique({ where: { id }, include: { game: true } });
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const entry = await prisma.tournamentEntry.findUnique({
    where: { tournamentId_userId: { tournamentId: id, userId: user.id } },
  });
  if (!entry) return NextResponse.json({ error: "Not registered" }, { status: 403 });

  const def = getGameDefinition(t.game.key);
  if (!def) return NextResponse.json({ error: "Unknown game" }, { status: 400 });

  // ── Knockout: play your open match's round seed; the higher score advances ──
  if (t.format === "KNOCKOUT") {
    if (t.status !== "RUNNING") {
      return NextResponse.json({ error: "Bracket is not live" }, { status: 409 });
    }
    const match = await currentKnockoutMatch(id, user.id);
    if (!match || !match.seed) {
      return NextResponse.json({ error: "No open match this round" }, { status: 409 });
    }
    // Server recomputes the score from the round's shared seed.
    const sim = simulate(def, match.seed, parsed.data.inputs, t.game.durationS * 1000);
    await submitKnockoutScore(id, user.id, sim.score);
    // Advance immediately so a resolved round opens the next one without waiting.
    await advanceKnockout(id);
    return NextResponse.json({ score: sim.score, seed: match.seed, round: match.round });
  }

  // ── Leaderboard: one shared seed, ranked by best score ──
  if (!t.seed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (t.status === "FINISHED" || new Date() > tournamentEndsAt(t.startsAt, t.durationS)) {
    return NextResponse.json({ error: "Tournament has ended" }, { status: 409 });
  }
  const sim = simulate(def, t.seed, parsed.data.inputs, t.game.durationS * 1000);
  const best = Math.max(entry.bestScore ?? 0, sim.score);

  await prisma.tournamentEntry.update({
    where: { tournamentId_userId: { tournamentId: id, userId: user.id } },
    data: { bestScore: best },
  });

  return NextResponse.json({ score: sim.score, bestScore: best, seed: t.seed });
}
