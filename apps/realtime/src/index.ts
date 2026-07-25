/**
 * GameArena realtime service — live 1v1 matches over WebSocket.
 *
 * Flow: authenticated clients JOIN a (game, stake) queue → paired with a
 * waiting human, or (demo only) a BOT after a short wait → both stakes locked
 * into escrow → seed hash published, seed revealed at start → clients stream
 * inputs (never scores) → the server keeps an authoritative engine per player
 * → at the cutoff it computes scores and settles escrow atomically.
 *
 * Single-instance, in-memory queue (Redis would back this for multi-instance).
 */
import { createServer } from "node:http";
import { randomInt, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { WebSocketServer, type WebSocket } from "ws";
import { jwtVerify } from "jose";
import {
  prisma,
  Prisma,
  AccountKeys,
  getBalanceTetri,
  lockStakeIn,
  mintDemoCreditIn,
  InsufficientFundsError,
} from "@gamearena/db";
import {
  MATCH_RATING_WINDOW,
  NEWCOMER_PROTECTED_MATCHES,
  STAKES_TETRI,
  rakeBpsForStake,
} from "@gamearena/shared";
import { getGameDefinition, type BlockBlastInput } from "@gamearena/games";
import { send, type ClientMessage } from "./protocol";
import { MatchRoom, type RoomPlayer } from "./match-room";
import { generateBotInputs } from "./bot";
import { startScheduler } from "./scheduler";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, "../../../.env") });

const PORT = Number(process.env.REALTIME_PORT ?? 4001);
const DEMO_MODE = process.env.DEMO_MODE !== "false";
const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? "");

const COUNTDOWN_MS = 3000;
const BOT_WAIT_MS = 4000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ── Connection + queue state ──
interface Conn {
  ws: WebSocket;
  userId: string;
  username: string;
  state: "idle" | "queued" | "matched";
  queueKey?: string;
  botTimer?: NodeJS.Timeout;
  rating: number;
  newcomer: boolean;
}

const LOWEST_STAKE = STAKES_TETRI[0];

/** ±150 rating window; newcomers only meet newcomers unless at the lowest stake. */
function canMatch(a: Conn, b: Conn, stakeTetri: number): boolean {
  if (Math.abs(a.rating - b.rating) > MATCH_RATING_WINDOW) return false;
  const mixedNewcomer = a.newcomer !== b.newcomer;
  if (mixedNewcomer && stakeTetri !== LOWEST_STAKE) return false;
  return true;
}

const conns = new Map<WebSocket, Conn>();
const byUser = new Map<string, Conn>();
const queues = new Map<string, Conn[]>();
const rooms = new Map<string, MatchRoom>();
const userRoom = new Map<string, string>();

let botUser: { id: string; username: string } | null = null;
async function ensureBotUser() {
  if (!botUser) {
    const bot = await prisma.user.findFirst({ where: { isBot: true } });
    if (bot) botUser = { id: bot.id, username: bot.username };
  }
  return botUser;
}

// ── HTTP (health) + WS server ──
const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "gamearena-realtime", rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  // Listeners must attach synchronously: the client sends `join` the instant
  // the socket opens, and 'ws' drops messages that arrive with no listener.
  // Auth is async, so buffer anything that lands before it resolves.
  let conn: Conn | null = null;
  const pending: ClientMessage[] = [];

  // A WebSocket is an EventEmitter: an 'error' event with no listener throws,
  // which takes down the whole process — every live match, every player. A
  // hostile or malformed frame (e.g. invalid UTF-8 in a text frame) triggers
  // this at the protocol level, before it ever reaches the message handler.
  ws.on("error", (err) => {
    console.error("[realtime] socket error", err);
  });

  ws.on("message", (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (conn) void dispatch(conn, msg);
    else pending.push(msg);
  });

  ws.on("close", () => {
    if (!conn) return;
    conns.delete(ws);
    if (byUser.get(conn.userId) === conn) byUser.delete(conn.userId);
    dequeue(conn);
    const roomId = userRoom.get(conn.userId);
    if (roomId) rooms.get(roomId)?.onDisconnect(conn.userId);
  });

  void (async () => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const token = url.searchParams.get("token");
    let userId: string | null = null;
    let username = "";
    if (token) {
      try {
        const { payload } = await jwtVerify(token, secret);
        userId = payload.sub ?? null;
        username = (payload.un as string) ?? "";
      } catch {
        /* invalid ticket */
      }
    }
    if (!userId) {
      ws.close(4001, "unauthorized");
      return;
    }

    // One live connection per user.
    const existing = byUser.get(userId);
    if (existing) existing.ws.close(4000, "superseded");

    conn = { ws, userId, username, state: "idle", rating: 1500, newcomer: true };
    conns.set(ws, conn);
    byUser.set(userId, conn);

    for (const msg of pending) void dispatch(conn, msg);
    pending.length = 0;
  })();
});

