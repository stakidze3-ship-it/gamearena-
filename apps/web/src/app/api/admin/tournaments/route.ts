import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  advanceKnockout,
  cancelKnockout,
  finalizeKnockout,
  finalizeTournament,
  generateKnockout,
  prisma,
} from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";

/**
 * Operator controls for a live event. A fill-triggered lobby can stall — not
 * enough players show up, or a bracket needs settling by hand — so an admin can
 * draw it early with whoever is seated, refund everyone, or force settlement.
 * All three reuse the engine's own idempotent entry points.
 */
const schema = z.object({
  tournamentId: z.string().min(1),
  action: z.enum(["start", "cancel", "finalize"]),
});

export async function POST(req: NextRequest) {
  await requireAdmin();
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });
  const { tournamentId, action } = parsed.data;

  const t = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { id: true, format: true, status: true },
  });
  if (!t) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });

  if (action === "cancel") {
    await cancelKnockout(tournamentId); // refunds every entry from escrow
    return NextResponse.json({ ok: true, status: "CANCELLED" });
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
    return NextResponse.json({ ok: true, placed });
  }

  if (t.format === "KNOCKOUT") await finalizeKnockout(tournamentId);
  else await finalizeTournament(tournamentId);
  return NextResponse.json({ ok: true });
}
