import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { createLiveTournament } from "@/lib/admin-tournament-create";
import { readJsonBody } from "@/lib/admin-ops-http";

/**
 * Admin-only: create a REAL knockout tournament — one players can see and enter.
 *
 * The original name for what the admin console now calls
 * /api/admin/tournaments/create-live. It is kept so an existing caller does not
 * suddenly 404, and it is deliberately NOT a second implementation: both
 * handlers delegate to lib/admin-tournament-create, so there is one set of
 * rules about entry fees, prize splits and what "live" means. Two routes that
 * each half-validate a live event is precisely how one of them ends up
 * promising prizes the escrow cannot cover.
 *
 * Its body is unchanged and still accepted — { name, gameKey?, capacity,
 * entryLari, prizesLari, roundDurationS?, readyWindowS? } — with every field
 * except capacity now optional, and tetri accepted alongside lari.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Before the body is read: requireAdmin redirects rather than returning, so a
  // non-admin never reaches the creation path at all.
  await requireAdmin();
  return createLiveTournament(await readJsonBody(req));
}
