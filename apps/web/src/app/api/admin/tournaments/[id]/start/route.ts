import { NextRequest, NextResponse } from "next/server";
import { cancelTournamentRefunding, generateKnockout, prisma } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";

/**
 * Admin-only: draw the bracket right now instead of waiting out the countdown.
 *
 * Filling the last seat normally starts a sixty-second countdown before the
 * draw, which is right for real players and tedious when testing. This pulls
 * `startsAt` back to now and runs the same draw the poll driver would have
 * run — it does not bypass the lifecycle, it just stops waiting.
 */
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  const t = await prisma.tournament.findUnique({
    where: { id },
    select: { id: true, status: true, format: true, _count: { select: { entries: true } } },
  });
  if (!t) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
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
    return NextResponse.json({ error: "Too few players — entries refunded." }, { status: 409 });
  }
  return NextResponse.json({ ok: true, placed });
}
