import { NextResponse } from "next/server";
import { prisma } from "@gamearena/db";

/**
 * Refuse a match id that is not a bracket match, with a reason.
 *
 * The console's match list mixes knockout pairings and 1v1 duels — an operator
 * hunting stuck money needs to see both — and offers the same Force finish and
 * Declare winner buttons against every row. Only the bracket half can be
 * decided by hand: a duel settles on its own clock through the escrow path, and
 * nothing in the admin operations layer knows how to resolve one.
 *
 * Without this, pressing those buttons on a duel would return "Match not found"
 * for a match the operator is looking at on screen, which reads as a bug in the
 * console rather than as an unsupported action. Naming the situation is the
 * difference between an operator moving on and an operator filing an incident.
 *
 * Returns null when the id IS a bracket match and the caller should proceed.
 */
export async function refuseIfNotBracketMatch(matchId: string): Promise<NextResponse | null> {
  const bracket = await prisma.bracketMatch.findUnique({
    where: { id: matchId },
    select: { id: true },
  });
  if (bracket) return null;

  const duel = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, status: true },
  });
  if (duel) {
    return NextResponse.json(
      {
        error:
          "That is a 1v1 duel, not a bracket match. Duels settle on their own clock and cannot be decided from here.",
        code: "DUEL_NOT_SUPPORTED",
      },
      { status: 409 }
    );
  }

  return NextResponse.json({ error: "Match not found" }, { status: 404 });
}
