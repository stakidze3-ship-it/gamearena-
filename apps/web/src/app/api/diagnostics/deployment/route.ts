import { NextResponse } from "next/server";
import { prisma } from "@gamearena/db";
import { getCurrentUser } from "@/lib/auth";

/**
 * What is actually running here.
 *
 * Reports the commit this deployment was built from, whether the migrations
 * that back each feature have applied, and whether the preconditions those
 * features need are met. It exists because "is it deployed?" was previously
 * only answerable by loading a page — and every production URL sits behind
 * Vercel SSO, so a build reporting success is not the same as a feature being
 * reachable. This closes that gap: one GET, no auth, no dashboard.
 *
 * Reads only. Exposes no data about any individual user.
 */
export const dynamic = "force-dynamic";

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `;
  return Number(rows[0]?.n ?? 0) > 0;
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM information_schema.tables WHERE table_name = ${table}
  `;
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function GET() {
  // Anyone may confirm WHICH build is live and whether its migrations applied —
  // that is how a deploy gets verified from outside, and it describes the code,
  // not the customers. Everything below that (counts, preconditions) is
  // operational detail and needs an admin.
  const user = await getCurrentUser();
  const isAdmin = user?.role === "ADMIN";

  try {
    const [
      spectatorTable,
      bracketReplay,
      tournamentIsTest,
      matchRules,
      admins,
      bots,
      games,
      tournaments,
    ] = await Promise.all([
      tableExists("SpectatorHeartbeat"),
      columnExists("BracketMatch", "aInputLog"),
      columnExists("Tournament", "isTest"),
      columnExists("Match", "rulesVersion"),
      prisma.user.count({ where: { role: "ADMIN" } }),
      prisma.user.count({ where: { isBot: true } }),
      prisma.game.count({ where: { enabled: true } }),
      prisma.tournament.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);

    const byStatus = Object.fromEntries(tournaments.map((t) => [t.status, t._count._all]));
    const running = byStatus.RUNNING ?? 0;

    // Why an empty Tournaments page is public information.
    //
    // "The page is blank" has exactly three causes — nothing was created, it
    // was created somewhere else, or a filter is hiding it — and telling them
    // apart from outside previously required an admin session on a deployment
    // whose admin screens were themselves unreachable. These are counts of
    // events and games, not user data, so they cost nothing to expose and turn
    // a guessing game into one request.
    const visibleToPlayers = await prisma.tournament.count({
      where: { isTest: false, status: { in: ["SCHEDULED", "RUNNING", "FINISHED"] } },
    });
    const openForEntry = await prisma.tournament.count({
      where: { isTest: false, status: "SCHEDULED" },
    });
    const hiddenAsTest = await prisma.tournament.count({ where: { isTest: true } });

    // The open event's advertised terms. This is what the Tournaments page puts
    // in front of every visitor, so there is nothing to protect — and it is the
    // difference between "a tournament exists" and "the right tournament
    // exists", which is the question actually being asked.
    const openEvent = await prisma.tournament.findFirst({
      where: { isTest: false, status: "SCHEDULED", format: "KNOCKOUT" },
      select: {
        id: true, name: true, capacity: true, entryTetri: true, prizeStructure: true,
        _count: { select: { entries: true } },
      },
    });
    const openEventSummary = openEvent
      ? {
          id: openEvent.id,
          name: openEvent.name,
          capacity: openEvent.capacity,
          entryTetri: openEvent.entryTetri,
          poolTetri: openEvent.capacity * openEvent.entryTetri,
          seatsTaken: openEvent._count.entries,
          prizesTetri: (openEvent.prizeStructure as { rank: number; shareBps: number }[]).map(
            (p) => Math.floor((openEvent.capacity * openEvent.entryTetri * p.shareBps) / 10_000)
          ),
        }
      : null;

    const publicPart = {
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "unknown (not a Vercel build)",
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? "unknown",
      migrationsApplied:
        spectatorTable && bracketReplay && tournamentIsTest && matchRules,
      tournaments: {
        total: tournaments.reduce((n, t) => n + t._count._all, 0),
        visibleToPlayers,
        openForEntry,
        hiddenAsTest,
        openEvent: openEventSummary,
        byStatus,
        enabledGames: games,
      },
    };
    if (!isAdmin) return NextResponse.json(publicPart);

    return NextResponse.json({
      ...publicPart,
      builtAt: process.env.VERCEL_DEPLOYMENT_ID ? "vercel" : "local",

      // Did the migrations land? If any of these is false the deployment is
      // running new code against an old database.
      migrations: {
        spectatorHeartbeatTable: spectatorTable,
        bracketMatchReplayColumns: bracketReplay,
        tournamentIsTestColumn: tournamentIsTest,
        matchRulesVersionColumn: matchRules,
      },

      // Preconditions. A feature can be fully deployed and still invisible
      // because the state it renders for does not exist yet.
      preconditions: {
        adminAccounts: admins,
        botAccounts: bots,
        enabledGames: games,
        tournamentsByStatus: byStatus,
      },

      featureVisibility: {
        adminBotFill:
          admins > 0
            ? "reachable at /admin/tournaments"
            : "NOT REACHABLE — no ADMIN account exists; POST /api/admin/bootstrap to promote one",
        spectatorPanel:
          running > 0
            ? "visible on a RUNNING tournament page"
            : "hidden — no tournament is RUNNING; start one (bot fill) to see it",
        bracketReplayLinks:
          (byStatus.FINISHED ?? 0) > 0
            ? "available on finished bracket matches"
            : "none yet — a match must finish before it has a replay",
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
