import { NextResponse } from "next/server";
import { errorLogStats, recentErrors } from "@/lib/error-log";
import { requireAdmin } from "@/lib/auth";

/**
 * Admin-only: the most recent errors this server instance has seen.
 *
 * THE LIST IS PARTIAL AND AN EMPTY ONE PROVES NOTHING. There is no error store
 * — no table, no log drain — so this reads a bounded in-memory ring
 * (lib/error-log.ts) written by the two sinks that already exist: the client
 * crash endpoint at /api/telemetry/client-error and Next's onRequestError hook
 * in instrumentation.ts.
 *
 * That ring lives in the memory of ONE instance. In production the deployment
 * runs several and recycles them freely, so:
 *
 *   · The instance answering this request is probably not the one that handled
 *     the failing request.
 *   · Everything is lost on restart, redeploy and scale-down.
 *   · "0 errors" therefore means "this instance has nothing", never "nothing
 *     has failed".
 *
 * Because an operator reading an empty list as all-clear during an incident is
 * the specific harm here, the caveat ships IN THE PAYLOAD rather than only in
 * this comment — the console cannot render it accurately without being told.
 * The authoritative record is the deployment log, where the same failures are
 * printed in full under [CLIENT CRASH] and [SERVER ERROR].
 *
 * Newest first. Stacks are included: this is an admin-only route, and an error
 * list you have to leave to get the stack for is one you stop using.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  await requireAdmin();

  const errors = recentErrors();
  const stats = errorLogStats();

  return NextResponse.json({
    ok: true,
    errors,
    ...stats,
    /** Not a hint. The reason this endpoint cannot be trusted as a complete record. */
    caveat:
      "In-memory and per-instance. This is only what the server instance that answered has " +
      "seen since it started, and production runs several instances. An empty list is NOT " +
      "proof that nothing failed — the complete record is in the deployment logs under " +
      "[CLIENT CRASH] and [SERVER ERROR].",
    // Surfaced separately so the console can say how far back "recent" reaches
    // on this instance rather than implying it covers all of history.
    note:
      stats.totalSeen > stats.captured
        ? `${stats.totalSeen - stats.captured} older ${
            stats.totalSeen - stats.captured === 1 ? "error has" : "errors have"
          } already been pushed out of this instance's ${stats.capacity}-entry buffer.`
        : null,
  });
}
