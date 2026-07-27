import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, resolveReviewCase } from "@gamearena/db";
import { withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: close a fraud/abuse review case, either way.
 *
 * "Clear" releases the payout hold; "suspend" locks the account and keeps the
 * hold. Both are judgements about a named player made by a named operator, so
 * both are filed against the PLAYER rather than the case id — a case is a
 * transient object, and the question asked afterwards is always "why was this
 * account suspended", never "what happened to case clx7…".
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  caseId: z.string().min(1),
  action: z.enum(["clear", "suspend"]),
  notes: z.string().max(500).optional(),
});

export const POST = withAdminAudit(
  // "review.case" is the fallback for a body that could not be parsed into
  // either verb; a parsed body is renamed to review.resolve or review.suspend
  // below, because clearing someone and suspending them must never share a
  // filter.
  { action: "review.case", targetType: "user" },
  async ({ req, admin, audit }) => {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });
    const { caseId, action, notes } = parsed.data;

    audit.action(action === "clear" ? "review.resolve" : "review.suspend");
    // The operator's written justification is the reason field's whole purpose —
    // this is the one control in the console where a human decides a player is
    // or is not a cheat.
    audit.reason(notes);
    audit.meta({ caseId, action });

    // Best effort, and before the write: the case is resolved in place, so
    // reading it afterwards would report the outcome rather than what was
    // decided on. An unknown id leaves the target unset and resolveReviewCase
    // still produces exactly the failure it did before.
    const reviewCase = await prisma.reviewCase
      .findUnique({
        where: { id: caseId },
        select: { userId: true, reason: true, user: { select: { username: true } } },
      })
      .catch(() => null);
    if (reviewCase) {
      audit.target(reviewCase.userId, reviewCase.user.username);
      audit.meta({ caseReason: reviewCase.reason });
    }

    if (action === "clear") {
      await resolveReviewCase(caseId, "CLEARED", admin.username, { releaseHold: true, notes });
    } else {
      await resolveReviewCase(caseId, "ACTION_TAKEN", admin.username, { suspend: true, notes });
    }

    return NextResponse.json({ ok: true });
  }
);
