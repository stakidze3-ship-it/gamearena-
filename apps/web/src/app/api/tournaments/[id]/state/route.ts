import { NextRequest, NextResponse } from "next/server";
import {
  advanceKnockout,
  cancelTournamentRefunding,
  currentKnockoutMatch,
  driveBotMatches,
  generateKnockout,
  prisma,
} from "@gamearena/db";
import { isAwaitingPlayers } from "@gamearena/shared";
import { getCurrentUser } from "@/lib/auth";

/**
 * Compact live state for the tournament screens. Clients poll this every couple
 * of seconds and only re-render when `stateKey` changes, so seats filling, the
 * draw landing, a round opening and a result arriving all surface within
 * seconds without a socket. Readable without a session so the public invite
 * page can show the seat counter too.
 */

// Polling also nudges the bracket forward, which keeps forfeits and round
// openings working even if the realtime service is down. Every client hitting
// this would hammer the database, so each tournament advances at most once per
// window here; the scheduler stays the primary driver.
const ADVANCE_THROTTLE_MS = 3_000;
const lastAdvance = new Map<string, number>();

function throttleAdvance(id: string): boolean {
  const now = Date.now();
  const previous = lastAdvance.get(id) ?? 0;
  if (now - previous < ADVANCE_THROTTLE_MS) return false;
  if (lastAdvance.size > 100) lastAdvance.clear(); // bounded: events are few
  lastAdvance.set(id, now);
  return true;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const pre = await prisma.tournament.findUnique({
    where: { id },
    select: { id: true, status: true, format: true, startsAt: true },
  });
  if (!pre) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (pre.format === "KNOCKOUT" && throttleAdvance(id)) {
    // Never let a driver error break the poll — the next tick retries.
    if (pre.status === "SCHEDULED" && pre.startsAt.getTime() <= Date.now()) {
      // The field filled and its countdown expired. Drawing the bracket is
      // normally the scheduler's job, but a web-only deployment has no
      // scheduler — without this a full lobby would sit with everyone's stake
      // escrowed and never start.
      await generateKnockout(id)
        .then(async (placed) => {
          if (placed === 0) await cancelTournamentRefunding(id); // too few to play → refund
        })
        .catch(() => {});
    } else if (pre.status === "RUNNING") {
      // Bots first, then advance: a bot submitting can complete a pairing, and
      // running the advance afterwards opens the next round in the same tick
      // instead of leaving it a poll behind. driveBotMatches is a no-op unless
      // the event actually has bots in it, and each bot only plays once its own
      // deterministic delay has elapsed — which is what makes a bot-filled
      // tournament unfold over minutes rather than resolving instantly.
      await driveBotMatches(id).catch(() => {});
      await advanceKnockout(id).catch(() => {});
    }
  }

  const user = await getCurrentUser();
  const [t, entryCount, matchCounts, mine] = await Promise.all([
    prisma.tournament.findUnique({
      where: { id },
      select: { status: true, capacity: true, startsAt: true, format: true },
    }),
    prisma.tournamentEntry.count({ where: { tournamentId: id } }),
    prisma.bracketMatch.groupBy({
      by: ["status"],
      where: { tournamentId: id },
      _count: { _all: true },
    }),
    user ? currentKnockoutMatch(id, user.id) : Promise.resolve(null),
  ]);
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const countOf = (status: string) =>
    matchCounts.find((c) => c.status === status)?._count._all ?? 0;
  const done = countOf("DONE");
  const open = countOf("OPEN");

  // Anything that should repaint the screen goes into the key.
  const stateKey = [
    t.status,
    entryCount,
    done,
    open,
    t.startsAt.getTime(),
    mine?.id ?? "",
    mine?.seed ?? "",
  ].join(":");

  return NextResponse.json(
    {
      status: t.status,
      entryCount,
      capacity: t.capacity,
      full: entryCount >= t.capacity,
      awaitingPlayers: isAwaitingPlayers(t.startsAt),
      startsAt: t.startsAt.toISOString(),
      hasLiveMatch: !!mine,
      stateKey,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
