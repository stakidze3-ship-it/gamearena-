import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { forceAdvancePlayer } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";
import { adminOpsErrorResponse, readJsonBody } from "@/lib/admin-ops-http";

/**
 * Admin-only: push a named player through their current match in a running
 * knockout.
 *
 * The support tool for a pairing that cannot resolve itself — a crashed client,
 * a run lost on submission, an opponent who demonstrably will not appear. It
 * awards the open match to this player regardless of the scores and lets the
 * ordinary driver open the next round.
 *
 * This is an override of a server-verified result, not a shortcut for one: it
 * is the same operation as declaring a match winner, addressed by player rather
 * than by match id because that is how an operator arrives at it — from a
 * support ticket naming a person, not from a bracket match id.
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  userId: z.string().min(1, "A player is required"),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  const parsed = schema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid player" },
      { status: 400 }
    );
  }

  try {
    const result = await forceAdvancePlayer(id, parsed.data.userId);
    const message = result.advancedTo
      ? `Advanced out of the ${result.roundLabel} into round ${result.advancedTo.round}, slot ${result.advancedTo.slot}.`
      : `Awarded the ${result.roundLabel} — there is no round after it.`;

    return NextResponse.json({ ok: true, ...result, message });
  } catch (err) {
    return adminOpsErrorResponse(err, { fallback: "Could not advance that player" });
  }
}
