import { NextRequest, NextResponse } from "next/server";
import { fillTournamentWithBots, prisma } from "@gamearena/db";
import { KNOCKOUT_CONFIG } from "@gamearena/shared";
import { requireAdmin } from "@/lib/auth";

/**
 * Admin-only: seat every empty chair with a bot so a whole knockout can be run
 * end to end on demand.
 *
 * Reachability, not just visibility: requireAdmin() runs before anything else,
 * and it redirects rather than returning — a non-admin cannot reach the bot
 * fill by guessing the URL, and the UI that offers it lives under /admin, which
 * is gated by its own layout. Hiding a button is not a permission model.
 *
 * The bots join through joinTournament exactly as humans do, so capacity, the
 * escrow and the fill trigger stay consistent. Filling the last seat starts the
 * ordinary countdown; the bracket is drawn by the same poll-driven path that
 * serves real events. Nothing here shortcuts the tournament lifecycle.
 */
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  const t = await prisma.tournament.findUnique({
    where: { id },
    select: { id: true, status: true, format: true, capacity: true },
  });
  if (!t) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
  if (t.format !== "KNOCKOUT") {
    return NextResponse.json({ error: "Bot fill is for knockout brackets" }, { status: 400 });
  }
  if (t.status !== "SCHEDULED") {
    return NextResponse.json(
      { error: `Cannot fill a tournament that is ${t.status}` },
      { status: 409 }
    );
  }

  try {
    const result = await fillTournamentWithBots(id, KNOCKOUT_CONFIG.countdownS);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Bot fill failed" },
      { status: 500 }
    );
  }
}
