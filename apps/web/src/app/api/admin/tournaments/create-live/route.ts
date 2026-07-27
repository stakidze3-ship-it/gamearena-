import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { createLiveTournament } from "@/lib/admin-tournament-create";
import { readJsonBody } from "@/lib/admin-ops-http";

/**
 * Admin-only: create a REAL knockout tournament — one players can see and enter.
 *
 * The console calls this rather than the older /create because the name has to
 * say which of the two dangerous things is about to happen: this event is
 * player-visible the moment it exists and real balance can be spent on entry,
 * where /create-test is hidden and disposable. The implementation is shared
 * with /create (see lib/admin-tournament-create), so the validation and the
 * prize maths exist exactly once.
 *
 * Body — every field optional except capacity, so the console can send only the
 * two dials it exposes:
 *   { name?, gameKey?, capacity, entryTetri? | entryLari?,
 *     prizeStructure? | prizesLari?, roundDurationS?, readyWindowS? }
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // First, before the body is even read: requireAdmin redirects rather than
  // returning, so a non-admin never reaches the creation path at all.
  await requireAdmin();
  return createLiveTournament(await readJsonBody(req));
}
