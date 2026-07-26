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

/**
 * Slack for clock skew and the round trip that opened the match. Generous
 * enough that no honest player is ever clipped, small enough that it buys an
 * attacker nothing.
 */
const CLOCK_TOLERANCE_MS = 3_000;

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
    // Server recomputes the score from the round's shared seed, and only over
    // the time that has actually elapsed since the match opened. Prizes are
    // real here, so the same offline-optimiser attack that Blitz was open to
    // would be worth far more: reveal the round seed, search at leisure, submit
    // a perfect line. Capping the window at wall-clock costs an honest player
    // nothing — their inputs always trail the clock.
    const openedAt = match.openedAt?.getTime() ?? Date.now();
    const roundMs = t.game.durationS * 1000;
    const scoreableMs = Math.min(roundMs, Math.max(0, Date.now() - openedAt + CLOCK_TOLERANCE_MS));
    const sim = simulate(def, match.seed, parsed.data.inputs, scoreableMs);
    // Store the run too, or the match has no replay — only bot matches did,
    // so every "Watch replay" link on a human match was dead.
    await submitKnockoutScore(id, user.id, sim.score, parsed.data.inputs);
    // Advance immediately so a resolved round opens the next one without waiting.
    await advanceKnockout(id);
    return NextResponse.json({ score: sim.score, seed: match.seed, round: match.round });
  }

  // ── Leaderboard: one shared seed, ranked by best score ──
  if (!t.seed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (t.status === "FINISHED" || new Date() > tournamentEndsAt(t.startsAt, t.durationS)) {
    return NextResponse.json({ error: "Tournament has ended" }, { status: 409 });
  }
  // ...and it must have STARTED. Registering mints the shared seed and flips a
  // leaderboard event live immediately, so without this the first person to
  // register could play — repeatedly, since the ranking keeps their best — for
  // however many hours remained before the advertised start, while everyone
  // arriving on time shared what was left of the window.
  if (new Date() < t.startsAt) {
    return NextResponse.json(
      { error: "This tournament hasn't started yet." },
      { status: 409 }
    );
  }
  // Same wall-clock bound as the knockout path. A leaderboard run is measured
  // from when the player joined, since that is when the shared seed became
  // visible to them.
  const leaderboardMs = Math.min(
    t.game.durationS * 1000,
    Math.max(0, Date.now() - entry.joinedAt.getTime() + CLOCK_TOLERANCE_MS)
  );
  const sim = simulate(def, t.seed, parsed.data.inputs, leaderboardMs);
  const best = Math.max(entry.bestScore ?? 0, sim.score);

  await prisma.tournamentEntry.update({
    where: { tournamentId_userId: { tournamentId: id, userId: user.id } },
    data: { bestScore: best },
  });

  return NextResponse.json({ score: sim.score, bestScore: best, seed: t.seed });
}