/**
 * Never let one client's frame take the service down. handleMessage is async,
 * so an unhandled rejection here would terminate the process — killing every
 * live match room in memory and stranding their escrow, plus the scheduler.
 */
async function dispatch(conn: Conn, msg: ClientMessage) {
  try {
    await handleMessage(conn, msg);
  } catch (err) {
    console.error(`[realtime] message from ${conn.userId} failed`, err);
  }
}

async function handleMessage(conn: Conn, msg: ClientMessage) {
  switch (msg.t) {
    case "join":
      return void handleJoin(conn, msg.gameKey, msg.stakeTetri, msg.challengeId);
    case "input": {
      const roomId = userRoom.get(conn.userId);
      if (roomId) rooms.get(roomId)?.handleInput(conn.userId, msg.input as BlockBlastInput);
      return;
    }
    case "chat": {
      const roomId = userRoom.get(conn.userId);
      if (roomId && typeof msg.text === "string") rooms.get(roomId)?.handleChat(conn.userId, msg.text);
      return;
    }
    case "leave": {
      dequeue(conn);
      const roomId = userRoom.get(conn.userId);
      if (roomId) rooms.get(roomId)?.onDisconnect(conn.userId);
      return;
    }
  }
}

function dequeue(conn: Conn) {
  if (conn.botTimer) clearTimeout(conn.botTimer);
  conn.botTimer = undefined;
  if (conn.queueKey) {
    const q = queues.get(conn.queueKey);
    if (q) queues.set(conn.queueKey, q.filter((c) => c !== conn));
  }
  conn.queueKey = undefined;
  if (conn.state === "queued") conn.state = "idle";
}

async function handleJoin(conn: Conn, gameKey: string, stakeTetri: number, challengeId?: string) {
  if (conn.state !== "idle") return;
  if (!getGameDefinition(gameKey)) return send(conn.ws, { t: "error", message: "Unknown game" });
  if (!STAKES_TETRI.includes(stakeTetri as (typeof STAKES_TETRI)[number])) {
    return send(conn.ws, { t: "error", message: "Invalid stake" });
  }

  const [user, game] = await Promise.all([
    prisma.user.findUnique({ where: { id: conn.userId } }),
    prisma.game.findUnique({ where: { key: gameKey } }),
  ]);
  if (!user || user.suspendedAt) return send(conn.ws, { t: "error", message: "Account unavailable" });
  if (user.selfExcludedUntil && user.selfExcludedUntil > new Date()) {
    return send(conn.ws, { t: "error", message: "Self-exclusion active" });
  }
  if (!game || !game.enabled) return send(conn.ws, { t: "error", message: "Game unavailable" });

  const balance = await getBalanceTetri(prisma, AccountKeys.userCash(conn.userId));
  if (balance < stakeTetri) return send(conn.ws, { t: "error", message: "Not enough demo credits" });

  // Per-game rating drives matchmaking + newcomer protection.
  const rs = await prisma.ratingState.findUnique({
    where: { userId_gameId: { userId: conn.userId, gameId: game.id } },
  });
  conn.rating = rs?.rating ?? 1500;
  conn.newcomer = (rs?.matchesPlayed ?? 0) < NEWCOMER_PROTECTED_MATCHES;

  // A challenge is a private room: only its two participants pair, no bot.
  const isChallenge = !!challengeId;
  const queueKey = isChallenge ? `chal:${challengeId}` : `${gameKey}:${stakeTetri}`;
  const q = queues.get(queueKey) ?? [];
  const opp = q.find(
    (c) =>
      c.state === "queued" &&
      c.userId !== conn.userId &&
      c.ws.readyState === c.ws.OPEN &&
      (isChallenge || canMatch(conn, c, stakeTetri))
  );

  if (opp) {
    dequeue(opp);
    return void createMatch([opp, conn], game.id, gameKey, stakeTetri, false);
  }

  conn.state = "queued";
  conn.queueKey = queueKey;
  queues.set(queueKey, [...q, conn]);
  send(conn.ws, { t: "queued", stakeTetri });

  // Bot fallback only for open matchmaking, never for private challenges.
  if (DEMO_MODE && !isChallenge) {
    conn.botTimer = setTimeout(() => {
      if (conn.state === "queued") {
        dequeue(conn);
        void createMatch([conn], game.id, gameKey, stakeTetri, true);
      }
    }, BOT_WAIT_MS);
  }
}

