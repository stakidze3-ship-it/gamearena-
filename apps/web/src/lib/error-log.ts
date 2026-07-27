/**
 * A small in-memory ring of the most recent errors, for the admin console.
 *
 * THIS IS A PARTIAL RECORD, AND EVERY READER MUST BE TOLD SO. It lives in the
 * memory of one server instance. On Vercel a deployment runs many instances and
 * they are recycled freely, so this buffer holds only the errors that happened
 * to be reported to the instance that is answering right now, since the last
 * time that instance started. An empty list means "this instance has not seen
 * an error", which is NOT the same as "nothing has failed" — the authoritative
 * record is the deployment log, where the sinks print [CLIENT CRASH] and
 * [SERVER ERROR] blocks in full. `/api/admin/system/errors` returns that caveat
 * in its payload for exactly this reason.
 *
 * It exists anyway because during an incident the difference between "I can see
 * the last twenty failures right now" and "log into the hosting dashboard and
 * grep" is the difference between fixing it in two minutes and twenty. A
 * durable store (Postgres table, log drain) is the real answer and is not built
 * yet; this is deliberately the cheapest thing that is honest about its limits.
 *
 * Held on globalThis rather than in module scope. The telemetry route handler
 * and instrumentation.ts are bundled separately by Next, and two bundles would
 * otherwise each get their own copy of a module-scoped array — the writer would
 * fill one ring and the reader would report the other one as empty. Dev hot
 * reload has the same effect. One process, one buffer.
 */

/** Small enough that a crash loop cannot grow it without bound; long enough to see a pattern. */
export const ERROR_LOG_CAPACITY = 50;

/** Bounds on a single entry, so one enormous stack cannot pin megabytes of heap. */
const MAX_MESSAGE_CHARS = 500;
const MAX_STACK_CHARS = 4_000;

export interface RecordedError {
  /** ISO timestamp — serialised, because this crosses a JSON boundary to the console. */
  at: string;
  message: string;
  /** Where it came from: "client" (browser crash report) or "server" (uncaught server error). */
  source: string;
  /** Route or path the failure happened on, when known. */
  route?: string;
  /** Free-form breadcrumb from client telemetry — which surface the user was on. */
  scope?: string;
  /** Next's error digest: the "Reference …" code the user sees on the error screen. */
  digest?: string;
  stack?: string;
}

export interface ErrorLogStats {
  /** How many entries are in the ring right now. */
  captured: number;
  /** Ring size — once reached, the oldest entry is dropped on every new error. */
  capacity: number;
  /** When this instance's buffer started, i.e. how far back "recent" reaches. */
  bufferStartedAt: string;
  /** Total errors this instance has seen, including ones already pushed out of the ring. */
  totalSeen: number;
}

interface ErrorLogState {
  entries: RecordedError[];
  bufferStartedAt: string;
  totalSeen: number;
}

const globalForErrorLog = globalThis as unknown as { gameArenaErrorLog?: ErrorLogState };

function state(): ErrorLogState {
  const existing = globalForErrorLog.gameArenaErrorLog;
  if (existing) return existing;
  const fresh: ErrorLogState = {
    entries: [],
    bufferStartedAt: new Date().toISOString(),
    totalSeen: 0,
  };
  globalForErrorLog.gameArenaErrorLog = fresh;
  return fresh;
}

function clip(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Append one error. Never throws: this is called from the two places whose whole
 * job is reporting a failure, and an error store that throws while recording an
 * error turns a diagnosable bug into an undiagnosable one.
 */
export function recordError(entry: {
  message: unknown;
  source: string;
  route?: unknown;
  scope?: unknown;
  digest?: unknown;
  stack?: unknown;
  at?: Date | string;
}): void {
  try {
    const log = state();
    const at =
      entry.at instanceof Date
        ? entry.at.toISOString()
        : typeof entry.at === "string" && entry.at
          ? entry.at
          : new Date().toISOString();

    log.entries.push({
      at,
      message: clip(entry.message, MAX_MESSAGE_CHARS) ?? "(no message)",
      source: entry.source,
      route: clip(entry.route, 200),
      scope: clip(entry.scope, 120),
      digest: clip(entry.digest, 120),
      stack: clip(entry.stack, MAX_STACK_CHARS),
    });
    log.totalSeen += 1;
    // Splice rather than shift-in-a-loop so a burst cannot leave the ring long.
    if (log.entries.length > ERROR_LOG_CAPACITY) {
      log.entries.splice(0, log.entries.length - ERROR_LOG_CAPACITY);
    }
  } catch {
    // Deliberately silent — see above.
  }
}

/** Newest first, which is the order an operator reads them in. */
export function recentErrors(): RecordedError[] {
  return [...state().entries].reverse();
}

export function errorLogStats(): ErrorLogStats {
  const log = state();
  return {
    captured: log.entries.length,
    capacity: ERROR_LOG_CAPACITY,
    bufferStartedAt: log.bufferStartedAt,
    totalSeen: log.totalSeen,
  };
}
