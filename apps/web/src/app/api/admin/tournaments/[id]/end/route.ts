import { NextRequest, NextResponse } from "next/server";
import { endTournamentNow } from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";
import { requireAdmin } from "@/lib/auth";
import { adminOpsErrorResponse } from "@/lib/admin-ops-http";

/**
 * Admin-only: settle a running tournament right now.
 *
 * Settlement itself is not reimplemented — every still-open match is resolved
 * on its current scores by the engine's own rule, round after round, until the
 * champion exists and `finalizeKnockout` will pay out. Forcing a match early
 * therefore produces exactly the result waiting would have; an operator's
 * impatience cannot change who wins.
 *
 * RUNNING only, and it pays real prizes out of escrow, which is why the console
 * puts it behind a type-the-name confirmation.
 *
 * `forcedMatches` is surfaced deliberately: it counts the matches this button
 * decided rather than the players, which is the number anyone reviewing the
 * event afterwards will want.
 *
 * Takes no body.
 */
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  try {
    const result = await endTournamentNow(id);
    const message =
      `Settled — the tournament is ${result.status}` +
      (result.forcedMatches > 0
        ? ` · ${result.forcedMatches} match(es) decided on standing scores rather than played out`
        : "") +
      (result.botTetriRecovered > 0
        ? ` · ${formatTetri(result.botTetriRecovered)} of bot winnings returned to treasury`
        : "");

    return NextResponse.json({ ok: true, ...result, message });
  } catch (err) {
    // A bracket that cannot converge — usually a bye chain leaving a slot that
    // can never fill — arrives here as a 409 naming the undecided count, which
    // is far more useful than a generic failure on an event still running.
    return adminOpsErrorResponse(err, { fallback: "Could not settle the tournament" });
  }
}
