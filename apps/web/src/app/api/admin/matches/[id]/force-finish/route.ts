import { NextResponse } from "next/server";
import { forceFinishMatch } from "@gamearena/db";
import { adminOpsErrorResponse } from "@/lib/admin-ops-http";
import { refuseIfNotBracketMatch } from "@/lib/admin-match-target";
import { auditBracketMatchLabel, withAdminAudit } from "@/lib/with-admin-audit";

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

export const POST = withAdminAudit<{ id: string }>(
  // Two endpoints decide a match, and they are logged under two names on
  // purpose: an audit has to be able to tell "the operator hurried the clock"
  // apart from "the operator overrode the result", and one action name for both
  // would answer neither question. See ../declare-winner.
  { action: "match.force-finish", targetType: "match", targetIdParam: "id" },
  async ({ params, audit }) => {
    const { id } = params;

    // Read before the match is decided, and above all before a later bracket
    // reset deletes the row: without the round and slot copied in now, a forced
    // result becomes unattributable the moment somebody redraws.
    await auditBracketMatchLabel(audit, id);

    const wrongKind = await refuseIfNotBracketMatch(id);
    if (wrongKind) return wrongKind;

    try {
      const result = await forceFinishMatch(id);

      // Who won and on what scores. The scores matter specifically on this
      // route: the claim it makes is that the engine's ordinary rule was
      // applied, and these are the numbers that rule was applied to.
      audit.meta({
        tournamentId: result.tournamentId,
        round: result.round,
        winnerUserId: result.winnerUserId,
        winnerUsername: result.winnerUsername,
        aScore: result.aScore,
        bScore: result.bScore,
        advancedTo: result.advancedTo,
      });

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
);
