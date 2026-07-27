import { NextResponse } from "next/server";
import { z } from "zod";
import { forceAdvancePlayer } from "@gamearena/db";
import { adminOpsErrorResponse, readJsonBody } from "@/lib/admin-ops-http";
import { auditTournamentLabel, withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: push a named player through their current match in a running
 * knockout.
 *
 * The support tool for a pairing that cannot resolve itself — a crashed client,
 * a run lost on submission, an opponent who demonstrably will not appear. It
 * awards the open match to this player regardless of the scores and lets the
 * ordinary driver open the next round.
 *
 * This is an override of a server-verified result, not a shortcut for one: it
 * is the same operation as declaring a match winner, addressed by player rather
 * than by match id because that is how an operator arrives at it — from a
 * support ticket naming a person, not from a bracket match id.
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  userId: z.string().min(1, "A player is required"),
});

export const POST = withAdminAudit<{ id: string }>(
  // Filed against the tournament, which is the id this route is addressed by.
  // The player who was pushed through is in the metadata: an override of a
  // server-verified result has to name the person who benefited from it.
  { action: "tournament.force-advance", targetType: "tournament", targetIdParam: "id" },
  async ({ req, params, audit }) => {
    const { id } = params;

    const parsed = schema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid player" },
        { status: 400 }
      );
    }

    // Before the operation, so a refusal — no open match, not in this event —
    // still records who somebody was trying to advance and where.
    audit.meta({ userId: parsed.data.userId });
    await auditTournamentLabel(audit, id);

    try {
      const result = await forceAdvancePlayer(id, parsed.data.userId);

      // Which match was overridden and where the player landed. The bracket
      // position is copied in now because a later reset deletes every match, and
      // the row would otherwise describe an override of nothing.
      audit.meta({
        bracketMatchId: result.bracketMatchId,
        round: result.round,
        roundLabel: result.roundLabel,
        advancedTo: result.advancedTo,
      });

      const message = result.advancedTo
        ? `Advanced out of the ${result.roundLabel} into round ${result.advancedTo.round}, slot ${result.advancedTo.slot}.`
        : `Awarded the ${result.roundLabel} — there is no round after it.`;

      return NextResponse.json({ ok: true, ...result, message });
    } catch (err) {
      return adminOpsErrorResponse(err, { fallback: "Could not advance that player" });
    }
  }
);
