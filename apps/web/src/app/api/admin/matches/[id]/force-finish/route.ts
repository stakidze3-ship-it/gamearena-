import { NextRequest, NextResponse } from "next/server";
import { forceFinishMatch } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";
import { adminOpsErrorResponse } from "@/lib/admin-ops-http";
import { refuseIfNotBracketMatch } from "@/lib/admin-match-target";

/**
 * Admin-only: resolve a stalled bracket match on the scores already in.
 *
 * "Apply the rule now" — as distinct from declare-winner, which is "the rule is
 * wrong here". The tie-break is the engine's own, the same one the round's
 * window clock applies when it expires: the higher score wins, a no-show loses,
 * and the a-side takes a dead tie. Forcing early therefore produces exactly the
 * result waiting would have, which is what stops an operator's impatience from
 * being a way to change who wins.
 *
 * OPEN matches only. Re-deciding a finished match would leave the loser already
 * advanced into the next round with no way to unwind them.
 *
 * Takes no body.
 */
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  const wrongKind = await refuseIfNotBracketMatch(id);
  if (wrongKind) return wrongKind;

  try {
    const result = await forceFinishMatch(id);
    const message =
      `${result.winnerUsername} takes the ${result.roundLabel} on ${result.aScore ?? 0}–${result.bScore ?? 0}` +
      (result.advancedTo
        ? ` · advanced to round ${result.advancedTo.round}, slot ${result.advancedTo.slot}.`
        : " · that was the last match of the bracket.");

    return NextResponse.json({ ok: true, ...result, message });
  } catch (err) {
    // Includes the case where the tournament resolved this match itself between
    // the operator seeing it and pressing the button — a 409, not a failure.
    return adminOpsErrorResponse(err, { fallback: "Could not finish that match" });
  }
}
