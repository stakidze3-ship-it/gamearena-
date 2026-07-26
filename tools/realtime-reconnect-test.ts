/**
 * Integration test for RealtimeSocket against the real realtime service.
 *
 * Run it, then kill and restart the service underneath it: the client must
 * report "reconnecting" (never "failed"), come back on its own, and re-send its
 * join so the player is back in the queue without touching the page.
 */
import { WebSocket as NodeWebSocket } from "ws";
import { SignJWT } from "jose";
import { RealtimeSocket, backoffDelay, type SocketStatus } from "../apps/web/src/lib/realtime-socket";

(globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;

const PORT = process.env.RT_PORT ?? "4400";
const SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? "reconnect-test-secret-00000");
const USER_ID = process.env.USER_ID!;
const USERNAME = process.env.USERNAME!;

const stamp = () => new Date().toISOString().slice(14, 23);
const statuses: SocketStatus[] = [];
let opens = 0;
let rejoins = 0;

async function main() {
  console.log("--- backoff schedule (deterministic, jitter fixed at 1.0) ---");
  for (let a = 1; a <= 7; a++) {
    console.log(`  attempt ${a}: ${backoffDelay(a, 500, 8000, () => 0.5)}ms`);
  }

  const socket = new RealtimeSocket({
    getTicket: async () => ({
      token: await new SignJWT({ un: USERNAME, rl: "USER", kind: "rt" })
        .setSubject(USER_ID)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(SECRET),
      wsUrl: `ws://localhost:${PORT}`,
    }),
    onMessage: (m) => console.log(`[${stamp()}] << ${JSON.stringify(m).slice(0, 90)}`),
    onStatus: (s) => {
      statuses.push(s);
      console.log(`[${stamp()}] status: ${s}`);
    },
    onOpen: (attempt) => {
      opens += 1;
      console.log(`[${stamp()}] OPEN (attempt ${attempt})${attempt > 1 ? "  <-- RECOVERED" : ""}`);
      // Restore intent, exactly as the lobby does after a drop.
      socket.send({ t: "join", gameKey: "block-blast", stakeTetri: 100 });
      if (opens > 1) rejoins += 1;
    },
    pingIntervalMs: 3_000,
  });

  await socket.connect();

  await new Promise((r) => setTimeout(r, Number(process.env.RUN_MS ?? 45_000)));
  socket.close();

  console.log("\n--- RESULT ---");
  console.log("status sequence:", statuses.join(" -> "));
  console.log("opens:", opens, "| re-joins after recovery:", rejoins);
  const reconnected = statuses.includes("reconnecting");
  const everFailed = statuses.includes("failed");
  const recovered = opens > 1;
  console.log(`saw "reconnecting": ${reconnected}`);
  console.log(`ever showed "failed": ${everFailed}`);
  console.log(`recovered without restart: ${recovered}`);
  console.log(reconnected && recovered && !everFailed ? "\nPASS" : "\nsee above");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
