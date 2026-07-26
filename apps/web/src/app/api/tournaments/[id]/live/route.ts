import { NextRequest, NextResponse } from "next/server";
import { liveTournamentView, recordSpectator, sweepSpectators } from "@gamearena/db";
import { getCurrentUser } from "@/lib/auth";

/**
 * Everything a spectator screen needs for one tournament, in one request.
 *
 * The payload covers EVERY live match, not one — a viewer watching the final
 * still sees the other matches' scores tick in the switcher without issuing a
 * request per match. That keeps a spectator O(1) in the size of the bracket,
 * which is the difference between a 63-match knockout being cheap and being a
 * fan-out disaster.
 *
 * `?watching=<matchId>` records a heartbeat for the match the viewer actually
 * has open. Clients should send it far less often than they poll — see
 * SPECTATOR_TTL_MS — because the heartbeat writes and the poll does not.
 *
 * Poll-driven by necessity: production has no WebSocket host. `liveKey` changes
 * only when something visible changed, so a client can skip the re-render.
 */
export const dynamic = "force-dynamic";

/** Opportunistic sweep, roughly one request in fifty. Cheap and indexed. */
function shouldSweep(): boolean {
  return Math.random() < 0.02;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const watching = req.nextUrl.searchParams.get("watching");

  const user = await getCurrentUser();
  if (watching && user) {
    // Never let a heartbeat failure break the poll — the view still renders.
    await recordSpectator(id, watching, user.id).catch(() => {});
  }
  if (shouldSweep()) await sweepSpectators().catch(() => {});

  const view = await liveTournamentView(id);
  if (!view) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}
