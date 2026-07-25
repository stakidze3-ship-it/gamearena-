/**
 * Full end-to-end tournament simulation.
 *
 * Nothing here is stubbed: 61 accounts are created through the real signup API,
 * seats are claimed over real HTTP with real session cookies, the real
 * scheduler draws the bracket after the real 60-second countdown, and every
 * score is a genuine Block Blast input log re-simulated by the server.
 *
 * Run against an isolated database with the web app and the realtime service
 * both pointed at it:
 *   DATABASE_URL=... SIM_BASE_URL=http://localhost:3200 npx tsx tools/tournament-sim.ts
 */
import { setTimeout as sleep } from "node:timers/promises";
import { BlockBlastEngine, GRID, type BlockBlastInput } from "@gamearena/games";
import {
  AccountKeys,
  getBalanceTetri,
  postTransaction,
  prisma,
} from "@gamearena/db";
import { KNOCKOUT_CONFIG } from "@gamearena/shared";

const BASE = process.env.SIM_BASE_URL ?? "http://localhost:3200";
const FIELD = KNOCKOUT_CONFIG.capacity; // 60
const ENTRY = KNOCKOUT_CONFIG.entryTetri; // 500 tetri = ₾5
const RUN_ID = process.env.SIM_RUN_ID ?? String(Date.now()).slice(-6);

// ── Instrumentation ────────────────────────────────────────────────────────
const t0 = Date.now();
const apiErrors: { stage: string; detail: string }[] = [];
const dbErrors: { stage: string; detail: string }[] = [];
const failures: string[] = [];
const timings: { stage: string; ms: number }[] = [];
const latencies: number[] = [];

