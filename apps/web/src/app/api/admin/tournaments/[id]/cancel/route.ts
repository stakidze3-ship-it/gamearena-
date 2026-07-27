import { NextRequest, NextResponse } from "next/server";
import { cancelTournamentNow } from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";
import { requireAdmin } from "@/lib/auth";
import { adminOpsErrorResponse } from "@/lib/admin-ops-http";

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

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  try {
    const result = await cancelTournamentNow(id);
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
