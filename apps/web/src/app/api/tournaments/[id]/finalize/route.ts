import { NextResponse } from "next/server";
import { finalizeKnockout, finalizeTournament, prisma } from "@gamearena/db";
import { withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Settle a tournament by hand.
 *
 * The two formats settle completely differently — a knockout is decided by its
 * bracket, a leaderboard by best scores — so this must dispatch on format.
 * Running the leaderboard settlement over a knockout would find no scored
 * entries, award nothing, and sweep the entire escrowed pool to rake.
 *
 * Two things were wrong with how it was gated, and both matter because this
 * route pays out prize money:
 *
 *   · It awaited the route params BEFORE requireAdmin(), inverting the rule the
 *     rest of the admin surface follows. Authorisation has to be the first
 *     thing that happens, not the second.
 *   · It wrote no audit row, while the identical settlement reached through the
 *     console records one. An operator settling an event from the tournament
 *     page left no trace at all — and a trail with a hole exactly where a
 *     duplicate code path exists is one an investigation cannot rely on.
 *
 * The wrapper fixes both: requireAdmin runs first and outside every try, and
 * the outcome is recorded whether it succeeds or is refused.
 */
export const dynamic = "force-dynamic";

export const POST = withAdminAudit<{ id: string }>(
  { action: "tournament.finalize", targetType: "tournament", targetIdParam: "id" },
  async ({ params, audit }) => {
    const { id } = params;

    const t = await prisma.tournament.findUnique({
      where: { id },
      select: { name: true, format: true, status: true },
    });
    if (!t) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });

    audit.label(t.name);
    audit.meta({ via: "tournament-page", format: t.format, statusBefore: t.status });

    // finalizeKnockout refuses to settle until the final is decided, so an early
    // call is a safe no-op rather than a payout.
    if (t.format === "KNOCKOUT") await finalizeKnockout(id);
    else await finalizeTournament(id);

    return NextResponse.json({ ok: true });
  }
);
