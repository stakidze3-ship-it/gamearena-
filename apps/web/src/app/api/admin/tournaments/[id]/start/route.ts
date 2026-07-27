import { NextResponse } from "next/server";
import { cancelTournamentRefunding, generateKnockout, prisma } from "@gamearena/db";
import { withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: draw the bracket right now instead of waiting out the countdown.
 *
 * Filling the last seat normally starts a sixty-second countdown before the
 * draw, which is right for real players and tedious when testing. This pulls
 * `startsAt` back to now and runs the same draw the poll driver would have
 * run — it does not bypass the lifecycle, it just stops waiting.
 */
export const dynamic = "force-dynamic";

export const POST = withAdminAudit<{ id: string }>(
  { action: "tournament.start", targetType: "tournament", targetIdParam: "id" },
  async ({ params, audit }) => {
    const { id } = params;

    const t = await prisma.tournament.findUnique({
      where: { id },
      // `name` is selected purely so the audit row can carry it, which is one
      // read rather than the extra lookup auditTournamentLabel would do. Nothing
      // below branches on it.
      select: {
        id: true,
        name: true,
        status: true,
        format: true,
        _count: { select: { entries: true } },
      },
    });
    if (!t) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
    audit.label(t.name);
    // The state the draw was fired against, recorded before the refusals below
    // so a bounced attempt still says what the event actually looked like at the
    // time — "Tournament is FINISHED" alone does not.
    audit.meta({ statusBefore: t.status, entryCount: t._count.entries });

    if (t.format !== "KNOCKOUT") {
      return NextResponse.json({ error: "Only knockout brackets are drawn" }, { status: 400 });
    }
    if (t.status === "RUNNING") return NextResponse.json({ ok: true, alreadyRunning: true });
    if (t.status !== "SCHEDULED") {
      return NextResponse.json({ error: `Tournament is ${t.status}` }, { status: 409 });
    }
    if (t._count.entries < 2) {
      return NextResponse.json(
        { error: "Needs at least 2 players — fill it with bots first." },
        { status: 409 }
      );
    }

    // Bring the countdown forward, then draw exactly as the driver does.
    await prisma.tournament.update({ where: { id }, data: { startsAt: new Date() } });
    const placed = await generateKnockout(id);
    if (placed === 0) {
      await cancelTournamentRefunding(id);
      // This path moves money — every entry is refunded — so it is recorded as
      // more than the 409 it looks like. An operator who pressed "start" and
      // found the event cancelled needs the row to say the draw failed and the
      // field was paid back.
      audit.meta({ placed: 0, cancelledAndRefunded: true });
      return NextResponse.json({ error: "Too few players — entries refunded." }, { status: 409 });
    }
    audit.meta({ placed });
    return NextResponse.json({ ok: true, placed });
  }
);
