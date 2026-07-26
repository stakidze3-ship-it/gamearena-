/**
 * A human plays a tournament from registration to settlement.
 *
 * Every existing tournament test drives bots, which take a different code path
 * from a person: bots submit through the driver, humans through the HTTP route
 * and the React screen. That gap is why "Ready Up crashes the page" shipped
 * without anything failing — a hook below an early return killed the render on
 * the exact click that starts a match, and no bot ever clicks it.
 *
 * This registers a real account, plays EVERY round it reaches through the real
 * endpoint, and checks it advances or exits correctly at each step.
 *
 *   npx tsx --env-file=.env tools/tournament-full-play-test.ts [seats]
 */
import {
  advanceKnockout,
  driveBotMatches,
  fillTournamentWithBots,
  finalizeKnockout,
  generateKnockout,
  prisma,
} from "@gamearena/db";
import { BlockBlastEngine, GRID } from "@gamearena/games";
import { KNOCKOUT_CONFIG as CFG } from "@gamearena/shared";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const SEATS = Number(process.argv[2] ?? 8);
const ROUND_S = 75;
/** A real player uses the whole 60s round; anything less cannot out-score a bot. */
const HUMAN_PLAY_MS = 58_000;

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cookieFor(identifier: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password: "demo1234" }),
  });
  const c = (res.headers.getSetCookie?.() ?? []).find((x) => x.startsWith("ga_session="));
  if (!c) throw new Error(`login failed for ${identifier}`);
  return c.split(";")[0]!;
}

/**
 * A strong human line.
 *
 * Greedy-on-clears loses round one against a mid-strength bot, which meant the
 * later rounds were only ever exercised by bots — the exact blind spot that let
 * a crash on Ready Up reach production. A short beam search plays like someone
 * who is actually good, so the human reaches the semifinal and final and those
 * rounds get covered through the HTTP route too.
 */
function play(seed: string, rulesVersion: number, maxMoves: number, beam = 12) {
  type Node = { moves: { s: number; r: number; c: number }[]; score: number };
  const rebuild = (moves: Node["moves"]) => {
    const eng = new BlockBlastEngine(seed, rulesVersion as 1 | 2);
    for (const m of moves) eng.applyInput({ t: 0, ...m });
    return eng;
  };
  let nodes: Node[] = [{ moves: [], score: 0 }];
  for (let d = 0; d < maxMoves; d++) {
    const next: Node[] = [];
    for (const n of nodes) {
      const eng = rebuild(n.moves);
      if (eng.isOver()) { next.push(n); continue; }
      const st = eng.getState();
      for (let s = 0; s < 3; s++) {
        const shape = st.hand[s];
        if (!shape) continue;
        for (let r = 0; r <= GRID - shape.h; r++) {
          for (let c = 0; c <= GRID - shape.w; c++) {
            if (!eng.previewFits(s, r, c)) continue;
            const moves = [...n.moves, { s, r, c }];
            next.push({ moves, score: rebuild(moves).getScore() });
          }
        }
      }
    }
    if (!next.length) break;
    next.sort((a, b) => b.score - a.score);
    nodes = next.slice(0, beam);
  }
  return nodes[0]!.moves;
}

