import { NextResponse } from "next/server";
import { z } from "zod";
import { ADMIN_ADJUSTMENT_MAX_TETRI, prisma, setExactBalance } from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";
import { adminOpsErrorResponse } from "@/lib/admin-ops-http";
import { withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: put one player's balance on an exact number.
 *
 * The sibling of /balance, and the difference is what the operator has in their
 * head. "Credit ₾5" is an adjustment and belongs there; "this account should be
 * showing ₾20" is a target, and making the operator subtract the current
 * balance themselves — off a figure that may have changed since the page
 * rendered — is how the wrong amount gets typed and then paid.
 *
 * The subtraction therefore happens server-side against a balance read at the
 * moment of the write, and the DIFFERENCE is what moves through the ledger.
 * Nothing here writes a balance; setExactBalance has no code path that could.
 *
 * The route is the guard layer: it proves the caller is an admin, validates the
 * shape, and refuses the one target the ops layer cannot judge for itself — a
 * bot, whose wallet is owned by the tournament funding sweep.
 */
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /**
   * The balance this account should END UP with, in integer tetri. Non-negative
   * because USER_CASH has a zero floor, and capped at the same ceiling as a
   * hand adjustment — imported rather than restated, so a second copy of the
   * limit cannot drift away from the one the ledger enforces.
   */
  targetTetri: z
    .number()
    .int("Target must be a whole number of tetri.")
    .min(0, "Target must not be negative — a cash balance cannot go below zero.")
    .max(
      ADMIN_ADJUSTMENT_MAX_TETRI,
      `Balances are capped at ${formatTetri(ADMIN_ADJUSTMENT_MAX_TETRI)} per hand-set target.`
    ),
  /**
   * Recorded in the ledger memo alongside the issuing admin's name. Explained
   * the same way whether it is missing, the wrong type or too short — Zod's
   * default for an absent field describes a parser rather than telling the
   * operator what to do.
   */
  reason: z
    .string({ error: "Give a reason — it is written into the ledger." })
    .trim()
    .min(3, "Give a reason — it is written into the ledger.")
    .max(120),
  /**
   * Optional, and the default is the interesting part.
   *
   * The console sends a fresh reference per press, which is what makes two
   * deliberate set-balance calls two calls. When it is absent — a script, a
   * curl during an incident — the key falls back to the target plus a
   * one-minute bucket, so a double-click or a retry inside the same minute
   * collapses into one posting while a different target still goes through.
   * The bucket is deliberately part of it: a key without one would make this a
   * once-ever action per account, and a key without the target would swallow
   * "set to ₾3, then set to ₾10" as a repeat.
   */
  reference: z.string().trim().min(1).max(60).optional(),
});

export const POST = withAdminAudit<{ id: string }>(
  { action: "user.balance.set-exact", targetType: "user", targetIdParam: "id" },
  async ({ req, admin, params, audit }) => {
    const { id } = params;

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid target" },
        { status: 400 }
      );
    }
    const { targetTetri, reason } = parsed.data;
    const reference = parsed.data.reference ?? `auto:${targetTetri}:${Math.floor(Date.now() / 60_000)}`;

    // Recorded BEFORE the operation runs, so a refusal below is still logged
    // with the figures that were attempted rather than as a bare "failed".
    audit.reason(reason);
    audit.meta({ targetTetri, reference });

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true, isBot: true },
    });
    if (!target) {
      return NextResponse.json({ error: "No account with that id" }, { status: 404 });
    }
    audit.label(target.username);

    if (target.isBot) {
      // A bot is funded from treasury when it is seated and swept back when its
      // event ends. Pinning one to a number would leave minted money parked in
      // a wallet nothing ever settles, and the imbalance would surface later as
      // an unexplained treasury drift.
      return NextResponse.json(
        {
          error: `${target.username} is a bot — bot balances are managed by the bot funding path.`,
        },
        { status: 400 }
      );
    }

    try {
      const result = await setExactBalance(id, targetTetri, reason, admin.username, reference);

      // The movement is not chosen by the operator — it is whatever the gap
      // happened to be — so without the before, after and delta the audit row
      // cannot say how much money this actually moved.
      audit.meta({
        balanceBeforeTetri: result.balanceBeforeTetri,
        balanceAfterTetri: result.balanceAfterTetri,
        deltaTetri: result.deltaTetri,
        alreadyApplied: result.alreadyApplied,
        reachedTarget: result.reachedTarget,
      });

      // Three genuinely different outcomes, and flattening them into one
      // "done" is how an operator comes to believe a balance is a number it is
      // not. The reused-reference case especially: the call succeeded, nothing
      // moved, and the account is NOT on the target.
      const message = !result.reachedTarget
        ? `Reference "${reference}" was already used, so nothing moved — ${target.username} is holding ${formatTetri(result.balanceAfterTetri)}, not ${formatTetri(targetTetri)}. Re-send with a new reference to set it.`
        : !result.changed
          ? `${target.username} was already holding exactly ${formatTetri(targetTetri)} — nothing to do.`
          : `${target.username} set from ${formatTetri(result.balanceBeforeTetri)} to ${formatTetri(result.balanceAfterTetri)} (${result.deltaTetri > 0 ? "credited" : "debited"} ${formatTetri(Math.abs(result.deltaTetri))}).`;

      return NextResponse.json({ ok: true, ...result, message });
    } catch (err) {
      // Classified in one shared place rather than here, so every admin route
      // gives the console the same status for the same kind of refusal.
      // requireAdmin is handled by withAdminAudit, which runs it before this
      // handler is called and outside every try: it signals a redirect by
      // throwing, and catching that would hide the auth failure.
      return adminOpsErrorResponse(err, { fallback: "Setting the balance failed." });
    }
  }
);
