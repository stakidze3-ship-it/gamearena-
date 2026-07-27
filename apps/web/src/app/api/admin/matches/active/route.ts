import { NextResponse } from "next/server";
import { listActiveMatches, type ActiveMatchPlayer } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";
import { adminOpsErrorResponse } from "@/lib/admin-ops-http";

/**
 * Admin-only: everything currently in play, in one list.
 *
 * Open bracket matches across every running tournament, plus live 1v1 duels,
 * ordered by which deadline lands first — that is the order an operator has to
 * act in — with clockless (stuck) matches last, since they are not urgent so
 * much as broken.
 *
 * GET rather than POST because it changes nothing, and force-dynamic because a
 * cached answer on this screen is worse than no answer at all: an operator
 * deciding a match from a stale list is deciding a match that may already have
 * resolved itself.
 */
export const dynamic = "force-dynamic";

/**
 * An empty side is sent as a filled-in shape rather than as null.
 *
 * A bracket slot genuinely can be empty — a bye, or a next-round match whose
 * other semifinal has not finished — and the console reads `a.username` and
 * `a.played` directly. Sending null there would not render "no opponent yet",
 * it would throw inside the list and take the whole admin screen down at
 * exactly the moment somebody needs it.
 */
const EMPTY_SIDE = { userId: null, username: null, score: null, played: false, isBot: false };

const side = (player: ActiveMatchPlayer | null) => player ?? EMPTY_SIDE;

export async function GET() {
  await requireAdmin();

  try {
    const active = await listActiveMatches();

    const matches = active.map((m) => ({
      ...m,
      // Lowercased for the console's own discriminant. The operations layer
      // uses the database's uppercase spelling; the wire format follows the
      // consumer, and there is exactly one consumer.
      kind: m.kind.toLowerCase(),
      a: side(m.a),
      b: side(m.b),
      // Always null today, and deliberately present. The replay viewer requires
      // a DONE row with both input logs stored, and by definition nothing in
      // this list is finished — so a live match never has a replay to link to.
      // The field stays so the console can show the link without a second
      // shape, if this list ever grows to include just-settled matches.
      replayHref: null,
    }));

    return NextResponse.json({
      ok: true,
      matches,
      count: matches.length,
      message: matches.length === 0 ? "No matches are open right now." : undefined,
    });
  } catch (err) {
    return adminOpsErrorResponse(err, { fallback: "Could not load active matches" });
  }
}
