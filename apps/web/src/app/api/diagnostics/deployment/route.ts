import { NextResponse } from "next/server";
import { prisma } from "@gamearena/db";

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

    return NextResponse.json({
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "unknown (not a Vercel build)",
      branch: process.env.VERCEL_GIT_COMMIT_REF ?? "unknown",
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
