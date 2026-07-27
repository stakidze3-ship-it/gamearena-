import { NextRequest, NextResponse } from "next/server";
import { prisma, resetDemoBalance } from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";
import { adminOpsErrorResponse } from "@/lib/admin-ops-http";
import { requireAdmin } from "@/lib/auth";

/**
 * Admin-only: put a player's demo cash back to the signup grant, exactly.
 *
 * The tester's button. While the platform runs on demo credit, "I have spent my
 * ₾5 and cannot try the thing you asked me to try" is the most common support
 * request there is, and answering it by hand-crediting an arbitrary amount
 * makes every later balance question unanswerable.
 *
 * It balances rather than writes: the difference between the current balance
 * and the grant is posted against treasury as one zero-sum ADJUSTMENT, so it
 * works in both directions and never breaks double entry. ADJUSTMENT, not
 * ADMIN_ADJUSTMENT — a reset is machinery, and burying it among discretionary
 * operator movements would hide the ones an auditor is looking for.
 *
 * No body. There is exactly one target amount and it is read from
 * SIGNUP_CREDIT_TETRI inside the op, so "reset" cannot drift from "what a new
 * player starts with". The idempotency key carries a one-minute bucket, so a
 * double-click collapses into one posting while a deliberate reset later in the
 * session still works.
 *
 * It does not touch the vault: those credits are a separate economy, and
 * clearing them as a side effect of a cash reset would destroy something the
 * player earned.
 */
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  const target = await prisma.user.findUnique({
    where: { id },
    select: { username: true, isBot: true },
  });
  if (!target) {
    return NextResponse.json({ error: "No account with that id" }, { status: 404 });
  }
  if (target.isBot) {
    // A bot is funded from treasury when it is seated and swept back when the
    // event ends. Resetting one to the signup grant would leave minted money
    // sitting in a wallet that nothing ever settles.
    return NextResponse.json(
      { error: `${target.username} is a bot — bot funding is handled by the tournament sweep.` },
      { status: 400 }
    );
  }

  try {
    const result = await resetDemoBalance(id);
    return NextResponse.json({
      ok: true,
      username: target.username,
      ...result,
      message: result.changed
        ? `${target.username} reset from ${formatTetri(result.balanceBeforeTetri)} to ${formatTetri(result.balanceAfterTetri)}.`
        : `${target.username} was already holding exactly ${formatTetri(result.targetTetri)} — nothing to do.`,
    });
  } catch (err) {
    // A reset moves money, so the ledger's own guards can still refuse it.
    // Classified by the shared mapper so a refusal and a genuine fault do not
    // arrive at the console looking the same.
    return adminOpsErrorResponse(err, { fallback: "Reset failed." });
  }
}
