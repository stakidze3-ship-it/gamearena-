import { NextResponse } from "next/server";
import { z } from "zod";
import {
  advanceKnockout,
  cancelTournamentNow,
  endTournamentNow,
  generateKnockout,
  prisma,
} from "@gamearena/db";
import { adminOpsErrorResponse, readJsonBody } from "@/lib/admin-ops-http";
import { withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Operator controls reachable from the tournament page itself.
 *
 * A fill-triggered lobby can stall — not enough players show up, or a bracket
 * needs settling by hand — so an admin can draw it early with whoever is
 * seated, refund everyone, or force settlement without opening the console.
 *
 * This used to call cancelTournamentRefunding and finalizeKnockout directly,
 * making it a SECOND implementation of two verbs the console already owns — and
 * the two had drifted. This path never swept bot balances back to treasury, so
 * cancelling a bot-filled event from here left minted credit stranded in bot
 * wallets; it had no status guard, so it would happily "cancel" an event that
 * had already finished; and it moved real money while writing no audit row.
 *
 * It now delegates to the same operations the console calls, so there is one
 * implementation per verb and one place for a guard to live.
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  tournamentId: z.string().min(1),
  action: z.enum(["start", "cancel", "finalize"]),
});

export const POST = withAdminAudit(
  { action: "tournament.operate", targetType: "tournament" },
  async ({ req, audit }) => {
    const parsed = schema.safeParse(await readJsonBody(req));
    if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });
    const { tournamentId, action } = parsed.data;

    const t = await prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { id: true, name: true, format: true, status: true },
    });
    if (!t) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });

    // Named before the operation runs, so a refusal still records what was
    // attempted rather than leaving a gap exactly where an investigation looks.
    audit.action(`tournament.${action}`);
    audit.target(t.id, t.name);
    audit.meta({ via: "tournament-page", format: t.format, statusBefore: t.status });

    try {
      if (action === "cancel") {
        const result = await cancelTournamentNow(tournamentId);
        audit.meta({ ...result });
        return NextResponse.json({ ok: true, ...result });
      }

      if (action === "start") {
        if (t.format !== "KNOCKOUT") {
          return NextResponse.json({ error: "Only knockouts are drawn" }, { status: 400 });
        }
        if (t.status !== "SCHEDULED") {
          return NextResponse.json({ error: "This event has already started" }, { status: 409 });
        }
        const placed = await generateKnockout(tournamentId);
        if (placed === 0) {
          return NextResponse.json(
            { error: "Need at least 2 players to draw a bracket" },
            { status: 409 }
          );
        }
        await advanceKnockout(tournamentId);
        audit.meta({ placed });
        return NextResponse.json({ ok: true, placed });
      }

      const result = await endTournamentNow(tournamentId);
      audit.meta({ ...result });
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      // The operations layer throws sentences for refusals a guard caught.
      // Classifying them keeps a correct refusal from being reported as a
      // platform fault, which is what sends an operator to press the button
      // again on an event that is already resolved.
      return adminOpsErrorResponse(err, { fallback: "That action did not go through" });
    }
  }
);
