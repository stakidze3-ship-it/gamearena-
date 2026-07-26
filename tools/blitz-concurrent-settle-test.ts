/**
 * Concurrent settlement of one Blitz run.
 *
 * A double-tap, a retried request or two open tabs all send the same submit
 * twice. The payout is idempotency-keyed, but "check the key, then insert" is
 * not atomic: both callers can find nothing and both insert, and the loser hits
 * a unique violation that aborts its transaction and surfaces as a bare 500 —
 * right after a winning run, which reads as lost winnings.
 *
 * This fires several concurrent submits at a run that actually PAYS, so the
 * contended path is the payout, not a no-op.
 *
 *   npx tsx --env-file=.env tools/blitz-concurrent-settle-test.ts
 */
import { AccountKeys, getBalanceTetri, prisma } from "@gamearena/db";
import { BlockBlastEngine, GRID, type BlockBlastInput } from "@gamearena/games";
import { formatTetri } from "@gamearena/shared";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const CONCURRENCY = 6;
const PLAY_MS = 24_000; // long enough to bank a paying score under the clock guard

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "mariam@demo.ge", password: "demo1234" }),
  });
  const c = (res.headers.getSetCookie?.() ?? []).find((x) => x.startsWith("ga_session="));
  if (!c) throw new Error("login failed");
  return c.split(";")[0]!;
}

/** Strongest line we can find, so the run clears the payout threshold. */
function optimise(seed: string, rulesVersion: number, beam = 24, maxMoves = 44) {
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
  return nodes[0]!;
}

(async () => {
  console.log("\nCONCURRENT BLITZ SETTLEMENT\n");
  const cookie = await login();
  const me = await prisma.user.findFirstOrThrow({ where: { email: "mariam@demo.ge" } });
  const before = await getBalanceTetri(prisma, AccountKeys.userCash(me.id));

  const run = await (
    await fetch(`${BASE}/api/blitz/start`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ gameKey: "block-blast", entryTetri: 100 }),
    })
  ).json();
  if (!run.runId) throw new Error(`start failed: ${JSON.stringify(run)}`);

  const best = optimise(run.seed, run.rulesVersion ?? 2);
  // Stamp inside the window we will actually have waited.
  const inputs: BlockBlastInput[] = best.moves.map((m, i) => ({
    ...m,
    t: Math.round(((i + 1) / (best.moves.length + 1)) * (PLAY_MS - 1_000)),
  }));
  console.log(`  run ${run.runId} · ${best.moves.length} moves · offline score ${best.score}`);
  console.log(`  waiting ${PLAY_MS / 1000}s so the run is legitimately playable…`);
  await sleep(PLAY_MS);

  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      const res = await fetch(`${BASE}/api/blitz/submit`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ runId: run.runId, inputs, clientScore: best.score }),
      });
      const body = await res.text();
      return { status: res.status, body };
    })
  );

  const codes = results.map((r) => r.status);
  const fiveHundreds = codes.filter((c) => c >= 500).length;
  console.log(`  status codes: ${codes.join(", ")}`);
  check("no request 500s", fiveHundreds === 0, `${fiveHundreds} of ${CONCURRENCY}`);
  check("every response has a body", results.every((r) => r.body.length > 0));

  const parsed = results.filter((r) => r.status === 200).map((r) => JSON.parse(r.body));
  const payouts = new Set(parsed.map((p) => p.payoutTetri));
  check("all responses agree on the payout", payouts.size === 1, `saw ${[...payouts].join(", ")}`);

  const settled = await prisma.blitzRun.findUniqueOrThrow({ where: { id: run.runId } });
  const after = await getBalanceTetri(prisma, AccountKeys.userCash(me.id));
  const expected = before - run.entryTetri + (settled.payoutTetri ?? 0);
  check(
    "balance moved exactly once",
    after === expected,
    `${formatTetri(before)} → ${formatTetri(after)} (expected ${formatTetri(expected)}), score ${settled.serverScore}, payout ${formatTetri(settled.payoutTetri ?? 0)}`
  );

  const prizeTxs = await prisma.ledgerTransaction.count({
    where: { kind: "BLITZ_PAYOUT", refId: run.runId },
  });
  check("at most one payout transaction exists", prizeTxs <= 1, `${prizeTxs} posted`);

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
