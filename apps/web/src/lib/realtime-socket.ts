/**
 * A WebSocket that survives the network.
 *
 * The realtime service can restart, a proxy can drop an idle connection, and a
 * phone can change networks — all of which surface as an `error` followed by a
 * `close`. Treating the first of those as fatal is what put a dead-end error on
 * the lobby; this reconnects with exponential backoff and only gives up after
 * the last attempt.
 *
 * Every attempt fetches a fresh ticket, because tickets are short-lived and an
 * expired one is a common reason a retry would otherwise fail.
 */

export type SocketStatus = "idle" | "connecting" | "open" | "reconnecting" | "failed";

export interface Ticket {
  token: string;
  wsUrl: string;
}

/**
 * Thrown by `getTicket` when retrying cannot possibly help — the service isn't
 * configured, or the session is gone. Retrying those for the full backoff
 * window just makes the player wait 90 seconds for the same answer, so they
 * fail immediately and carry a message worth showing.
 */
export class RealtimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealtimeUnavailableError";
  }
}

export interface RealtimeSocketOptions {
  /** Fetches a fresh ticket. Called before every attempt. */
  getTicket: () => Promise<Ticket>;
  onMessage: (msg: Record<string, unknown>) => void;
  /** `detail` is set on "failed" when there is something specific to show. */
  onStatus: (status: SocketStatus, detail?: string) => void;
  /** Fired on every successful open, including reconnects, so callers can
   *  restore intent (e.g. re-join the queue they were waiting in). */
  onOpen?: (attempt: number) => void;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Keepalive interval. The server ignores unknown message types, so this
   *  needs no protocol support — it exists to stop idle proxies closing us. */
  pingIntervalMs?: number;
}

/** Close codes that mean "do not come back". */
const TERMINAL_CLOSE_CODES = new Set([
  1000, // normal — we closed it on purpose
  4000, // superseded — another tab or device took this session over
]);

/**
 * Attempt delay: exponential with full-ish jitter, so a service restarting
 * doesn't get every client reconnecting on the same tick.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs = 500,
  maxDelayMs = 8_000,
  random: () => number = Math.random
): number {
  const exponential = Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs);
  const jitter = 0.8 + random() * 0.4; // ±20%
  return Math.round(exponential * jitter);
}

export class RealtimeSocket {
  private ws: WebSocket | null = null;
  /** Bumped per attempt; callbacks from superseded sockets are ignored. */
  private generation = 0;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByCaller = false;

  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly pingIntervalMs: number;

  /** Last status pushed to the caller, so we don't emit the same one twice. */
  private lastStatus: SocketStatus | null = null;

  constructor(private readonly opts: RealtimeSocketOptions) {
    // Ten attempts over a ~90s window. A service restart or a redeploy can
    // easily take a minute, and giving up inside that window is what puts a
    // dead-end error in front of someone whose connection was only ever going
    // to come back on its own.
    this.maxAttempts = opts.maxAttempts ?? 10;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.maxDelayMs = opts.maxDelayMs ?? 15_000;
    this.pingIntervalMs = opts.pingIntervalMs ?? 25_000;

    // Coming back online or refocusing the tab is a strong signal that a retry
    // will now succeed — take it, even after we have given up.
    if (typeof window !== "undefined") {
      this.onWake = () => {
        if (document.visibilityState === "hidden") return;
        this.retryNow();
      };
      window.addEventListener("online", this.onWake);
      document.addEventListener("visibilitychange", this.onWake);
    }
  }

  private onWake: (() => void) | null = null;

  private setStatus(status: SocketStatus, detail?: string) {
    if (status === this.lastStatus && detail === undefined) return;
    this.lastStatus = status;
    this.opts.onStatus(status, detail);
  }

  /**
   * Try again immediately, resetting the backoff. Safe to call at any time —
   * it does nothing if a connection is already up or in flight.
   */
  retryNow(): void {
    if (this.closedByCaller) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    void this.open();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === 1; // OPEN
  }

  /** Connect, or do nothing if already connected/connecting. */
  async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.closedByCaller = false;
    this.attempt = 0;
    await this.open();
  }

  send(msg: unknown): boolean {
    if (!this.isOpen) return false;
    this.ws!.send(JSON.stringify(msg));
    return true;
  }

  /** Intentional shutdown — never reconnects afterwards. */
  close(): void {
    this.closedByCaller = true;
    if (this.onWake && typeof window !== "undefined") {
      window.removeEventListener("online", this.onWake);
      document.removeEventListener("visibilitychange", this.onWake);
      this.onWake = null;
    }
    this.clearTimers();
    this.generation++; // orphan any in-flight callbacks
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, "client closed");
    } catch {
      /* already gone */
    }
    this.setStatus("idle");
  }

  private clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
  }

  private async open(): Promise<void> {
    if (this.closedByCaller) return;
    const generation = ++this.generation;
    this.attempt += 1;
    this.setStatus(this.attempt === 1 ? "connecting" : "reconnecting");

    let ticket: Ticket;
    try {
      ticket = await this.opts.getTicket();
    } catch (err) {
      if (err instanceof RealtimeUnavailableError) {
        this.setStatus("failed", err.message);
        return;
      }
      // Ticket endpoint unreachable — treat exactly like a failed connection.
      this.scheduleRetry(generation);
      return;
    }
    if (generation !== this.generation || this.closedByCaller) return;

    let ws: WebSocket;
    try {
      const Ctor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
      if (!Ctor) throw new Error("WebSocket unavailable");
      ws = new Ctor(`${ticket.wsUrl}/ws?token=${encodeURIComponent(ticket.token)}`);
    } catch {
      this.scheduleRetry(generation);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (generation !== this.generation) return; // a newer attempt won
      const attempt = this.attempt;
      this.attempt = 0; // a good connection resets the backoff
      this.setStatus("open");
      this.startPing(generation);
      this.opts.onOpen?.(attempt);
    };

    ws.onmessage = (event: MessageEvent) => {
      if (generation !== this.generation) return;
      try {
        this.opts.onMessage(JSON.parse(String(event.data)));
      } catch {
        /* malformed frame — ignore rather than tear down a healthy socket */
      }
    };

    // `error` is always followed by `close`; let close drive the retry so a
    // single failure cannot count twice.
    ws.onerror = () => {};

    ws.onclose = (event: CloseEvent) => {
      if (generation !== this.generation) return; // stale socket, not ours
      this.clearTimers();
      this.ws = null;
      if (this.closedByCaller) return;
      if (TERMINAL_CLOSE_CODES.has(event.code)) {
        this.setStatus(event.code === 1000 ? "idle" : "failed");
        return;
      }
      this.scheduleRetry(generation);
    };
  }

  private startPing(generation: number) {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (generation !== this.generation) return;
      // Unknown message types are ignored server-side; this only needs to put
      // a frame on the wire so intermediaries keep the connection alive.
      this.send({ t: "ping" });
    }, this.pingIntervalMs);
  }

  private scheduleRetry(generation: number) {
    if (this.closedByCaller || generation !== this.generation) return;
    if (this.attempt >= this.maxAttempts) {
      this.setStatus("failed");
      return;
    }
    const delay = backoffDelay(this.attempt, this.baseDelayMs, this.maxDelayMs);
    this.setStatus("reconnecting");
    this.retryTimer = setTimeout(() => void this.open(), delay);
  }
}
