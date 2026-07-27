import { auditableTournamentRequest, createLiveTournament } from "@/lib/admin-tournament-create";
import { readJsonBody } from "@/lib/admin-ops-http";
import { withAdminAudit } from "@/lib/with-admin-audit";

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

export const POST = withAdminAudit(
  // A separate action from /create even though the implementation is shared:
  // this is the URL the console uses, and an event created here was created by
  // a person looking at a confirmation dialog rather than by a script.
  { action: "tournament.create-live", targetType: "tournament" },
  async ({ req, audit }) => {
    const body = await readJsonBody(req);

    // Recorded before creation. A live event can take real money from real
    // players, so what was requested has to survive the request being refused —
    // "prizes total more than the pool" is a refusal worth being able to find.
    audit.meta({ requested: auditableTournamentRequest(body), live: true });

    // The id exists only after the create, so the target is filed from inside.
    return createLiveTournament(body, (created) => audit.target(created.id, created.name));
  }
);
