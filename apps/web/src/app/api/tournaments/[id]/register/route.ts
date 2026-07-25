import { NextRequest, NextResponse } from "next/server";
import { joinTournament } from "@gamearena/db";
import { KNOCKOUT_CONFIG } from "@gamearena/shared";
import { getCurrentUser } from "@/lib/auth";

/**
 * Take a seat. Every rule about capacity, escrow and closing registration lives
 * in `joinTournament` so the scheduler, admin tools and this route cannot drift
 * apart; the route only handles identity and HTTP.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.selfExcludedUntil && user.selfExcludedUntil > new Date()) {
    return NextResponse.json({ error: "Self-exclusion active" }, { status: 403 });
  }

  const result = await joinTournament(id, user.id, KNOCKOUT_CONFIG.countdownS);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    seed: result.seed,
    alreadyEntered: result.alreadyEntered,
    entryCount: result.entryCount,
    capacity: result.capacity,
    full: result.full,
    startsAt: result.startsAt.toISOString(),
  });
}
