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
 */
import type { Instrumentation } from "next";

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
};

export function register(): void {
  // Nothing to initialise yet; the hook above is what this file exists for.
}
