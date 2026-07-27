import { NextResponse } from "next/server";
import { resetTournament } from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";
import { adminOpsErrorResponse } from "@/lib/admin-ops-http";
import { auditTournamentLabel, withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: throw the bracket away and put the event back in the lobby.
 *
 * "Redraw", not "refund" — entries stay, escrow stays, and the same field is
 * paired again on a fresh seed. Only the bracket is destroyed, along with every
 * score and replay stored against it.
 *
 * SCHEDULED or RUNNING only. The operations layer refuses on a FINISHED or
 * CANCELLED event and that refusal is the whole safety story: those have
 * already paid out, the escrow is empty, and the settlement idempotency key
 * would block a second payout — so a redrawn champion would win nothing while
 * the old one kept everything.
 *
 * Takes no body.
 */
export const dynamic = "force-dynamic";

export const POST = withAdminAudit<{ id: string }>(
  { action: "tournament.reset", targetType: "tournament", targetIdParam: "id" },
  async ({ params, audit }) => {
    const { id } = params;

    await auditTournamentLabel(audit, id);

    try {
      const result = await resetTournament(id);

      // deletedMatches is the destroyed part and the two money figures are the
      // preserved part. Both belong in the row: a reset is the one operation
      // here that looks like it should have refunded everybody and deliberately
      // did not, and the row is what settles that question afterwards.
      audit.meta({
        deletedMatches: result.deletedMatches,
        entryCount: result.entryCount,
        escrowTetri: result.escrowTetri,
      });

      const message =
        `Bracket cleared · ${result.deletedMatches} match(es) deleted · ` +
        // Said explicitly because it is the question an operator asks next:
        // resetting looks destructive, and the money is deliberately untouched.
        `${result.entryCount} entries and ${formatTetri(result.escrowTetri)} of escrow kept.`;

      return NextResponse.json({ ok: true, ...result, message });
    } catch (err) {
      return adminOpsErrorResponse(err, { fallback: "Could not reset the bracket" });
    }
  }
);
