import { NextRequest, NextResponse } from "next/server";
import { prisma, seedProduction } from "@gamearena/db";

/**
 * Reference-data diagnostics, and a self-heal for it.
 *
 * The seed runs during the build, where its output is only visible in the
 * deployment log. When that log is out of reach, a deployment can come up green
 * with empty reference tables and no way to tell why — the app just renders an
 * empty Play screen. This reports what is actually in the database, and on POST
 * re-runs the seed and returns the real error if it fails.
 *
 * Safe by construction: the seed only ever upserts reference rows (games, Blitz
 * curves, vault tiers, feature flags, the open knockout). It cannot create
 * users, move money, or delete anything, and re-running it is a no-op.
 */

export const dynamic = "force-dynamic";

async function counts() {
  const [games, enabledGames, tournaments, openTournaments, blitzConfigs, vaultTiers, flags, users] =
    await Promise.all([
      prisma.game.count(),
      prisma.game.count({ where: { enabled: true } }),
      prisma.tournament.count(),
      prisma.tournament.count({ where: { status: { in: ["SCHEDULED", "RUNNING"] } } }),
      prisma.blitzConfig.count(),
      prisma.vaultTier.count(),
      prisma.featureFlag.count(),
      prisma.user.count(),
    ]);
  return { games, enabledGames, tournaments, openTournaments, blitzConfigs, vaultTiers, flags, users };
}

/** Host only — never the credentials — so we can confirm which database this is. */
function databaseHost(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return "DATABASE_URL is not set";
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}`;
  } catch {
    return "unparseable";
  }
}

export async function GET() {
  try {
    const data = await counts();
    return NextResponse.json({
      ok: true,
      database: databaseHost(),
      counts: data,
      seeded: data.enabledGames > 0,
      hint:
        data.enabledGames > 0
          ? "Reference data is present."
          : "No enabled game — the Play screen will be empty. POST to this endpoint to run the seed.",
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, database: databaseHost(), error: String(err) },
      { status: 500 }
    );
  }
}

export async function POST(_req: NextRequest) {
  const before = await counts().catch(() => null);
  try {
    await seedProduction();
  } catch (err) {
    // This is the message the build log would have carried.
    return NextResponse.json(
      {
        ok: false,
        database: databaseHost(),
        before,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, database: databaseHost(), before, after: await counts() });
}
