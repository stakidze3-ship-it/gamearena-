import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { removePlayerFromTournament } from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";
import { requireAdmin } from "@/lib/auth";
import { adminOpsErrorResponse, readJsonBody } from "@/lib/admin-ops-http";

/**
 * Admin-only: take one entrant out of a tournament that has not been drawn,
 * refunding what they actually paid.
 *
 * SCHEDULED only — the operations layer refuses once a bracket exists, because
 * pulling someone out of a drawn bracket leaves a live match with a missing
 * opponent and no rule for what happens next.
 *
 * A repeat call is NOT an error. The operation is idempotent per
 * (tournament, player) and reports `removed: false` when there was nothing to
 * take out, which is exactly what a double-click or a stale console looks like.
 * Answering that with a 4xx would have an operator hunting a problem that does
 * not exist, so it comes back as a 200 that says plainly that nothing moved.
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
    const result = await removePlayerFromTournament(id, parsed.data.userId);
    const message = result.removed
      ? `Entry removed · ${formatTetri(result.refundedTetri)} refunded to the player.`
      : "That player is not in this tournament — nothing was refunded.";

    return NextResponse.json({ ok: true, ...result, message });
  } catch (err) {
    return adminOpsErrorResponse(err, { fallback: "Could not remove that player" });
  }
}
