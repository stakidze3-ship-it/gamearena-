import { NextResponse } from "next/server";
import { removeBotsFromTournament } from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";
import { adminOpsErrorResponse } from "@/lib/admin-ops-http";
import { auditTournamentLabel, withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: take every bot back out of a tournament that has not been drawn.
 *
 * The undo for a bot fill — an event padded to test something, then wanted back
 * as a genuine human field. Their entry fees return to treasury rather than to
 * the bots' wallets, because that is where they were minted from; the
 * operations layer explains why at length.
 *
 * Takes no body. withAdminAudit runs requireAdmin() before this handler is
 * entered, and it redirects rather than returning, so this is not reachable by
 * guessing the URL.
 */
export const dynamic = "force-dynamic";

export const POST = withAdminAudit<{ id: string }>(
  { action: "tournament.remove-bots", targetType: "tournament", targetIdParam: "id" },
  async ({ params, audit }) => {
    const { id } = params;

    // Read before the removal rather than after, so a refusal from the ops layer
    // still leaves a row naming the event rather than a bare id.
    await auditTournamentLabel(audit, id);

    try {
      const result = await removeBotsFromTournament(id);

      // The money is the point of this row. Bot entry fees unwind to treasury
      // rather than into the bots' wallets, so an operator reconciling treasury
      // later needs the sweep that returned them named here instead of inferred
      // from a pile of postings. registrationReopened is recorded too because it
      // changes what the event does next: a countdown was called off.
      audit.meta({
        removed: result.removed,
        refundedTetri: result.refundedTetri,
        entryCount: result.entryCount,
        registrationReopened: result.registrationReopened,
      });

      const message =
        result.removed === 0
          ? "No bots were seated — nothing to remove."
          : `Removed ${result.removed} bot(s) · ${formatTetri(result.refundedTetri)} returned to treasury · ${result.entryCount}/${result.capacity} seats` +
            // Worth saying out loud: the countdown the fill started has been
            // called off, so the operator knows the event is open again rather
            // than seconds away from drawing a half-empty bracket.
            (result.registrationReopened ? " · countdown cancelled, registration reopened" : "");

      return NextResponse.json({ ok: true, ...result, message });
    } catch (err) {
      return adminOpsErrorResponse(err, { fallback: "Could not remove the bots" });
    }
  }
);
