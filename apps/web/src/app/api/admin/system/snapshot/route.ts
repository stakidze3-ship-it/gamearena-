import { NextResponse } from "next/server";
import { prisma, systemSnapshot } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";

/**
 * Admin-only: the platform's vital signs, in one read.
 *
 * This is the panel an operator opens BECAUSE something is wrong, so its first
 * duty is to answer at all. systemSnapshot() is built that way — the realtime
 * probe is bounded and every failure path returns a verdict instead of throwing
 * — and this route must not undo that. Hence the one rule here: when the
 * database is unreachable, do not run the extra query. Adding a lookup that
 * throws on the exact failure the page exists to report would turn "database:
 * down" into a 500 and leave the operator with nothing.
 *
 * The tournament list is added on top of the ops-layer snapshot because
 * "everything scheduled or running" is a different question from "how many are
 * running" — during an incident the id and the seat count are what the next
 * action needs, and a number alone means opening another screen to find them.
 */
export const dynamic = "force-dynamic";

/** More than this on one health panel is a list nobody reads; the count stays exact. */
const MAX_LISTED = 25;

export async function GET() {
  await requireAdmin();

  const snapshot = await systemSnapshot();

  const rows = snapshot.database.ok
    ? await prisma.tournament.findMany({
        where: { status: { in: ["SCHEDULED", "RUNNING"] } },
        select: {
          id: true,
          name: true,
          status: true,
          capacity: true,
          startsAt: true,
          isTest: true,
          botsSeated: true,
          _count: { select: { entries: true } },
        },
        orderBy: { startsAt: "asc" },
        take: MAX_LISTED + 1, // one extra, purely to detect that there are more
      })
    : [];

  const capped = rows.length > MAX_LISTED;
  // Live events first. Sorted here rather than in the query because ordering by
  // an enum column sorts by the order the values were declared, which is a
  // property of the schema file and not of what an operator wants to see first.
  const tournaments = rows
    .slice(0, MAX_LISTED)
    .sort((a, b) => Number(b.status === "RUNNING") - Number(a.status === "RUNNING"));

  return NextResponse.json({
    onlinePlayers: snapshot.onlinePlayers,
    database: snapshot.database,
    realtime: {
      ...snapshot.realtime,
      // The console reads the reason as `detail`; the ops layer calls it
      // `error`. Both are sent so neither reader has to be changed to match the
      // other, and a health panel that silently renders `undefined` because of
      // a field name is a bad trade.
      detail: snapshot.realtime.error,
    },
    counts: snapshot.counts,
    activeTournaments: tournaments.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      entryCount: t._count.entries,
      capacity: t.capacity,
      startsAt: t.startsAt,
      isTest: t.isTest,
      // Worth seeing next to the seat count: a full-looking field that is
      // partly bots has a partly treasury-minted prize pool.
      botsSeated: t.botsSeated,
    })),
    /** True when the list was cut; the counts block is still exact. */
    activeTournamentsCapped: capped,
  });
}
