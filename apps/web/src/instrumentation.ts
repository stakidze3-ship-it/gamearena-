/**
 * Server-side exception capture.
 *
 * `onRequestError` is Next's hook for every uncaught server error — server
 * components, route handlers, server actions, middleware. Without it a thrown
 * error becomes a digest hash in the browser and a stack in a log nobody
 * correlated; with it, the digest the user sees on screen is printed next to
 * the stack that produced it, which is what makes the two joinable.
 *
 * Registered automatically by Next because of the file name and location.
 *
 * It also files the error into the in-memory ring the admin console reads (see
 * lib/error-log.ts), so a server exception shows up on the System tab next to
 * the client crashes instead of only in the deployment log. That ring is
 * per-instance and lossy; the log block below remains the real record.
 */
import type { Instrumentation } from "next";
import { recordError } from "@/lib/error-log";

export const onRequestError: Instrumentation.onRequestError = (err, request, context) => {
  const e = err as Error & { digest?: string };
  console.error(
    [
      "═══ [SERVER ERROR] ═══════════════════════════════",
      `  message   ${e?.message ?? String(err)}`,
      // The same value Next renders as "Reference …" on the error screen, so a
      // user-reported code leads straight to this block.
      `  digest    ${e?.digest ?? "—"}`,
      `  path      ${request?.path ?? "—"}`,
      `  method    ${request?.method ?? "—"}`,
      `  router    ${context?.routerKind ?? "—"}`,
      `  route     ${context?.routePath ?? "—"}`,
      `  type      ${context?.routeType ?? "—"}`,
      `  rendering ${context?.renderSource ?? "—"}`,
      "  ── stack ──",
      e?.stack ?? "(none)",
      "══════════════════════════════════════════════════",
    ].join("\n")
  );

  recordError({
    source: "server",
    message: e?.message ?? String(err),
    // The concrete path that failed, falling back to the route pattern — an
    // operator needs to know it was /api/admin/users/abc123, not just [id].
    route: request?.path ?? context?.routePath,
    scope: context?.routeType,
    digest: e?.digest,
    stack: e?.stack,
  });
};

export function register(): void {
  // Nothing to initialise yet; the hook above is what this file exists for.
}
