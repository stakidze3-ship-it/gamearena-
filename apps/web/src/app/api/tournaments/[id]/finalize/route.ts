import { NextRequest, NextResponse } from "next/server";
import { finalizeKnockout, finalizeTournament, prisma } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";

/**
 * Settle a tournament by hand.
 *
 * The two formats settle completely differently — a knockout is decided by its
 * bracket, a leaderboard by best scores — so this must dispatch on format.
 * Running the leaderboard settlement over a knockout would find no scored
 * entries, award nothing, and sweep the entire escrowed pool to rake.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdmin();

  const t = await prisma.tournament.findUnique({
    where: { id },
    select: { format: true },
  });
  if (!t) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });

  // finalizeKnockout refuses to settle until the final is decided, so an early
  // call is a safe no-op rather than a payout.
  if (t.format === "KNOCKOUT") await finalizeKnockout(id);
  else await finalizeTournament(id);

  return NextResponse.json({ ok: true });
}
