/**
 * Standalone checks for RealtimeSocket's retry policy. No service required.
 *
 * The distinction this guards is the whole point of the reconnect work: a
 * transient failure must retry quietly, and a failure that retrying cannot fix
 * must say so immediately instead of spinning for the full backoff window.
 */
import {
  RealtimeSocket,
  RealtimeUnavailableError,
  backoffDelay,
  type SocketStatus,
} from "../apps/web/src/lib/realtime-socket";

async function run(label: string, getTicket: () => Promise<never>, waitMs: number) {
  const statuses: [SocketStatus, string | undefined][] = [];
  let ticketCalls = 0;
  const socket = new RealtimeSocket({
    getTicket: async () => {
      ticketCalls++;
      return getTicket();
    },
    onMessage: () => {},
    onStatus: (s, d) => statuses.push([s, d]),
  });
  await socket.connect();
  await new Promise((r) => setTimeout(r, waitMs));
  socket.close();
  console.log(`\n${label}`);
  console.log("  ticket attempts:", ticketCalls);
  console.log("  statuses:", statuses.map(([s, d]) => (d ? `${s}(${d})` : s)).join(" -> "));
  return { ticketCalls, statuses };
}

(async () => {
  console.log("--- backoff schedule (jitter pinned to 1.0) ---");
  for (let a = 1; a <= 10; a++) {
    console.log(`  attempt ${a}: ${backoffDelay(a, 500, 15_000, () => 0.5)}ms`);
  }

  const fatal = await run(
    "FATAL (503 — realtime host not configured)",
    async () => {
      throw new RealtimeUnavailableError("Live 1v1 is temporarily unavailable. Blitz is still open.");
    },
    3_000
  );
  const transient = await run(
    "TRANSIENT (network blip fetching the ticket)",
    async () => {
      throw new TypeError("Failed to fetch");
    },
    3_000
  );

  const fatalOk =
    fatal.ticketCalls === 1 &&
    fatal.statuses.some(([s, d]) => s === "failed" && d?.includes("Blitz is still open"));
  const transientOk =
    transient.ticketCalls > 1 && !transient.statuses.some(([s]) => s === "failed");

  console.log("\n--- RESULT ---");
  console.log(`fatal fails immediately, once, with its own message: ${fatalOk}`);
  console.log(`transient keeps retrying and stays silent: ${transientOk}`);
  console.log(fatalOk && transientOk ? "\nPASS" : "\nFAIL");
  process.exit(fatalOk && transientOk ? 0 : 1);
})();
