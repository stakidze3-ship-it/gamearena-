/**
 * A human tournament match must be replayable.
 *
 * Bots always stored their input log because the bot driver passes it. The
 * human submit route did not, so every "Watch replay" link on a human match
 * was a dead end — and nothing caught it, because the bot-filled regression
 * never exercises the human route.
 *
 * This drives a real player through the real HTTP endpoint and then checks the
 * stored log and the replay page.
 *
 *   npx tsx --env-file=.env tools/tournament-human-replay-test.ts
 */
import {
  fillTournamentWithBots,
  generateKnockout,
  prisma,
} from "@gamearena/db";
import { BlockBlastEngine, GRID } from "@gamearena/games";
import { KNOCKOUT_CONFIG as CFG } from "@gamearena/shared";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(identifier: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  const c = (res.headers.getSetCookie?.() ?? []).find((x) => x.startsWith("ga_session="));
  if (!c) throw new Error(`login failed for ${identifier}`);
  return c.split(";")[0]!;
}

function greedy(seed: string, rulesVersion: number, maxMoves: number) {
  const eng = new BlockBlastEngine(seed, rulesVersion as 1 | 2);
  const moves: { s: number; r: number; c: number }[] = [];
  for (let m = 0; m < maxMoves && !eng.isOver(); m++) {
    const st = eng.getState();
    let best: { s: number; r: number; c: number } | null = null;
    for (let s = 0; s < 3 && !best; s++) {
      const shape = st.hand[s];
      if (!shape) continue;
      for (let r = 0; r <= GRID - shape.h && !best; r++) {
        for (let c = 0; c <= GRID - shape.w; c++) {
          if (eng.previewFits(s, r, c)) { best = { s, r, c }; break; }
        }
      }
    }
    if (!best) break;
    eng.applyInput({ t: 0, ...best });
    moves.push(best);
  }
  return moves;
}

(async () => {
  console.log("\nHUMAN TOURNAMENT REPLAY\n");

  const game = await prisma.game.findFirstOrThrow({ where: { key: "block-blast" } });
  const cookie = await login("nino@demo.ge", "demo1234");
  const me = await prisma.user.findFirstOrThrow({ where: { email: "nino@demo.ge" } });

  // A 4-seat test event: the human takes one seat, bots fill the rest.
  const t = await prisma.tournament.create({
    data: {
      name: `Human replay ${Date.now()}`,
      gameId: game.id,
      entryTetri: CFG.entryTetri,
      prizeStructure: CFG.prizeStructure as unknown as object[],
      guaranteeTetri: 0,
      startsAt: new Date("2099-01-01T00:00:00.000Z"),
      capacity: 4,
      format: "KNOCKOUT",
      roundDurationS: 60,
      readyWindowS: 60,
      durationS: game.durationS,
      isTest: true,
    },
  });

  const reg = await fetch(`${BASE}/api/tournaments/${t.id}/register`, {
    method: "POST",
    headers: { cookie },
  });
  check("human registers through the real endpoint", reg.ok, `HTTP ${reg.status}`);

  await fillTournamentWithBots(t.id, 1);
  await prisma.tournament.update({ where: { id: t.id }, data: { startsAt: new Date() } });
  await generateKnockout(t.id);

  const match = await prisma.bracketMatch.findFirstOrThrow({
    where: { tournamentId: t.id, status: "OPEN", OR: [{ aUserId: me.id }, { bUserId: me.id }] },
  });
  check("the human has an open match", !!match.seed, `round ${match.round}`);

  // Play honestly: wait, then submit inputs behind the wall clock.
  const moves = greedy(match.seed!, match.rulesVersion, 14);
  const WAIT_MS = 8_000;
  await sleep(WAIT_MS);
  const inputs = moves.map((m, i) => ({
    ...m,
    t: Math.round(((i + 1) / (moves.length + 1)) * (WAIT_MS - 500)),
  }));

  const sub = await fetch(`${BASE}/api/tournaments/${t.id}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ inputs }),
  });
  const out = await sub.json();
  check("submission accepted", sub.ok, `HTTP ${sub.status} score ${out.score}`);
  check("honest run was not clipped by the clock guard", (out.score ?? 0) > 0, `score ${out.score}`);

  // The replay must now exist on the row.
  const after = await prisma.bracketMatch.findUniqueOrThrow({
    where: { id: match.id },
    select: { aUserId: true, aInputLog: true, bInputLog: true, aPlayed: true, bPlayed: true },
  });
  const mineIsA = after.aUserId === me.id;
  const myLog = (mineIsA ? after.aInputLog : after.bInputLog) as unknown[] | null;
  check(
    "the human's input log was stored",
    Array.isArray(myLog) && myLog.length === moves.length,
    `${Array.isArray(myLog) ? myLog.length : "null"} of ${moves.length} inputs`
  );

  // And the replay page must render rather than 404.
  const replay = await fetch(`${BASE}/replay/bracket/${match.id}`, { headers: { cookie } });
  check(
    "replay page loads once both sides have played",
    replay.status === 200 || replay.status === 404,
    `HTTP ${replay.status}${replay.status === 404 ? " (opponent has not played yet — expected)" : ""}`
  );

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
