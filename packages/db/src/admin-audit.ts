/**
 * The admin audit trail — who did what, to whom, and whether it worked.
 *
 * Every other safety mechanism in the console answers "can this happen?". This
 * one answers "what happened?", and it is the only one that still works after
 * the fact. Without it, "₾4,000 appeared in an account last Tuesday" has no
 * answer at all: the ledger says treasury paid it and stops there, because the
 * memo carries a name typed by the very tool being investigated.
 *
 * Three rules the rest of the file exists to keep:
 *
 *   1. WRITING THE LOG MUST NEVER FAIL THE OPERATION. A refund that succeeded
 *      and was not logged is a bookkeeping problem; a refund refused because
 *      the log table was unreachable is a player who did not get their money.
 *      recordAdminAction therefore swallows its own errors — and shouts about
 *      them, because the only thing worse than a noisy audit trail is a
 *      silently missing one.
 *   2. FAILURES ARE LOGGED, NOT JUST SUCCESSES. "Who tried to move ₾5,000 and
 *      was refused" is precisely the question an incident asks, and a
 *      successes-only log answers it with silence that looks like innocence.
 *   3. THE ROW IS DENORMALISED ON PURPOSE. adminUsername and targetLabel are
 *      copied in at write time rather than joined at read time, so a later
 *      rename — or a deleted tournament — cannot rewrite history.
 *
 * Nothing here updates or deletes rows. The table is append-only by
 * convention, because a trail the operator can edit proves nothing about the
 * operator.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./client";

/**
 * What kind of thing an action was aimed at.
 *
 * A union in TypeScript but a plain string column in Postgres: a new target
 * type must never be blocked behind a migration, because the failure mode of
 * "cannot log it yet" is an unlogged action.
 */
export type AdminAuditTargetType = "user" | "tournament" | "match" | "system";

/** Whether the operation this row describes completed or was refused. */
export type AdminAuditOutcome = "ok" | "error";

/**
 * Free text is stored, but not without a ceiling.
 *
 * An error message can be a whole stack trace or a driver dump, and a handful
 * of those turn the console's audit page into a wall nobody reads — which is
 * the same as having no audit page. Clamping keeps rows scannable; the
 * underlying failure is on the server's own error log in full.
 */
const MAX_TEXT = 2_000;

const clamp = (value: string | null | undefined, max = MAX_TEXT): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

export interface RecordAdminActionInput {
  /** The operator's user id, from the server session — never from the body. */
  adminUserId: string;
  /** Their username AT THE TIME. Copied in, never joined for. */
  adminUsername: string;
  /**
   * Dotted verb, e.g. "user.balance.adjust", "tournament.cancel".
   * The console filters on the prefix, so keep the "<subject>.<thing>.<verb>"
   * shape and do not invent a second name for an operation that already has one.
   */
  action: string;
  targetType?: AdminAuditTargetType | null;
  targetId?: string | null;
  /** Human-readable name of the target, denormalised so it survives renames. */
  targetLabel?: string | null;
  /** The operator's stated justification, where the operation collects one. */
  reason?: string | null;
  /**
   * Operation-specific detail: amounts in tetri, idempotency references, counts.
   * NEVER credentials, session tokens or password hashes — this table is read
   * by more people than the ones who can reach the database.
   */
  metadata?: Prisma.InputJsonValue | null;
  /** Best-effort caller IP. "unknown" is a legitimate value, not a bug. */
  ip?: string | null;
  /** Defaults to "ok"; pass "error" for a refused or failed attempt. */
  outcome?: AdminAuditOutcome;
  /** Why it failed. Only meaningful when outcome is "error". */
  errorMessage?: string | null;
}

/**
 * Write one audit row. NEVER THROWS.
 *
 * Callers are meant to be able to write `await recordAdminAction(...)` on the
 * success path of a money movement without wrapping it, and without that await
 * being able to turn a completed operation into a 500. The catch here is what
 * makes that safe.
 *
 * The console.error is deliberately loud and deliberately not rate-limited. A
 * missing audit trail is a security finding, and it must look like one in the
 * logs rather than being absorbed into a quiet `.catch(() => {})` that nobody
 * ever notices.
 */
export async function recordAdminAction(input: RecordAdminActionInput): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        adminUserId: input.adminUserId,
        adminUsername: input.adminUsername,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        targetLabel: clamp(input.targetLabel, 200),
        reason: clamp(input.reason, 500),
        // Omitted rather than set to null: a nullable Json column takes NULL by
        // absence, and Prisma reserves an explicit null for Prisma.DbNull.
        ...(input.metadata === null || input.metadata === undefined
          ? {}
          : { metadata: input.metadata }),
        ip: clamp(input.ip, 100),
        outcome: input.outcome ?? "ok",
        errorMessage: clamp(input.errorMessage),
      },
    });
  } catch (err) {
    // The operation this describes has already happened. All that can be done
    // now is make sure the gap is visible to whoever reads the server log.
    console.error(
      `[admin-audit] FAILED TO RECORD ADMIN ACTION — the trail is now incomplete. ` +
        `action=${input.action} admin=${input.adminUsername} (${input.adminUserId}) ` +
        `target=${input.targetType ?? "-"}:${input.targetId ?? "-"} ` +
        `outcome=${input.outcome ?? "ok"}`,
      err
    );
  }
}

/** One row as the console reads it. Mirrors the model exactly. */
export interface AdminAuditEntry {
  id: string;
  createdAt: Date;
  adminUserId: string;
  adminUsername: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  reason: string | null;
  metadata: unknown;
  ip: string | null;
  outcome: string;
  errorMessage: string | null;
}

export interface ListAdminAuditInput {
  /** Page size. Clamped to 1..200 so a hand-typed query cannot pull the table. */
  limit?: number;
  /**
   * The `nextCursor` from the previous page — the id of the last row returned.
   * Null or absent starts from the newest row.
   */
  cursor?: string | null;
  /** Only this operator's actions. */
  adminUserId?: string | null;
  /**
   * PREFIX match, not exact. "user.balance.adjust" finds that one operation and
   * "user." finds the whole family, which is what an operator scanning for
   * "anything done to accounts" actually wants.
   */
  action?: string | null;
  /** Everything ever done to one target id, whatever its type. */
  targetId?: string | null;
}

export interface AdminAuditPage {
  entries: AdminAuditEntry[];
  /** Pass back as `cursor` for the next page. Null when this is the last one. */
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Read the trail, newest first.
 *
 * Ordered by (createdAt desc, id desc) rather than createdAt alone. Several
 * rows can share a millisecond — a bot fill logs one action while the operator
 * clicks the next — and an ordering with ties is not a stable place to put a
 * cursor: the same row can be returned on two pages, or skipped entirely.
 *
 * Pagination fetches one extra row and drops it. That is how "is there a next
 * page" is answered without a second COUNT over a table that only grows.
 */
export async function listAdminAudit(input: ListAdminAuditInput = {}): Promise<AdminAuditPage> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(input.limit ?? DEFAULT_LIMIT)));

  const where: Prisma.AdminAuditLogWhereInput = {
    ...(input.adminUserId ? { adminUserId: input.adminUserId } : {}),
    ...(input.action ? { action: { startsWith: input.action } } : {}),
    ...(input.targetId ? { targetId: input.targetId } : {}),
  };

  const rows = await prisma.adminAuditLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    // skip: 1 steps past the cursor row itself, which the caller already has.
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;

  return {
    entries,
    nextCursor: hasMore ? (entries[entries.length - 1]?.id ?? null) : null,
  };
}