async function ensureBotFunds(db: Prisma.TransactionClient, botId: string, stakeTetri: number) {
  const acc = await db.account.findUnique({ where: { key: AccountKeys.userCash(botId) } });
  if ((acc?.balanceTetri ?? 0) < stakeTetri) {
    await mintDemoCreditIn(db, botId, stakeTetri, "Bot demo funding");
  }
}

async function createMatch(
  humanConns: Conn[],
  gameId: string,
  gameKey: string,
  stakeTetri: number,
  useBot: boolean
) {
  const def = getGameDefinition(gameKey)!;
  const bot = useBot ? await ensureBotUser() : null;
  if (useBot && !bot) {
    humanConns.forEach((c) => send(c.ws, { t: "error", message: "No opponent available" }));
    humanConns.forEach((c) => (c.state = "idle"));
    return;
  }

  const seed = randomInt(100_000, 1_000_000).toString();
  const seedHash = sha256(seed);
  const potTetri = stakeTetri * 2;

  // Apply an active happy-hour rake discount, if any covers now + this game.
  const now = new Date();
  const happyHour = await prisma.happyHour.findFirst({
    where: { startsAt: { lte: now }, endsAt: { gt: now }, OR: [{ gameId: null }, { gameId }] },
  });
  const baseRakeBps = rakeBpsForStake(stakeTetri);
  const rakeBps = happyHour
    ? Math.round((baseRakeBps * (10_000 - happyHour.rakeDiscountBps)) / 10_000)
    : baseRakeBps;

  // Roster: the human(s), plus the bot if any.
  const roster = [
    ...humanConns.map((c) => ({ userId: c.userId, username: c.username, isBot: false, ws: c.ws })),
    ...(bot ? [{ userId: bot.id, username: bot.username, isBot: true, ws: null }] : []),
  ];

  let matchId: string;
  try {
    const match = await prisma.$transaction(async (db) => {
      if (bot) await ensureBotFunds(db, bot.id, stakeTetri);
      const created = await db.match.create({
        data: {
          gameId,
          stakeTetri,
          rakeBps,
          potTetri,
          seed,
          seedHash,
          status: "ACTIVE",
          isDemo: true,
          startedAt: new Date(),
          players: { create: roster.map((p) => ({ userId: p.userId })) },
        },
      });
      for (const p of roster) await lockStakeIn(db, created.id, p.userId, stakeTetri);
      return created;
    });
    matchId = match.id;
  } catch (e) {
    const message = e instanceof InsufficientFundsError ? "Not enough demo credits" : "Could not start match";
    humanConns.forEach((c) => {
      send(c.ws, { t: "error", message });
      c.state = "idle";
    });
    return;
  }

  const players = roster.map<RoomPlayer>((p) => ({
    userId: p.userId,
    username: p.username,
    isBot: p.isBot,
    ws: p.ws,
    engine: def.create(seed),
    score: 0,
    inputs: [],
    lastT: -1,
  })) as [RoomPlayer, RoomPlayer];

  const room = new MatchRoom(
    matchId,
    gameId,
    def,
    seed,
    seedHash,
    stakeTetri,
    rakeBps,
    potTetri,
    players,
    def.durationS,
    cleanupRoom
  );
  rooms.set(matchId, room);

  for (const c of humanConns) {
    c.state = "matched";
    userRoom.set(c.userId, matchId);
    const opp = players.find((p) => p.userId !== c.userId)!;
    send(c.ws, {
      t: "matched",
      matchId,
      seedHash,
      opponent: { username: opp.username, isBot: opp.isBot },
      stakeTetri,
      potTetri,
      rakeBps,
      durationS: def.durationS,
      startInMs: COUNTDOWN_MS,
    });
  }

  // Precompute bot input streams (spread across the round).
  const botInputs = new Map<string, BlockBlastInput[]>();
  for (const p of players) {
    if (p.isBot) botInputs.set(p.userId, generateBotInputs(seed, def.durationS * 1000));
  }

  setTimeout(() => room.start(botInputs), COUNTDOWN_MS);
}

function cleanupRoom(matchId: string) {
  const room = rooms.get(matchId);
  if (!room) return;
  for (const p of room.players) {
    if (userRoom.get(p.userId) === matchId) userRoom.delete(p.userId);
    const c = byUser.get(p.userId);
    if (c) c.state = "idle";
  }
  rooms.delete(matchId);
}

server.listen(PORT, () => {
  console.log(`[realtime] listening on :${PORT} (ws /ws) demo=${DEMO_MODE}`);
  void ensureBotUser();
  startScheduler();
});
