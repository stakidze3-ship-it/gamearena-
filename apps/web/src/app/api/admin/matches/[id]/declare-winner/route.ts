import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { declareMatchWinner } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";
import { adminOpsErrorResponse, readJsonBody } from "@/lib/admin-ops-http";
import { refuseIfNotBracketMatch } from "@/lib/admin-match-target";

/**
 * Admin-only: hand a bracket match to a named participant regardless of score.
 *
 * The override for when the score is not the truth — a run lost to a crash, a
 * disqualification, a match a support ticket has already settled. Deliberately
 * a different endpoint from force-finish, which applies the ordinary rule: an
 * audit has to be able to tell "the operator hurried the clock" apart from "the
 * operator overrode the result", and one endpoint with a flag would blur them.
 *
 * OPEN matches only, and the named winner must be one of the two players — the
 * operations layer refuses anyone else, so a mistyped id cannot promote a
 * stranger into the next round.
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  winnerUserId: z.string().min(1, "A winner is required"),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  const parsed = schema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid winner" },
      { status: 400 }
    );
  }

  const wrongKind = await refuseIfNotBracketMatch(id);
  if (wrongKind) return wrongKind;

  try {
    const result = await declareMatchWinner(id, parsed.data.winnerUserId);
    const message =
      `${result.winnerUsername} declared the winner of the ${result.roundLabel} (scores were ${result.aScore ?? 0}–${result.bScore ?? 0})` +
      (result.advancedTo
        ? ` · advanced to round ${result.advancedTo.round}, slot ${result.advancedTo.slot}.`
        : " · that was the last match of the bracket.");

    return NextResponse.json({ ok: true, ...result, message });
  } catch (err) {
    return adminOpsErrorResponse(err, { fallback: "Could not declare that winner" });
  }
}
