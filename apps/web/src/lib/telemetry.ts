/**
 * Client crash telemetry.
 *
 * A production error boundary that only says "something went wrong" is a dead
 * end: the screen that broke is the screen that knows why, and by the time a
 * user reports it that context is gone. This collects what an engineer would
 * actually ask for — the stack, the component, the route, which tournament and
 * match and player, and what the network was doing just before — and ships it
 * somewhere readable.
 *
 * Three deliberate choices:
 *
 *   · Stacks are only useful un-minified, so next.config sets
 *     productionBrowserSourceMaps. Without it every frame reads
 *     `page-92d2191.js:1:24601` and points at nothing.
 *   · Reports go out with `keepalive`, because a render crash is often followed
 *     by the user closing the tab, and a normal fetch dies with the document.
 *   · Nothing here may throw. Telemetry that crashes while reporting a crash
 *     replaces a diagnosable bug with an undiagnosable one, so every entry
 *     point is wrapped and failure is silent.
 */

/** Failed requests worth attaching to a report. Small on purpose — this is evidence, not a log. */
const MAX_REQUESTS = 25;

export interface FailedRequest {
  url: string;
  method: string;
  /** HTTP status, or 0 when the request never completed (offline, CORS, abort). */
  status: number;
  statusText: string;
  durationMs: number;
  /** Milliseconds before the report — relative, so no clock sync is needed to read it. */
  agoMs: number;
  /** First 500 chars of the response body, when we could read one. */
  body?: string;
}

interface RequestRecord extends Omit<FailedRequest, "agoMs"> {
  at: number;
}

export interface TelemetryContext {
  tournamentId?: string;
  matchId?: string;
  playerId?: string;
  /** Free-form breadcrumb: which surface the user was on. */
  scope?: string;
  [key: string]: string | undefined;
}

const requests: RequestRecord[] = [];
let context: TelemetryContext = {};
let installed = false;

/**
 * Merge into the ambient context.
 *
 * Additive rather than replacing, so a page can set the tournament id and a
 * child can add the match id without either needing to know about the other.
 */
export function setTelemetryContext(next: TelemetryContext): void {
  try {
    context = { ...context, ...next };
  } catch {
    /* never throw from telemetry */
  }
}

export function getTelemetryContext(): TelemetryContext {
  return context;
}

function recordFailure(rec: RequestRecord): void {
  requests.push(rec);
  if (requests.length > MAX_REQUESTS) requests.shift();
}

/**
 * Wrap fetch so failures are remembered.
 *
 * Only failures are kept. A ring buffer of every request would be mostly noise
 * and would hold response bodies — including wallet balances — in memory for
 * the life of the tab.
 */
function installFetchRecorder(): void {
  const original = window.fetch;
  window.fetch = async function instrumentedFetch(input, init) {
    const started = Date.now();
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    try {
      const res = await original.call(this, input as RequestInfo, init);
      if (!res.ok) {
        let body: string | undefined;
        try {
          // Read from a clone so the caller still gets an unconsumed body.
          body = (await res.clone().text()).slice(0, 500);
        } catch {
          /* body unreadable — the status alone is still worth having */
        }
        recordFailure({
          url,
          method,
          status: res.status,
          statusText: res.statusText,
          durationMs: Date.now() - started,
          at: started,
          body,
        });
      }
      return res;
    } catch (err) {
      // Network-level failure: no status at all.
      recordFailure({
        url,
        method,
        status: 0,
        statusText: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
        at: started,
      });
      throw err;
    }
  };
}

export interface CrashReport {
  message: string;
  /** Full JS stack. Un-minified when source maps are enabled for the build. */
  stack: string | null;
  /** React's component stack — which component threw, and its ancestors. */
  componentStack: string | null;
  /** Next's server-error correlation id, when the throw came from the server. */
  digest: string | null;
  source: "boundary" | "global-error" | "window.onerror" | "unhandledrejection";
  route: string;
  context: TelemetryContext;
  failedRequests: FailedRequest[];
  userAgent: string;
  at: string;
  /** Deployment commit, so a report can be tied to the code that produced it. */
  commit: string | null;
}

function buildReport(
  error: unknown,
  source: CrashReport["source"],
  extra: { componentStack?: string | null; digest?: string | null } = {}
): CrashReport {
  const now = Date.now();
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    message: err.message || String(error),
    stack: err.stack ?? null,
    componentStack: extra.componentStack ?? null,
    digest: extra.digest ?? (error as { digest?: string })?.digest ?? null,
    source,
    route: typeof location === "undefined" ? "" : location.pathname + location.search,
    context,
    failedRequests: requests.map(({ at, ...r }) => ({ ...r, agoMs: now - at })),
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    at: new Date(now).toISOString(),
    commit: process.env.NEXT_PUBLIC_COMMIT_SHA ?? null,
  };
}

/**
 * Send a crash report, and print it.
 *
 * The console copy matters as much as the POST: it is what an engineer
 * reproducing the bug in a browser sees immediately, without needing access to
 * the server logs.
 */
export function reportCrash(
  error: unknown,
  source: CrashReport["source"],
  extra: { componentStack?: string | null; digest?: string | null } = {}
): CrashReport | null {
  try {
    const report = buildReport(error, source, extra);
    console.error("[telemetry] crash report", report);
    void fetch("/api/telemetry/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      // The tab may be closing; a normal fetch would be cancelled with it.
      keepalive: true,
    }).catch(() => {
      /* reporting must never surface as a second error */
    });
    return report;
  } catch {
    return null;
  }
}

/**
 * Install the global handlers, once.
 *
 * React error boundaries only catch errors thrown during render, so anything
 * from an event handler, a timer or a rejected promise bypasses them entirely.
 * Those are exactly the failures that otherwise leave no trace at all.
 */
export function installTelemetry(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  try {
    installFetchRecorder();
    window.addEventListener("error", (e) => {
      reportCrash(e.error ?? e.message, "window.onerror");
    });
    window.addEventListener("unhandledrejection", (e) => {
      reportCrash(e.reason, "unhandledrejection");
    });
  } catch {
    /* an environment without these APIs is not worth crashing over */
  }
}
