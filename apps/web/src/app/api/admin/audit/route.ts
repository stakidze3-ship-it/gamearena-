import { NextRequest, NextResponse } from "next/server";
import { listAdminAudit } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";

/**
 * Admin-only: read the admin audit trail.
 *
 * The trail has been write-only since it was built — every mutating route feeds
 * it and nothing has ever read it back. A log nobody can read is not an audit
 * trail, it is a table, so this is the endpoint the console's Audit tab sits on.
 *
 * NOT wrapped in withAdminAudit, and that is the one design decision here worth
 * arguing about. Every other admin route is wrapped, because forgetting to log
 * a mutation is how trails end up with holes. But logging reads of the log
 * itself would mean an operator paging through six pages of history writes six
 * fresh rows to the top of the very list they are reading — the signal an
 * investigator came for gets pushed off the first page by the investigation.
 * So requireAdmin() is called directly, FIRST, before any parameter is touched:
 * this route changes nothing, and the only thing it must guarantee is that a
 * non-admin never sees a byte of it.
 *
 * force-dynamic because a cached page of the audit trail is worse than useless:
 * an operator checking whether the action they just took was recorded needs the
 * answer as of now, and a stale "no such row" would have them conclude the trail
 * is broken.
 *
 * Cursor pagination, matching the ledger explorer and for the same reason: the
 * table only grows, and it grows fastest during the incident an operator is
 * most likely to be reading it through. An offset window would shift under
 * them — page two repeating rows from page one and skipping whatever landed in
 * between, which in an audit context means an action that silently never
 * appears on any page.
 */
export const dynamic = "force-dynamic";

/** Mirrors listAdminAudit's own clamp so the console and the query layer agree. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Ceiling on a filter value. A cuid is 25 characters and the longest action
 * prefix in the codebase is around 30; anything past this is a paste accident
 * or someone probing, and neither deserves a database round trip.
 */
const MAX_FILTER_LENGTH = 200;

/**
 * Read one filter parameter.
 *
 * An over-long value is REFUSED rather than truncated. Truncating "user.balance"
 * to "user.bal" would still be a valid prefix and would still return rows — just
 * not the rows the operator asked for, under a UI that claims their filter is
 * applied. Wrong-but-plausible results are the failure mode this whole screen
 * exists to prevent, so the request fails loudly instead.
 */
function readFilter(
  params: URLSearchParams,
  name: string
): { ok: true; value: string | null } | { ok: false; error: string } {
  const raw = params.get(name);
  if (raw === null) return { ok: true, value: null };

  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > MAX_FILTER_LENGTH) {
    return { ok: false, error: `The ${name} filter is too long (max ${MAX_FILTER_LENGTH} characters).` };
  }
  return { ok: true, value: trimmed };
}

/**
 * Read the page size.
 *
 * Clamped rather than refused, unlike the filters above. A nonsense limit cannot
 * mislead anybody — the rows that come back are still exactly the rows that
 * match, just a different number of them — so there is nothing to protect the
 * operator from, and failing a whole request over `?limit=` typed by hand would
 * be pedantry.
 */
function readLimit(params: URLSearchParams): number {
  const raw = params.get("limit");
  if (raw === null) return DEFAULT_LIMIT;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, parsed));
}

export async function GET(req: NextRequest) {
  // FIRST, and outside the try below. requireAdmin signals "not an admin" by
  // throwing a redirect, and a try block around it would swallow that redirect
  // and serve a 500 instead — turning a working auth failure into a mystery.
  await requireAdmin();

  const params = req.nextUrl.searchParams;

  // Read every filter before running any of them, so a request with two bad
  // parameters reports the first rather than half-applying the good one.
  const action = readFilter(params, "action");
  if (!action.ok) return NextResponse.json({ error: action.error }, { status: 400 });

  const adminUserId = readFilter(params, "adminUserId");
  if (!adminUserId.ok) return NextResponse.json({ error: adminUserId.error }, { status: 400 });

  const targetId = readFilter(params, "targetId");
  if (!targetId.ok) return NextResponse.json({ error: targetId.error }, { status: 400 });

  const cursor = readFilter(params, "cursor");
  if (!cursor.ok) return NextResponse.json({ error: cursor.error }, { status: 400 });

  const limit = readLimit(params);

  try {
    const page = await listAdminAudit({
      limit,
      cursor: cursor.value,
      // Prefix match, not exact: "user." returns the whole family, which is what
      // "anything done to accounts" means to the person asking.
      action: action.value,
      adminUserId: adminUserId.value,
      targetId: targetId.value,
    });

    return NextResponse.json({
      ok: true,
      entries: page.entries,
      nextCursor: page.nextCursor,
      /**
       * The filters actually in force, echoed back rather than assumed.
       *
       * The console renders these as removable chips. Without the echo it would
       * be rendering its own local state, which is the one version of the truth
       * that cannot be wrong about what the server did — and an "applied"
       * indicator that agrees with itself instead of with the query is exactly
       * how someone concludes a filter matched nothing when it never ran.
       */
      appliedFilters: {
        action: action.value,
        adminUserId: adminUserId.value,
        targetId: targetId.value,
        limit,
      },
      /**
       * WHY AN EMPTY PAGE PROVES NOTHING. Shipped in the payload, not just in a
       * comment, for the same reason the error-buffer caveat is: the console
       * cannot state a limitation accurately unless it is told what it is, and
       * a caveat that lives only in the source is a caveat the operator reading
       * "no rows" at 3am never sees.
       *
       * Three distinct gaps, none of which this endpoint can detect:
       *
       *   · COVERAGE. Only routes wrapped in withAdminAudit write rows, and the
       *     wrapper is still being retrofitted across the console. An operation
       *     performed through an unwrapped route happened and left nothing here.
       *   · WRITE FAILURES. recordAdminAction deliberately never throws — a
       *     refund must not be refused because the log table was unreachable —
       *     so a row can be lost while the operation it describes succeeds. The
       *     gap is announced in the server log under [admin-audit] and nowhere
       *     else.
       *   · EVERYTHING OUTSIDE THE CONSOLE. Direct database access, seed
       *     scripts and migrations are not admin routes and never appear here
       *     at all.
       */
      caveat:
        "Coverage is not complete. This trail only contains actions taken through admin routes " +
        "that are wired to the audit wrapper, the wrapper is still being retrofitted, and a row " +
        "can fail to write without failing the operation it describes (those gaps are announced " +
        "in the server log under [admin-audit]). Anything done directly against the database or " +
        "by a script never appears here at all. THE ABSENCE OF A ROW IS NOT EVIDENCE THAT AN " +
        "ACTION DID NOT HAPPEN — corroborate against the ledger and the deployment logs.",
    });
  } catch (err) {
    // A cursor from a hand-edited URL is the realistic way to get here: Prisma
    // refuses to page from an id that does not exist. Answering 400 with a
    // recoverable instruction beats a 500 that reads like the trail is broken.
    console.error("[admin-audit] failed to read the audit trail", err);
    return NextResponse.json(
      {
        error:
          "Could not read the audit trail. If a cursor was supplied by hand it may no longer be " +
          "valid — reload the first page.",
      },
      { status: 500 }
    );
  }
}
