import { NextRequest, NextResponse } from "next/server";

/**
 * Sink for client crash reports.
 *
 * Deliberately unauthenticated. The crashes worth catching are the ones that
 * happen before or during a screen that needs a session, and a sink that
 * requires auth silently drops exactly those. Nothing here reads or writes user
 * data — it only prints — so the blast radius of an anonymous POST is a log
 * line.
 *
 * That does mean it can be spammed, so the payload is size-capped and the
 * fields are printed individually rather than echoed back, and nothing is
 * persisted. On Vercel these land in the runtime logs for the deployment,
 * grouped under a single greppable prefix.
 */
export const dynamic = "force-dynamic";

/** Enough for a deep stack plus a component stack; well short of a log-flooding payload. */
const MAX_BYTES = 64_000;

interface FailedRequest {
  url?: string;
  method?: string;
  status?: number;
  statusText?: string;
  durationMs?: number;
  agoMs?: number;
  body?: string;
}

export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => "");
  if (!raw || raw.length > MAX_BYTES) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  let report: Record<string, unknown>;
  try {
    report = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const ctx = (report.context ?? {}) as Record<string, string | undefined>;
  const failed = Array.isArray(report.failedRequests)
    ? (report.failedRequests as FailedRequest[])
    : [];

  // One block per report, prefixed so it can be pulled out of a busy log with a
  // single grep. Multi-line on purpose: a stack folded onto one line is not
  // readable, and readability at 3am is the whole point.
  const lines = [
    "═══ [CLIENT CRASH] ═══════════════════════════════",
    `  message      ${report.message}`,
    `  source       ${report.source}`,
    `  route        ${report.route}`,
    `  commit       ${report.commit ?? "unknown"}`,
    `  digest       ${report.digest ?? "—"}`,
    `  scope        ${ctx.scope ?? "—"}`,
    `  tournamentId ${ctx.tournamentId ?? "—"}`,
    `  matchId      ${ctx.matchId ?? "—"}`,
    `  playerId     ${ctx.playerId ?? "—"}`,
    `  at           ${report.at}`,
    `  userAgent    ${report.userAgent}`,
    "  ── stack ──",
    String(report.stack ?? "(none)"),
    "  ── component stack ──",
    String(report.componentStack ?? "(none)"),
    `  ── failed requests (${failed.length}) ──`,
    ...failed.map(
      (r) =>
        `    ${r.method} ${r.url} → ${r.status} ${r.statusText} (${r.durationMs}ms, ${r.agoMs}ms before crash)` +
        (r.body ? `\n      body: ${r.body}` : "")
    ),
    "══════════════════════════════════════════════════",
  ];
  console.error(lines.join("\n"));

  return NextResponse.json({ ok: true });
}
