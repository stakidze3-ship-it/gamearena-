/**
 * Anti-cheat review plumbing. Signals open a ReviewCase (deduped per open
 * reason+user) and may place a payout hold; admins resolve them.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "./client";

type Db = PrismaClient | Prisma.TransactionClient;

export type ReviewReason = "WINRATE_ANOMALY" | "INPUT_SPEED" | "INPUT_REGULARITY" | "DEVICE_SHARED";

/**
 * Open a review case if one for this (user, reason) isn't already open.
 * When `hold` is set, freezes the user's payouts pending manual review.
 */
export async function openReviewCase(
  db: Db,
  userId: string,
  reason: ReviewReason,
  detail: Prisma.InputJsonValue,
  hold = false
): Promise<void> {
  const existing = await db.reviewCase.findFirst({
    where: { userId, reason, status: "OPEN" },
    select: { id: true },
  });
  if (!existing) {
    await db.reviewCase.create({ data: { userId, reason, detail } });
  }
  if (hold) {
    await db.user.update({ where: { id: userId }, data: { payoutHold: true } });
  }
}

/** Resolve a case; optionally lift the user's payout hold if nothing else is open. */
export async function resolveReviewCase(
  caseId: string,
  status: "CLEARED" | "ACTION_TAKEN",
  resolvedBy: string,
  opts: { releaseHold?: boolean; suspend?: boolean; notes?: string } = {}
): Promise<void> {
  await prisma.$transaction(async (db) => {
    const rc = await db.reviewCase.update({
      where: { id: caseId },
      data: { status, resolvedAt: new Date(), resolvedBy, notes: opts.notes },
    });

    if (opts.suspend) {
      await db.user.update({ where: { id: rc.userId }, data: { suspendedAt: new Date(), payoutHold: true } });
      return;
    }

    if (opts.releaseHold) {
      const stillOpen = await db.reviewCase.count({ where: { userId: rc.userId, status: "OPEN" } });
      if (stillOpen === 0) {
        await db.user.update({ where: { id: rc.userId }, data: { payoutHold: false } });
      }
    }
  });
}
