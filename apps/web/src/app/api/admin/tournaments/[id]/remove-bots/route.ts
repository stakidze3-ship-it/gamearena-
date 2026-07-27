import { NextRequest, NextResponse } from "next/server";
import { removeBotsFromTournament } from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";
import { requireAdmin } from "@/lib/auth";
import { adminOpsErrorResponse } from "@/lib/admin-ops-http";

/**
 * Admin-only: take every bot back out of a tournament that has not been drawn.
 *
 * The undo for a bot fill — an event padded to test something, then wanted back
 * as a genuine human field. Their entry fees return to treasury rather than to
 * the bots' wallets, because that is where they were minted from; the
 * operations layer explains why at length.
 *
 * Takes no body. requireAdmin() runs first and redirects rather than returning,
 * so this is not reachable by guessing the URL.
 */
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  try {
    const result = await removeBotsFromTournament(id);
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