(async () => {
  console.log(`\nFULL TOURNAMENT · one human, ${SEATS - 1} bots, every round\n`);
  const cookie = await cookieFor("tamar@demo.ge");
  const me = await prisma.user.findFirstOrThrow({ where: { email: "tamar@demo.ge" } });
  const game = await prisma.game.findFirstOrThrow({ where: { key: "block-blast" } });

  const t = await prisma.tournament.create({
    data: {
      name: `Full play ${Date.now()}`,
      gameId: game.id,
      entryTetri: CFG.entryTetri,
      prizeStructure: CFG.prizeStructure as unknown as object[],
      guaranteeTetri: 0,
      startsAt: new Date("2099-01-01T00:00:00.000Z"),
      capacity: SEATS,
      format: "KNOCKOUT",
      roundDurationS: ROUND_S,
      readyWindowS: ROUND_S,
      durationS: game.durationS,
      isTest: true,
    },
  });

  const reg = await fetch(`${BASE}/api/tournaments/${t.id}/register`, { method: "POST", headers: { cookie } });
  check("human registers", reg.ok, `HTTP ${reg.status}`);

  await fillTournamentWithBots(t.id, 1);
  await prisma.tournament.update({ where: { id: t.id }, data: { startsAt: new Date() } });
  const placed = await generateKnockout(t.id);
  check("bracket drawn", placed === SEATS, `${placed} players`);

  const totalRounds = (await prisma.bracketMatch.aggregate({
    where: { tournamentId: t.id }, _max: { round: true },
  }))._max.round!;
  console.log(`  ${totalRounds} rounds to play\n`);

  const roundsPlayed: number[] = [];
  const deadline = Date.now() + 600_000;

  while (Date.now() < deadline) {
    const status = (await prisma.tournament.findUniqueOrThrow({
      where: { id: t.id }, select: { status: true },
    })).status;
    if (status === "FINISHED") break;

    // Does the human owe a run this round?
    const mine = await prisma.bracketMatch.findFirst({
      where: {
        tournamentId: t.id, status: "OPEN",
        OR: [{ aUserId: me.id, aPlayed: false }, { bUserId: me.id, bPlayed: false }],
      },
    });

    if (mine?.seed) {
      // Play for a realistic length of time. The server scores only the window
      // that has actually elapsed, so a test that submits after four seconds
      // caps the human far below any bot and never reaches round two.
      await sleep(HUMAN_PLAY_MS + 2_000);
      // Play well enough to actually advance — otherwise the human exits in
      // round one and the later rounds are only ever exercised by bots, which
      // is precisely the blind spot that let the Ready Up crash ship.
      const moves = play(mine.seed, mine.rulesVersion, 34);
      const inputs = moves.map((m, i) => ({
        ...m, t: Math.round(((i + 1) / (moves.length + 1)) * HUMAN_PLAY_MS),
      }));
      const res = await fetch(`${BASE}/api/tournaments/${t.id}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ inputs }),
      });
      const out = await res.json();
      const isBronze = mine.round === totalRounds && mine.slot === 1;
      const label = isBronze ? "third-place playoff" : `round ${mine.round}`;
      check(`human played ${label} through the HTTP route`, res.ok, `HTTP ${res.status} score ${out.score}`);
      check(`  ${label} scored above zero`, (out.score ?? 0) > 0, `${out.score}`);
      roundsPlayed.push(mine.round);
    }

    await driveBotMatches(t.id);
    await advanceKnockout(t.id);
    await sleep(1_000);
  }

  const finalT = await prisma.tournament.findUniqueOrThrow({ where: { id: t.id } });
  if (finalT.status !== "FINISHED") await finalizeKnockout(t.id);
  const settled = await prisma.tournament.findUniqueOrThrow({ where: { id: t.id } });

  console.log("");
  check("the human played at least one round", roundsPlayed.length > 0, `rounds ${roundsPlayed.join(", ")}`);
  check("tournament finished", settled.status === "FINISHED", settled.status);

  const all = await prisma.bracketMatch.findMany({ where: { tournamentId: t.id } });
  check("every match resolved", all.every((m) => m.status === "DONE"),
    `${all.filter((m) => m.status !== "DONE").length} unresolved`);

  // The human's own matches must all be recorded and replayable.
  const myMatches = all.filter((m) => m.aUserId === me.id || m.bUserId === me.id);
  const myPlayed = myMatches.filter((m) => (m.aUserId === me.id ? m.aPlayed : m.bPlayed));
  check("every match the human ran was recorded", myPlayed.length === roundsPlayed.length,
    `${myPlayed.length} recorded vs ${roundsPlayed.length} played`);
  check(
    "and each stored a replay",
    myPlayed.every((m) => (m.aUserId === me.id ? m.aInputLog : m.bInputLog) != null),
    `${myPlayed.filter((m) => (m.aUserId === me.id ? m.aInputLog : m.bInputLog) != null).length}/${myPlayed.length}`
  );

  // Advancement is consistent: a winner appears in the next round.
  let advanceOk = true;
  for (const m of all.filter((x) => x.status === "DONE" && x.winnerUserId && x.round < totalRounds)) {
    const nextSlot = Math.floor(m.slot / 2);
    const next = all.find((x) => x.round === m.round + 1 && x.slot === nextSlot);
    if (next && next.aUserId !== m.winnerUserId && next.bUserId !== m.winnerUserId) advanceOk = false;
  }
  check("every winner advanced into their next slot", advanceOk);

  const prizeTx = await prisma.ledgerTransaction.findFirst({
    where: { kind: "TOURNAMENT_PRIZE", refId: t.id }, include: { entries: true },
  });
  check("prizes settled", !!prizeTx);
  check("settlement zero-sum", (prizeTx?.entries ?? []).reduce((n, e) => n + e.amountTetri, 0) === 0);

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
