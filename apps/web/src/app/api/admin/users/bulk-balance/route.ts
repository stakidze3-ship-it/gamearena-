import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  ADMIN_ADJUSTMENT_MAX_TETRI,
  BULK_BALANCE_MAX_ACCOUNTS,
  bulkAdjustBalance,
} from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";
import { adminOpsErrorResponse } from "@/lib/admin-ops-http";
import { withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: apply the same signed adjustment to a hand-picked list of players.
 *
 * The compensation tool. An event was cancelled, a bug cost forty people their
 * entry fee, and paying them back one at a time is both slow and a guarantee
 * that two of them get missed.
 *
 * The list is EXPLICIT — ids in the body, never a filter, never "everyone
 * who…". A query that selects the wrong rows pays the wrong people, and by the
 * time anyone notices the money has moved. If an operator wants a filtered
 * sweep there is exactly one, /reset-all, and it is deliberately harder to fire.
 *
 * The batch is all-or-nothing: one database transaction and one balanced ledger
 * posting, so it cannot pay thirty of forty and stop. One idempotency key
 * covers the whole batch, so a double-click is a no-op rather than a second
 * payment to everybody. Two genuine batches need two references.
 *
 * The size cap is the ops layer's, imported rather than restated. It is not a
 * UI nicety: the whole batch runs in one transaction holding a lock on
 * treasury, and while it is open no money moves anywhere on the platform.
 */
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /**
   * Whose balances move. Capped at the ops layer's own limit so an oversized
   * batch bounces here with a clear message instead of opening a transaction
   * and then throwing.
   */
  userIds: z
    .array(z.string().min(1))
    .min(1, "Select at least one account.")
    .max(
      BULK_BALANCE_MAX_ACCOUNTS,
      `A batch is capped at ${BULK_BALANCE_MAX_ACCOUNTS} accounts — the whole batch runs in one transaction that freezes every money operation on the platform while it is open.`
    ),
  /**
   * Signed integer tetri, applied identically to every listed account. Integer
   * because all money here is integer tetri (1 GEL = 100), and a float would be
   * a rounding error multiplied by the size of the batch.
   */
  amountTetri: z
    .number()
    .int("Amount must be a whole number of tetri.")
    .refine((n) => n !== 0, "Amount must not be zero — there is nothing to adjust.")
    .refine(
      (n) => Math.abs(n) <= ADMIN_ADJUSTMENT_MAX_TETRI,
      `Adjustments are capped at ${formatTetri(ADMIN_ADJUSTMENT_MAX_TETRI)} per account.`
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
  /** What makes a repeat a repeat, for the batch as a whole. See above. */
  reference: z.string().trim().min(1).max(60).optional(),
});

export const POST = withAdminAudit(
  // No targetIdParam and no single target: a batch addresses a set. The ids go
  // in the metadata below and the label carries the count, so the row still
  // reads as something rather than as an action against nothing.
  { action: "user.balance.bulk-adjust", targetType: "user" },
  async ({ req, admin, audit }) => {
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid batch" },
        { status: 400 }
      );
    }
    const { userIds, amountTetri, reason } = parsed.data;
    // Derive the fallback from the BATCH, never from the clock.
    //
    // A minute-bucket fallback is not an idempotency key, it is a dedupe
    // window: a bulk adjustment is RELATIVE, so re-sending it pays everyone a
    // second time, and a 500-account batch takes long enough that a gateway
    // timeout or a re-run during an incident crosses the minute boundary
    // trivially. Keying on the content instead means a retry of the same batch
    // is a no-op forever, while a genuinely different batch is a different key.
    const reference =
      parsed.data.reference ??
      `auto:${createHash("sha256")
        .update(`${[...userIds].sort().join(",")}|${amountTetri}|${reason}`)
        .digest("hex")
        .slice(0, 32)}`;

    audit.reason(reason);
    audit.label(`${userIds.length} ${userIds.length === 1 ? "account" : "accounts"}`);
    // The full id list, deliberately not truncated. When the batch posts, the
    // ledger transaction's own entries record who was paid — but when it is
    // REFUSED (a bot in the selection, an account that would go below zero) no
    // ledger transaction exists at all, and this row is then the only surviving
    // record of what somebody tried to do to whom.
    audit.meta({ amountTetri, reference, requestedCount: userIds.length, userIds });

    try {
      const result = await bulkAdjustBalance({
        userIds,
        amountTetri,
        reason,
        adminUsername: admin.username,
        reference,
      });

      // alreadyApplied is a successful no-op, and the row has to say so: two
      // rows with the same reference where only one moved money would read as a
      // double payment to anyone reviewing the batch later.
      audit.meta({
        affectedCount: result.affectedCount,
        netTetri: result.netTetri,
        grossTetri: result.grossTetri,
        alreadyApplied: result.alreadyApplied,
      });

      const direction = amountTetri > 0 ? "Credited" : "Debited";
      return NextResponse.json({
        ok: true,
        ...result,
        message: result.alreadyApplied
          ? `Reference "${reference}" was already applied — nothing moved. Re-send with a new reference to run it again.`
          : `${direction} ${formatTetri(Math.abs(amountTetri))} to ${result.affectedCount} ${result.affectedCount === 1 ? "account" : "accounts"} — ${formatTetri(result.grossTetri)} moved in total.`,
      });
    } catch (err) {
      // Every refusal from the ops layer names the accounts it refused over, so
      // it is passed through rather than flattened: "3 of the selected accounts
      // would be taken below zero (…)" is actionable, "batch failed" is not.
      return adminOpsErrorResponse(err, { fallback: "Bulk adjustment failed." });
    }
  }
);
