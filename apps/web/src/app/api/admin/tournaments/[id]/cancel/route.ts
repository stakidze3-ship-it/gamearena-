import { NextResponse } from "next/server";
import { cancelTournamentNow } from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";
import { adminOpsErrorResponse } from "@/lib/admin-ops-http";
import { auditTournamentLabel, withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: cancel an event and make every entrant whole.
 *
 * The escrowed pool is split back across the field by the engine's own
 * `cancelTournamentRefunding`, which is idempotent — a double-click cannot
 * refund twice. Bots are refunded like everyone else and then swept back to
 * treasury, so no bot is left holding a balance.
 *
 * SCHEDULED or RUNNING only, and irreversible: the event leaves the Tournaments
 * page and the escrow is empty afterwards. The console gates it behind a
 * type-the-name confirmation for that reason.
 *
 * Takes no body.
 */
export const dynamic = "force-dynamic";

export const POST = withAdminAudit<{ id: string }>(
  { action: "tournament.cancel", targetType: "tournament", targetIdParam: "id" },
  async ({ params, audit }) => {
    const { id } = params;

    // Read BEFORE the cancellation, and this is the route where that ordering
    // matters most: a cancelled event is the one most likely to be purged later,
    // and "tournament clx7f2k9m0001 was cancelled" is unreadable a quarter from
    // now while the name is not.
    await auditTournamentLabel(audit, id);

    try {
      const result = await cancelTournamentNow(id);

      // A cancellation is a mass refund out of escrow, so the row carries what
      // moved and to whom: the player refunds, how many entries they covered,
      // and the bot money swept back to treasury rather than left in wallets
      // nothing settles.
      audit.meta({
        refundedTetri: result.refundedTetri,
        refundedEntries: result.refundedEntries,
        botTetriRecovered: result.botTetriRecovered,
      });

      const message =
        `Cancelled · ${formatTetri(result.refundedTetri)} refunded across ${result.refundedEntries} entries` +
        (result.botTetriRecovered > 0
          ? ` · ${formatTetri(result.botTetriRecovered)} of bot money returned to treasury`
          : "");

      return NextResponse.json({ ok: true, ...result, message });
    } catch (err) {
      return adminOpsErrorResponse(err, { fallback: "Could not cancel the tournament" });
    }
  }
);
