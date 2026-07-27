import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { previewResetAllUsers, resetAllUsersToSignupBalance } from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";
import { adminOpsErrorResponse } from "@/lib/admin-ops-http";
import { requireAdmin } from "@/lib/auth";
import { withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: reset every selected account to the signup grant.
 *
 * The most dangerous endpoint in the console — one request rewrites the balance
 * of the entire user base — so it is built to be slow to fire and impossible to
 * fire by accident:
 *
 *   · GET returns a PREVIEW and moves nothing. The console loads it before the
 *     confirmation dialog opens, so the dialog states the real affected count
 *     and the real total that will move rather than "this will reset all users".
 *     A dialog quoting a guess is one an operator learns to click through.
 *   · POST performs the sweep, and takes the same filters, because a preview
 *     computed under one filter and a sweep run under another is a lie with
 *     extra steps.
 *   · Admins are excluded unless includeAdmins is explicitly true, and bots are
 *     excluded by default. Both defaults live in the ops layer, so a caller
 *     that omits them gets the safe sweep.
 *   · A reason is required on the POST. It goes into the ledger memo of the
 *     transaction that moved everybody's money, which is the first thing anyone
 *     reading that transaction afterwards will want.
 *
 * The whole sweep is ONE database transaction — every account resets or none
 * does — which means it holds a lock on treasury for its whole life and no
 * money moves anywhere on the platform until it commits. That is why the ops
 * layer caps it and REFUSES past the cap rather than resetting part of the user
 * base; the preview reports `overCap` so the console can say so up front.
 */
export const dynamic = "force-dynamic";

/**
 * Query flags are strings, and "false" is a string too — the mistake this
 * coercion exists to prevent is `Boolean("false") === true`, which would have
 * the preview quietly include every admin account on the platform. Only the
 * literal "true"/"1" opt in; anything else, including absence, is off.
 */
const flag = (value: string | null): boolean => value === "true" || value === "1";

/**
 * Explained the same way whether the field is missing, the wrong type, or too
 * short. Zod's own type error ("expected string, received undefined") is the
 * default when a required field is simply absent, and on the one endpoint that
 * rewrites the whole user base's balances the operator deserves the sentence
 * that tells them what to do rather than the one describing a parser.
 */
const reasonRequired = "Give a reason — it is written into the ledger transaction that moves everybody's money.";

const bodySchema = z.object({
  includeAdmins: z.boolean().optional(),
  includeBots: z.boolean().optional(),
  reason: z.string({ error: reasonRequired }).trim().min(3, reasonRequired).max(120),
});

/**
 * Preview only. Read-only, side-effect free, and therefore NOT wrapped in the
 * audit helper: that wrapper is for mutating routes, and a row per preview —
 * fired again on every toggle of a filter — would bury the sweeps themselves in
 * the very trail they exist to be found in. The POST below is what gets logged.
 */
export async function GET(req: NextRequest) {
  await requireAdmin();

  const includeAdmins = flag(req.nextUrl.searchParams.get("includeAdmins"));
  const includeBots = flag(req.nextUrl.searchParams.get("includeBots"));

  const preview = await previewResetAllUsers({ includeAdmins, includeBots });

  return NextResponse.json({
    ok: true,
    preview,
    message: preview.overCap
      ? `${preview.affectedCount} accounts would have to be written, over the ${preview.maxAccounts} cap — the sweep will refuse rather than reset part of the user base.`
      : preview.affectedCount === 0
        ? `All ${preview.eligibleCount} selected accounts are already holding exactly ${formatTetri(preview.targetTetri)} — nothing to do.`
        : `${preview.affectedCount} of ${preview.eligibleCount} selected accounts would move; ${formatTetri(preview.grossTetri)} in total.`,
  });
}

export const POST = withAdminAudit(
  // targetType "system": the target is the platform's whole user base, not any
  // one account, and pinning it to a single user id would misfile the single
  // most consequential row this table will ever hold.
  { action: "user.balance.reset-all", targetType: "system" },
  async ({ req, admin, audit }) => {
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid sweep" },
        { status: 400 }
      );
    }
    const includeAdmins = parsed.data.includeAdmins === true;
    const includeBots = parsed.data.includeBots === true;
    const { reason } = parsed.data;

    audit.reason(reason);
    // The filters are the whole shape of the blast radius, so they are recorded
    // before the sweep runs — a refusal (over the cap, most likely) must still
    // leave behind what was attempted and against whom.
    audit.meta({ includeAdmins, includeBots });
    audit.label(
      `all accounts${includeAdmins ? " + admins" : ""}${includeBots ? " + bots" : ""}`
    );

    try {
      const result = await resetAllUsersToSignupBalance({
        adminUsername: admin.username,
        includeAdmins,
        includeBots,
        reason,
      });

      // The figures the sweep actually produced, not the ones previewed. If the
      // two disagree — somebody joined, somebody spent — this row is the record
      // of what really happened.
      audit.meta({
        eligibleCount: result.eligibleCount,
        affectedCount: result.affectedCount,
        netTetri: result.netTetri,
        grossTetri: result.grossTetri,
        alreadyApplied: result.alreadyApplied,
      });

      return NextResponse.json({
        ok: true,
        ...result,
        message: result.alreadyApplied
          ? `An identical sweep had already posted in this minute — nothing moved a second time.`
          : result.affectedCount === 0
            ? `All ${result.eligibleCount} selected accounts were already holding exactly ${formatTetri(result.targetTetri)} — nothing to do.`
            : `Reset ${result.affectedCount} of ${result.eligibleCount} accounts to ${formatTetri(result.targetTetri)} — ${formatTetri(result.grossTetri)} moved in total.`,
      });
    } catch (err) {
      // The over-cap refusal comes through here, and its message is the one
      // thing the operator needs: how many accounts there actually are, that
      // NOTHING was moved, and what to do instead.
      return adminOpsErrorResponse(err, { fallback: "Reset-all failed." });
    }
  }
);