const clock = () => {
  const s = (Date.now() - t0) / 1000;
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};
const log = (stage: string, msg: string) => console.log(`[${clock()}] ${stage.padEnd(11)} ${msg}`);
function check(label: string, pass: boolean, detail = "") {
  console.log(`[${clock()}] ${pass ? "  PASS   " : "  FAIL   "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failures.push(`${label}${detail ? ` (${detail})` : ""}`);
}
async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const out = await fn();
  timings.push({ stage: name, ms: Date.now() - started });
  return out;
}

// ── HTTP with real sessions ────────────────────────────────────────────────
interface Player {
  index: number;
  username: string;
  email: string;
  cookie: string;
  userId: string;
  /** 0..1 — drives move count and sloppiness, so outcomes vary like real play. */
  skill: number;
  /** Deliberately ignores their first match to exercise the ready check. */
  noShow: boolean;
  seated: boolean;
}

async function api(
  path: string,
  init: RequestInit & { cookie?: string; stage?: string } = {}
): Promise<{ status: number; body: any; ms: number }> {
  const started = Date.now();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.Cookie = init.cookie;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  } catch (e) {
    apiErrors.push({ stage: init.stage ?? path, detail: String(e) });
    throw e;
  }
  const ms = Date.now() - started;
  latencies.push(ms);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 200);
  }
  if (res.status >= 500) {
    apiErrors.push({ stage: init.stage ?? path, detail: `${res.status} ${JSON.stringify(body)}` });
  }
  return { status: res.status, body, ms };
}

function sessionCookie(setCookie: string | null): string {
  const raw = setCookie ?? "";
  const match = raw.match(/ga_session=[^;]+/);
  return match ? match[0] : "";
}

async function registerAccount(index: number): Promise<Player> {
  const username = `sim${RUN_ID}p${index}`;
  const email = `${username}@sim.test`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, username, password: "simulation1" }),
  });
  const cookie = sessionCookie(res.headers.get("set-cookie"));
  if (!res.ok || !cookie) {
    const detail = `${res.status} ${await res.text()}`;
    apiErrors.push({ stage: "signup", detail });
    throw new Error(`signup failed for ${username}: ${detail}`);
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { usernameLower: username.toLowerCase() } });
  return {
    index,
    username,
    email,
    cookie,
    userId: user.id,
    skill: Math.random(),
    noShow: false,
    seated: false,
  };
}

/** Trim the signup bonus down to exactly one entry fee. */
async function fundExactly(player: Player, tetri: number) {
  const current = await getBalanceTetri(prisma, AccountKeys.userCash(player.userId));
  const delta = current - tetri;
  if (delta === 0) return;
  await postTransaction({
    kind: "ADJUSTMENT",
    memo: "Simulation bankroll",
    refType: "user",
    refId: player.userId,
    entries: [
      { accountKey: AccountKeys.userCash(player.userId), amountTetri: -delta },
      { accountKey: AccountKeys.treasury(), amountTetri: delta },
    ],
  });
}

// ── Real play: a genuine input log, strength-weighted ───────────────────────
function countLines(
  grid: boolean[],
  shape: { cells: readonly (readonly [number, number])[] },
  r: number,
  c: number
): number {
  const g = grid.slice();
  for (const [dr, dc] of shape.cells) g[(r + dr) * GRID + (c + dc)] = true;
  let lines = 0;
  for (let i = 0; i < GRID; i++) {
    let rowFull = true;
    let colFull = true;
    for (let j = 0; j < GRID; j++) {
      if (!g[i * GRID + j]) rowFull = false;
      if (!g[j * GRID + i]) colFull = false;
    }
    if (rowFull) lines++;
    if (colFull) lines++;
  }
  return lines;
}

/**
 * Plays the seed for real with the shared engine. Stronger players look further
 * and blunder less, so results spread the way a real field does.
 */
function playSeed(seed: string, skill: number, durationMs: number): BlockBlastInput[] {
  const eng = new BlockBlastEngine(seed);
  const moves: Omit<BlockBlastInput, "t">[] = [];
  const maxMoves = Math.round(26 + skill * 30 + Math.random() * 6); // 26..62
  const sloppiness = 0.45 - skill * 0.4; // weak 0.45 → strong 0.05

  for (let m = 0; m < maxMoves && !eng.isOver(); m++) {
    const st = eng.getState();
    const legal: { s: number; r: number; c: number; gain: number }[] = [];
    for (let s = 0; s < 3; s++) {
      const shape = st.hand[s];
      if (!shape) continue;
      for (let r = 0; r <= GRID - shape.h; r++) {
        for (let c = 0; c <= GRID - shape.w; c++) {
          if (!eng.previewFits(s, r, c)) continue;
          legal.push({ s, r, c, gain: countLines(st.grid, shape, r, c) });
        }
      }
    }
    if (legal.length === 0) break;
    const pick =
      Math.random() < sloppiness
        ? legal[Math.floor(Math.random() * legal.length)]!
        : legal.reduce((a, b) => (b.gain > a.gain ? b : a));
    if (!eng.applyInput({ t: 0, s: pick.s, r: pick.r, c: pick.c })) break;
    moves.push({ s: pick.s, r: pick.r, c: pick.c });
  }

  const span = durationMs * 0.95;
  return moves.map((mv, i) => {
    const base = Math.round(((i + 1) / (moves.length + 1)) * span);
    const jitter = Math.round((Math.random() - 0.5) * 400);
    return { ...mv, t: Math.max(0, Math.min(durationMs - 1, base + jitter)) };
  });
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n" + "=".repeat(78));
  console.log(`  GameArena — end-to-end tournament simulation (run ${RUN_ID})`);
  console.log(`  target ${BASE} · field ${FIELD} · entry ${ENTRY} tetri`);
  console.log("=".repeat(78) + "\n");

  // ── Stage 1: the open event ──
  const tournament = await stage("await-event", async () => {
    log("STAGE 1", "waiting for the scheduler to open registration…");
    for (let i = 0; i < 60; i++) {
      const t = await prisma.tournament.findFirst({
        where: { format: "KNOCKOUT", status: "SCHEDULED" },
        orderBy: { createdAt: "desc" },
      });
      if (t) return t;
      await sleep(1000);
    }
    throw new Error("scheduler never opened an event");
  });
  log("STAGE 1", `event ${tournament.id} — ${tournament.name}`);
  check("capacity is 60", tournament.capacity === FIELD, `${tournament.capacity}`);
  check("entry is ₾5", tournament.entryTetri === ENTRY, `${tournament.entryTetri} tetri`);
  check("ready check is 180s", tournament.readyWindowS === 180 && tournament.roundDurationS === 180);
  const TID = tournament.id;
  const gameDurationMs =
    (await prisma.game.findUniqueOrThrow({ where: { id: tournament.gameId } })).durationS * 1000;

  // ── Stage 2: 61 real accounts, each funded with exactly ₾5 ──
  const players = await stage("signup", async () => {
    log("STAGE 2", "creating 61 accounts through the signup API…");
    const out: Player[] = [];
    for (let i = 0; i < FIELD + 1; i++) {
      const p = await registerAccount(i);
      await fundExactly(p, ENTRY);
      out.push(p);
      if ((i + 1) % 20 === 0) log("STAGE 2", `  ${i + 1}/${FIELD + 1} accounts ready`);
    }
    return out;
  });
  const balances = await Promise.all(
    players.map((p) => getBalanceTetri(prisma, AccountKeys.userCash(p.userId)))
  );
  check("all 61 funded with exactly ₾5", balances.every((b) => b === ENTRY), `min ${Math.min(...balances)} max ${Math.max(...balances)}`);

  // Two players will ignore their first match so the ready check is exercised.
  const noShowPicks = [players[7]!, players[23]!];
  noShowPicks.forEach((p) => (p.noShow = true));
  log("STAGE 2", `${noShowPicks.map((p) => p.username).join(", ")} will deliberately no-show`);

  // ── Stage 3: seats claimed over real HTTP, with a concurrent burst ──
  await stage("join", async () => {
    log("STAGE 3", "claiming seats (staggered, then a burst for the last 12)…");
    const drip = players.slice(0, FIELD - 12);
    for (const p of drip) {
      const r = await api(`/api/tournaments/${TID}/register`, {
        method: "POST",
        cookie: p.cookie,
        stage: "join",
      });
      if (r.status === 200) p.seated = true;
      else apiErrors.push({ stage: "join", detail: `${p.username}: ${r.status} ${JSON.stringify(r.body)}` });
      await sleep(80 + Math.random() * 220);
    }
    log("STAGE 3", `${drip.filter((p) => p.seated).length} seated one by one`);

    // The last seats are contested simultaneously — this is the race test.
    const burst = players.slice(FIELD - 12, FIELD + 1); // 12 seats left, 13 contenders
    log("STAGE 3", `burst: ${burst.length} players racing for ${FIELD - drip.length} seats`);
    const results = await Promise.all(
      burst.map((p) =>
        api(`/api/tournaments/${TID}/register`, { method: "POST", cookie: p.cookie, stage: "join-burst" })
          .then((r) => ({ p, r }))
      )
    );
    for (const { p, r } of results) {
      if (r.status === 200) p.seated = true;
    }
    const rejected = results.filter(({ r }) => r.status !== 200);
    log("STAGE 3", `burst settled — ${results.length - rejected.length} seated, ${rejected.length} rejected`);
    for (const { p, r } of rejected) {
      log("STAGE 3", `  rejected ${p.username}: ${r.status} ${r.body?.error ?? ""}`);
    }
  });

  const seated = players.filter((p) => p.seated);
  const entryRows = await prisma.tournamentEntry.count({ where: { tournamentId: TID } });
  check("exactly 60 seats sold", entryRows === FIELD, `${entryRows}`);
  check("exactly 60 successful joins", seated.length === FIELD, `${seated.length}`);
  check("player #61 was rejected", players.filter((p) => !p.seated).length === 1);

  // No duplicate joins: a second attempt must not create a row or charge again.
  const repeat = seated[0]!;
  const before = await getBalanceTetri(prisma, AccountKeys.userCash(repeat.userId));
  const dup = await api(`/api/tournaments/${TID}/register`, {
    method: "POST",
    cookie: repeat.cookie,
    stage: "duplicate-join",
  });
  const after = await getBalanceTetri(prisma, AccountKeys.userCash(repeat.userId));
  check("duplicate join is a no-op", dup.status === 200 && dup.body?.alreadyEntered === true);
  check("duplicate join did not charge twice", before === after, `${before} → ${after}`);
  check(
    "still exactly 60 entries after duplicate",
    (await prisma.tournamentEntry.count({ where: { tournamentId: TID } })) === FIELD
  );

  const escrow = await getBalanceTetri(prisma, AccountKeys.tournamentEscrow(TID));
  check("escrow holds ₾300", escrow === ENTRY * FIELD, `${escrow} tetri`);
  const drained = await Promise.all(
    seated.map((p) => getBalanceTetri(prisma, AccountKeys.userCash(p.userId)))
  );
  check("every seated player paid ₾5", drained.every((b) => b === 0), `nonzero: ${drained.filter((b) => b !== 0).length}`);

  // ── Stage 4: the real 60-second countdown ──
  await stage("countdown", async () => {
    const t = await prisma.tournament.findUniqueOrThrow({ where: { id: TID } });
    const secs = Math.round((t.startsAt.getTime() - Date.now()) / 1000);
    log("STAGE 4", `field full — draw in ${secs}s (waiting it out for real)`);
    check("countdown armed to ~60s", secs > 40 && secs <= 61, `${secs}s`);
    while (true) {
      const s = await api(`/api/tournaments/${TID}/state`, { stage: "state" });
      if (s.body?.status === "RUNNING") break;
      const left = Math.max(0, Math.round((new Date(s.body?.startsAt).getTime() - Date.now()) / 1000));
      if (left % 15 === 0) log("STAGE 4", `  ${left}s to the draw…`);
      await sleep(2000);
    }
    log("STAGE 4", "bracket drawn by the scheduler");
  });

  // ── Stage 5: bracket shape ──
  const r1 = await prisma.bracketMatch.findMany({ where: { tournamentId: TID, round: 1 } });
  const allSlots = await prisma.bracketMatch.findMany({ where: { tournamentId: TID } });
  const rounds = Math.max(...allSlots.map((m) => m.round));
  const byes = r1.filter((m) => m.status === "DONE" && !m.bUserId);
  log("STAGE 5", `${r1.length} first-round slots · ${byes.length} byes · ${rounds} rounds`);
  check("32 first-round slots", r1.length === 32, `${r1.length}`);
  check("4 byes auto-advanced", byes.length === 4, `${byes.length}`);
  check("6 rounds", rounds === 6, `${rounds}`);
  check(
    "no orphan slots — every non-bye pairing has two players",
    r1.filter((m) => m.status === "OPEN").every((m) => m.aUserId && m.bUserId)
  );
  check(
    "every seated player is in the draw",
    new Set([...r1.flatMap((m) => [m.aUserId, m.bUserId])].filter(Boolean)).size === FIELD
  );

  // ── Stage 6: play it out, round by round, at human pace ──
  const byId = new Map(players.map((p) => [p.userId, p]));
  const roundLog: string[] = [];
  let submissions = 0;
  let forfeits = 0;

  await stage("play", async () => {
    let guard = 0;
    let lastRoundSeen = 0;
    while (guard++ < 300) {
      const t = await prisma.tournament.findUniqueOrThrow({ where: { id: TID } });
      if (t.status !== "RUNNING") break;

      const open = await prisma.bracketMatch.findMany({
        where: { tournamentId: TID, status: "OPEN" },
        orderBy: [{ round: "asc" }, { slot: "asc" }],
      });
      if (open.length === 0) {
        await api(`/api/tournaments/${TID}/state`, { stage: "state" }); // nudge the driver
        await sleep(1500);
        continue;
      }

      const round = open[0]!.round;
      if (round !== lastRoundSeen) {
        lastRoundSeen = round;
        const label = round === rounds ? "Final + third place" : `Round ${round}`;
        log("STAGE 6", `${label} — ${open.length} live ${open.length === 1 ? "match" : "matches"}`);
      }

      // Everyone in this round plays, in parallel, each after their own think time.
      const duties: Promise<void>[] = [];
      for (const m of open) {
        for (const uid of [m.aUserId, m.bUserId].filter(Boolean) as string[]) {
          const p = byId.get(uid);
          if (!p) continue;
          const alreadyPlayed = uid === m.aUserId ? m.aPlayed : m.bPlayed;
          if (alreadyPlayed) continue;
          if (p.noShow && m.round === 1) continue; // deliberate forfeit

          duties.push(
            (async () => {
              await sleep(1500 + Math.random() * 9000); // realistic time to sit down and play
              const inputs = playSeed(m.seed!, p.skill, gameDurationMs);
              const res = await api(`/api/tournaments/${TID}/submit`, {
                method: "POST",
                cookie: p.cookie,
                body: JSON.stringify({ inputs }),
                stage: "submit",
              });
              if (res.status === 200) submissions++;
              else if (res.status !== 409) {
                apiErrors.push({ stage: "submit", detail: `${p.username}: ${res.status} ${JSON.stringify(res.body)}` });
              }
            })()
          );
        }
      }
      if (duties.length > 0) await Promise.all(duties);

      // Anyone left is a no-show: the ready check has to close the match.
      const stillOpen = await prisma.bracketMatch.count({
        where: { tournamentId: TID, round, status: "OPEN" },
      });
      if (stillOpen > 0) {
        const oldest = await prisma.bracketMatch.findFirst({
          where: { tournamentId: TID, round, status: "OPEN" },
          orderBy: { openedAt: "asc" },
        });
        const closesIn = oldest?.openedAt
          ? oldest.openedAt.getTime() + tournament.readyWindowS * 1000 - Date.now()
          : 0;
        if (closesIn > 0) {
          log("STAGE 6", `  ${stillOpen} no-show ${stillOpen === 1 ? "match" : "matches"} — waiting out the ${Math.ceil(closesIn / 1000)}s ready check`);
          await sleep(closesIn + 2000);
          forfeits += stillOpen;
        }
      }

      // Poll the live endpoint the way the UI does; it also drives the bracket.
      await api(`/api/tournaments/${TID}/state`, { stage: "state" });
      await sleep(1200);

      const done = await prisma.bracketMatch.count({
        where: { tournamentId: TID, round, status: "DONE" },
      });
      const total = await prisma.bracketMatch.count({ where: { tournamentId: TID, round } });
      if (done === total) roundLog.push(`round ${round}: ${done}/${total} resolved`);
    }
  });

  // ── Stage 7: verification ──
  const finished = await prisma.tournament.findUniqueOrThrow({ where: { id: TID } });
  check("tournament finished automatically", finished.status === "FINISHED", finished.status);
  check("finishedAt stamped", !!finished.finishedAt);

  const matches = await prisma.bracketMatch.findMany({
    where: { tournamentId: TID },
    orderBy: [{ round: "asc" }, { slot: "asc" }],
  });
  check("no stuck matches", matches.every((m) => m.status === "DONE"), `${matches.filter((m) => m.status !== "DONE").length} unresolved`);
  check("every match has a winner", matches.every((m) => !!m.winnerUserId));

  // Correct advancement: each winner appears in the right next-round slot.
  let advancementErrors = 0;
  for (const m of matches) {
    if (m.round >= rounds) continue;
    const nextSlot = Math.floor(m.slot / 2);
    const next = matches.find((x) => x.round === m.round + 1 && x.slot === nextSlot);
    if (!next) {
      advancementErrors++;
      continue;
    }
    const expected = m.slot % 2 === 0 ? next.aUserId : next.bUserId;
    if (expected !== m.winnerUserId) advancementErrors++;
  }
  check("every winner advanced into the correct slot", advancementErrors === 0, `${advancementErrors} mismatches`);

  const bronze = matches.find((m) => m.round === rounds && m.slot === 1);
  const final = matches.find((m) => m.round === rounds && m.slot === 0);
  check("third-place match was played", !!bronze && bronze.status === "DONE");
  check("third-place match had two real players", !!bronze?.aUserId && !!bronze?.bUserId);
  const semiLosers = matches
    .filter((m) => m.round === rounds - 1)
    .map((m) => (m.winnerUserId === m.aUserId ? m.bUserId : m.aUserId));
  check(
    "third-place match is contested by the two semifinal losers",
    !!bronze && semiLosers.every((l) => l === bronze.aUserId || l === bronze.bUserId)
  );

  const entries = await prisma.tournamentEntry.findMany({
    where: { tournamentId: TID },
    orderBy: { rank: "asc" },
  });
  check("all 60 players ranked", entries.filter((e) => e.rank != null).length === FIELD);
  check("ranks are unique 1..60", new Set(entries.map((e) => e.rank)).size === FIELD);
  check("1st paid ₾150", entries[0]?.prizeTetri === 15_000, `${entries[0]?.prizeTetri}`);
  check("2nd paid ₾90", entries[1]?.prizeTetri === 9_000, `${entries[1]?.prizeTetri}`);
  check("3rd paid ₾60", entries[2]?.prizeTetri === 6_000, `${entries[2]?.prizeTetri}`);
  check("4th paid nothing", entries[3]?.prizeTetri === 0, `${entries[3]?.prizeTetri}`);
  check("champion is the final's winner", entries[0]?.userId === final?.winnerUserId);
  check("third place is the bronze winner", entries[2]?.userId === bronze?.winnerUserId);

  const escrowAfter = await getBalanceTetri(prisma, AccountKeys.tournamentEscrow(TID));
  check("escrow returned to zero", escrowAfter === 0, `${escrowAfter}`);

  // No duplicate payouts: exactly one settlement transaction for this event.
  const settlements = await prisma.ledgerTransaction.count({
    where: { kind: "TOURNAMENT_PRIZE", refId: TID },
  });
  check("exactly one settlement posted", settlements === 1, `${settlements}`);
  const entryTx = await prisma.ledgerTransaction.count({
    where: { kind: "TOURNAMENT_ENTRY", refId: TID },
  });
  check("exactly 60 entry transactions", entryTx === FIELD, `${entryTx}`);

  // Wallets: everyone started at exactly ₾5 and spent it, so the balance is the prize.
  const walletRows: { player: Player; balance: number; rank: number | null; prize: number }[] = [];
  for (const e of entries) {
    const p = byId.get(e.userId)!;
    walletRows.push({
      player: p,
      balance: await getBalanceTetri(prisma, AccountKeys.userCash(e.userId)),
      rank: e.rank,
      prize: e.prizeTetri ?? 0,
    });
  }
  check(
    "every wallet equals its prize",
    walletRows.every((w) => w.balance === w.prize),
    walletRows.filter((w) => w.balance !== w.prize).map((w) => w.player.username).join(",") || "all match"
  );
  const unseated = players.find((p) => !p.seated)!;
  check(
    "rejected player keeps their ₾5",
    (await getBalanceTetri(prisma, AccountKeys.userCash(unseated.userId))) === ENTRY
  );

  // Rake must be measured on THIS tournament's settlement, not on the global
  // SYS_RAKE account — the seeded world already contains match rake.
  const settlementEntries = await prisma.ledgerEntry.findMany({
    where: { tx: { kind: "TOURNAMENT_PRIZE", refId: TID } },
    include: { account: { select: { key: true } } },
  });
  const tournamentRake = settlementEntries
    .filter((e) => e.account.key === AccountKeys.rake())
    .reduce((s, e) => s + e.amountTetri, 0);
  const prizesPaid = settlementEntries
    .filter((e) => e.account.key.startsWith("USER_CASH:"))
    .reduce((s, e) => s + e.amountTetri, 0);
  check("this tournament took zero rake", tournamentRake === 0, `${tournamentRake} tetri`);
  check("prizes paid equal the whole pool", prizesPaid === ENTRY * FIELD, `${prizesPaid} of ${ENTRY * FIELD}`);
  check(
    "settlement moved nothing to treasury",
    !settlementEntries.some((e) => e.account.key === AccountKeys.treasury())
  );
  const sum = await prisma.ledgerEntry.aggregate({ _sum: { amountTetri: true } });
  check("ledger is zero-sum", (sum._sum.amountTetri ?? 0) === 0, `${sum._sum.amountTetri}`);

  // ── Reports ──
  const nameOf = (id: string | null) => (id ? byId.get(id)?.username.replace(`sim${RUN_ID}`, "") ?? "?" : "—");

  console.log("\n" + "=".repeat(78));
  console.log("  BRACKET");
  console.log("=".repeat(78));
  for (let r = 1; r <= rounds; r++) {
    const label =
      r === rounds ? "Final" : r === rounds - 1 ? "Semifinals" : r === rounds - 2 ? "Quarterfinals" : `Round of ${2 ** (rounds - r + 1)}`;
    const inRound = matches.filter((m) => m.round === r && m.slot !== (r === rounds ? 1 : -1));
    console.log(`\n  ${label}`);
    for (const m of inRound) {
      const isBye = !m.bUserId;
      const label = (id: string | null, score: number | null) =>
        `${nameOf(id)}${score != null ? ` (${score})` : isBye ? "" : " (no-show)"}`;
      const a = label(m.aUserId, m.aScore);
      const b = isBye ? "bye" : label(m.bUserId, m.bScore);
      const w = nameOf(m.winnerUserId);
      console.log(`    ${a.padEnd(24)} vs ${b.padEnd(24)} → ${w}`);
    }
  }
  if (bronze) {
    console.log(`\n  Third-place match`);
    console.log(
      `    ${`${nameOf(bronze.aUserId)} (${bronze.aScore ?? "no-show"})`.padEnd(24)} vs ${`${nameOf(bronze.bUserId)} (${bronze.bScore ?? "no-show"})`.padEnd(24)} → ${nameOf(bronze.winnerUserId)}`
    );
  }

  console.log("\n" + "=".repeat(78));
  console.log("  WINNERS");
  console.log("=".repeat(78));
  for (const w of walletRows.slice(0, 4)) {
    const medal = w.rank === 1 ? "1st" : w.rank === 2 ? "2nd" : w.rank === 3 ? "3rd" : "4th";
    console.log(
      `  ${medal}  ${nameOf(w.player.userId).padEnd(10)} skill ${w.player.skill.toFixed(2)}  prize ₾${(w.prize / 100).toFixed(2).padStart(7)}  wallet ₾${(w.balance / 100).toFixed(2)}`
    );
  }

  console.log("\n" + "=".repeat(78));
  console.log("  WALLET BALANCES");
  console.log("=".repeat(78));
  const paid = walletRows.filter((w) => w.prize > 0);
  const zero = walletRows.filter((w) => w.prize === 0);
  console.log(`  started with          60 × ₾5.00 = ₾${((ENTRY * FIELD) / 100).toFixed(2)}`);
  console.log(`  paid out              ${paid.length} players = ₾${(paid.reduce((s, w) => s + w.prize, 0) / 100).toFixed(2)}`);
  console.log(`  eliminated at ₾0.00   ${zero.length} players`);
  console.log(`  rejected player       ₾${(ENTRY / 100).toFixed(2)} (untouched)`);

  console.log("\n" + "=".repeat(78));
  console.log("  LEDGER SUMMARY");
  console.log("=".repeat(78));
  const accounts = await prisma.account.groupBy({
    by: ["type"],
    _sum: { balanceTetri: true },
    _count: { _all: true },
  });
  for (const a of accounts) {
    console.log(
      `  ${a.type.padEnd(20)} ${String(a._count._all).padStart(4)} accts  ₾${((a._sum.balanceTetri ?? 0) / 100).toFixed(2).padStart(12)}`
    );
  }
  console.log(`  ${"TOTAL".padEnd(20)}      ${" ".repeat(6)} ₾${((sum._sum.amountTetri ?? 0) / 100).toFixed(2).padStart(12)}`);
  console.log(`  settlement txs ${settlements} · entry txs ${entryTx} · escrow now ₾${(escrowAfter / 100).toFixed(2)}`);

  console.log("\n" + "=".repeat(78));
  console.log("  ERRORS");
  console.log("=".repeat(78));
  console.log(`  API errors (5xx / transport): ${apiErrors.length}`);
  apiErrors.slice(0, 10).forEach((e) => console.log(`    ${e.stage}: ${e.detail}`));
  console.log(`  Database errors:              ${dbErrors.length}`);
  dbErrors.slice(0, 10).forEach((e) => console.log(`    ${e.stage}: ${e.detail}`));

  console.log("\n" + "=".repeat(78));
  console.log("  TIMING");
  console.log("=".repeat(78));
  for (const t of timings) {
    console.log(`  ${t.stage.padEnd(14)} ${(t.ms / 1000).toFixed(1).padStart(7)}s`);
  }
  console.log(`  ${"TOTAL".padEnd(14)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s`);
  roundLog.forEach((r) => console.log(`  ${r}`));

  console.log("\n" + "=".repeat(78));
  console.log("  PERFORMANCE");
  console.log("=".repeat(78));
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  console.log(`  HTTP requests        ${latencies.length}`);
  console.log(`  score submissions    ${submissions}`);
  console.log(`  forfeited matches    ${forfeits}`);
  console.log(`  latency  p50 ${pct(50)}ms · p95 ${pct(95)}ms · p99 ${pct(99)}ms · max ${sorted[sorted.length - 1]}ms`);
  console.log(`  burst join p95       ${pct(95)}ms (13 concurrent claims for the last 12 seats)`);

  console.log("\n" + "=".repeat(78));
  if (failures.length === 0 && apiErrors.length === 0 && dbErrors.length === 0) {
    console.log("  ✅ SIMULATION PASSED — every check green, no errors");
    console.log("=".repeat(78) + "\n");
    process.exit(0);
  }
  console.log(`  ❌ SIMULATION FAILED — ${failures.length} failed checks, ${apiErrors.length} API errors`);
  failures.forEach((f) => console.log(`     • ${f}`));
  console.log("=".repeat(78) + "\n");
  process.exit(1);
}

main().catch(async (e) => {
  console.error("\n💥 simulation aborted:", e);
  process.exit(1);
});
