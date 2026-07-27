import { NextResponse } from "next/server";
import { z } from "zod";
import { ADMIN_ADJUSTMENT_MAX_TETRI, adminAdjustBalance, prisma } from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";
import { adminOpsErrorResponse } from "@/lib/admin-ops-http";
import { withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: move a player's balance by hand, in either direction.
 *
 * Positive credits, negative debits. The ledger work — double entry against
 * treasury, the ADMIN_ADJUSTMENT kind, the idempotency key, the overdraw guard
 * — all lives in adminAdjustBalance; this route is the guard layer around it:
 * it proves the caller is an admin, validates the shape, and refuses the two
 * targets the ops layer cannot judge for itself.
 *
 * The amount bound is ADMIN_ADJUSTMENT_MAX_TETRI, imported rather than
 * restated. A second copy of the cap here would eventually disagree with the
 * one in the ledger, and the disagreement would be discovered by a slipped
 * decimal point settling.
 *
 * The caller supplies `reference`, and two genuine adjustments need two of
 * them: the key is `admin-adjust:<userId>:<reference>`, so re-sending the same
 * reference returns the first result instead of paying twice. When that
 * happens the response says `alreadyApplied: true` — that is a successful,
 * idempotent no-op, not an error, and the console must not retry it.
 */
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /**
   * Signed integer tetri. Integer because all money in this system is integer
   * tetri (1 GEL = 100), and a float here would be a rounding error that ends
   * up in someone's wallet.
   */
  amountTetri: z
    .number()
    .int("Amount must be a whole number of tetri.")
    .refine((n) => n !== 0, "Amount must not be zero — there is nothing to adjust.")
    .refine(
      (n) => Math.abs(n) <= ADMIN_ADJUSTMENT_MAX_TETRI,
      `Adjustments are capped at ${formatTetri(ADMIN_ADJUSTMENT_MAX_TETRI)} per action.`
    ),
  /** Recorded in the ledger memo alongside the issuing admin's name. */
  reason: z.string().trim().min(3, "Give a reason — it is written into the ledger.").max(120),
  /** What makes a repeat a repeat. Blank is refused by the ledger op too. */
  reference: z
    .string()
    .trim()
    .min(1, "A reference is required so a repeated click cannot pay twice.")
    .max(60),
});

export const POST = withAdminAudit<{ id: string }>(
  { action: "user.balance.adjust", targetType: "user", targetIdParam: "id" },
  async ({ req, admin, params, audit }) => {
    const { id } = params;

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid adjustment" },
        { status: 400 }
      );
    }
    const { amountTetri, reason, reference } = parsed.data;

    // Recorded BEFORE the operation runs, so a refusal below — a bot target, an
    // overdraw — is still logged with the figures that were attempted rather
    // than as a bare "failed".
    audit.reason(reason);
    audit.meta({ amountTetri, reference });

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true, isBot: true },
    });
    if (!target) {
      return NextResponse.json({ error: "No account with that id" }, { status: 404 });
    }
    audit.label(target.username);

    if (target.isBot) {
      // Bot fees are minted from treasury when they are seated and swept back
      // when the event ends, so no bot is supposed to hold a balance outside a
      // live event. Hand-crediting one would leave minted money parked in a
      // wallet nothing ever settles, and the imbalance would surface later as an
      // unexplained treasury drift.
      return NextResponse.json(
        {
          error: `${target.username} is a bot — bot balances are managed by the bot funding path.`,
        },
        { status: 400 }
      );
    }

    try {
      const result = await adminAdjustBalance({
        userId: id,
        amountTetri,
        reason,
        adminUsername: admin.username,
        reference,
      });

      // alreadyApplied is a successful no-op, and the row has to say so: two
      // rows carrying the same reference where only one moved money would read
      // as a double payment to anyone reviewing the account later.
      audit.meta({
        balanceAfterTetri: result.balanceAfterTetri,
        alreadyApplied: result.alreadyApplied,
      });

      const direction = amountTetri > 0 ? "Credited" : "Debited";
      return NextResponse.json({
        ok: true,
        username: target.username,
        ...result,
        message: result.alreadyApplied
          ? `Reference "${reference}" was already applied — nothing moved. ${target.username} holds ${formatTetri(result.balanceAfterTetri)}.`
          : `${direction} ${formatTetri(Math.abs(amountTetri))} — ${target.username} now holds ${formatTetri(result.balanceAfterTetri)}.`,
      });
    } catch (err) {
      // Classified in one shared place rather than here, so every admin route
      // gives the console the same status for the same kind of refusal. The
      // ledger's own guards — the overdraw floor especially — are already in its
      // tables. requireAdmin is handled by withAdminAudit, which runs it before
      // this handler is called and outside every try: it signals a redirect by
      // throwing, and catching that would hide the auth failure.
      return adminOpsErrorResponse(err, { fallback: "Adjustment failed." });
    }
  }
);
