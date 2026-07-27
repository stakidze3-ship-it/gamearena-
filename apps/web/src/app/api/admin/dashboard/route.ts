import { NextResponse } from "next/server";
import { dashboardSnapshot } from "@gamearena/db";
import { errorLogStats, recentErrors } from "@/lib/error-log";
import { requireAdmin } from "@/lib/auth";

/**
 * Admin-only: everything the console's first tab shows, in one request.
 *
 * The dashboard polls, so this is the most frequently hit admin route on the
 * platform. Two decisions follow from that.
 *
 * The snapshot and the error buffer are served together rather than as two
 * endpoints. They are read from completely different places — Postgres and a
 * per-instance in-memory ring — but the console shows them side by side, and
 * splitting them would double the polling traffic to display one screen.
 *
 * dashboardSnapshot() is built never to throw on a failed read: it returns
 * nulls and a `degradedReason` instead. This route must not undo that by
 * adding a query of its own that dies on the exact failure the page exists to
 * report. recentErrors() reads memory and cannot fail, which is why it is the
 * only thing added here.
 */
export const dynamic = "force-dynamic";

/**
 * The dashboard is a glance, not an investigation. Anything past the first few
 * failures belongs on the System tab, which shows the full buffer.
 */
const MAX_ERRORS = 6;

export async function GET() {
  await requireAdmin();

  const snapshot = await dashboardSnapshot();
  const stats = errorLogStats();

  return NextResponse.json({
    ok: true,
    ...snapshot,
    errors: recentErrors().slice(0, MAX_ERRORS),
    /** How many are in this instance's ring in total, so "6 shown" is honest. */
    errorsCaptured: stats.captured,
    /**
     * Not a hint — the reason an empty error list proves nothing. The ring
     * lives in the memory of the one instance that answered this request, and
     * production runs several. Shipped in the payload because the console
     * cannot render the caveat accurately without being told it.
     */
    errorsCaveat:
      "In-memory and per-instance. An empty list is NOT proof that nothing failed — the " +
      "complete record is in the deployment logs under [CLIENT CRASH] and [SERVER ERROR].",
  });
}
