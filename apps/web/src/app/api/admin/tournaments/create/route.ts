import { auditableTournamentRequest, createLiveTournament } from "@/lib/admin-tournament-create";
import { readJsonBody } from "@/lib/admin-ops-http";
import { withAdminAudit } from "@/lib/with-admin-audit";

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
 *
 * Logged under its own action rather than the one /create-live uses, because
 * "which URL created this event" is the only way to tell an integration or a
 * script apart from an operator working the console.
 */
export const dynamic = "force-dynamic";

export const POST = withAdminAudit(
  // The wrapper runs requireAdmin() before the body is read, so a non-admin
  // never reaches the creation path at all — the guard this route used to make
  // its own first statement.
  { action: "tournament.create", targetType: "tournament" },
  async ({ req, audit }) => {
    const body = await readJsonBody(req);

    // Before the creation, so a rejected event — prizes over the pool, an
    // unknown game — still records what was asked for. This is the whole
    // specification of a thing that can take real entry money.
    audit.meta({ requested: auditableTournamentRequest(body) });

    // The id exists only after the create, so the target is filed from inside.
    return createLiveTournament(body, (created) => audit.target(created.id, created.name));
  }
);
