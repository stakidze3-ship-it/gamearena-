/**
 * Blitz wall-clock integrity.
 *
 * Two things must both hold, and they pull in opposite directions:
 *   - an honest player who really spent the round playing is scored in full
 *   - a run submitted faster than it could possibly have been played is not
 *
 * The second is what stops an offline optimiser: the seed is revealed at start
 * and the engine is deterministic, so without a wall-clock bound an attacker
 * can search for a strong line at leisure and submit it as a 60-second run.
 *
 *   npx tsx tools/blitz-timing-test.ts
 */
import { BlockBlastEngine, GRID, type BlockBlastInput } from "@gamearena/games";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
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
    body: JSON.stringify({ identifier: "nino@demo.ge", password: "demo1234" }),
  });
  const c = (res.headers.getSetCookie?.() ?? []).find((x) => x.startsWith("ga_session="));
  if (!c) throw new Error("no session cookie");
  return c.split(";")[0]!;
}

/** A plain greedy line — what a competent player would actually produce. */
function playGreedy(seed: string, rulesVersion: number, maxMoves: number) {
  const eng = new BlockBlastEngine(seed, rulesVersion as 1 | 2);
  const moves: Omit<BlockBlastInput, "t">[] = [];
  for (let m = 0; m < maxMoves && !eng.isOver(); m++) {
    const st = eng.getState();
    let best: { s: number; r: number; c: number; lines: number } | null = null;
    for (let s = 0; s < 3; s++) {
      const shape = st.hand[s];
      if (!shape) continue;
      for (let r = 0; r <= GRID - shape.h; r++) {
        for (let c = 0; c <= GRID - shape.w; c++) {
          if (!eng.previewFits(s, r, c)) continue;
          const g = st.grid.slice();
          for (const [dr, dc] of shape.cells) g[(r + dr) * GRID + (c + dc)] = true;
          let lines = 0;
          for (let i = 0; i < GRID; i++) {
            let rf = true, cf = true;
            for (let j = 0; j < GRID; j++) {
              if (!g[i * GRID + j]) rf = false;
              if (!g[j * GRID + i]) cf = false;
            }
            if (rf) lines++;
            if (cf) lines++;
          }
          if (!best || lines > best.lines) best = { s, r, c, lines };
        }
      }
    }
    if (!best) break;
    if (!eng.applyInput({ t: 0, s: best.s, r: best.r, c: best.c })) break;
    moves.push({ s: best.s, r: best.r, c: best.c });
  }
  return moves;
}

async function startRun(cookie: string) {
  const res = await fetch(`${BASE}/api/blitz/start`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ gameKey: "block-blast", entryTetri: 100 }),
  });
  return res.json();
}

async function submit(cookie: string, runId: string, inputs: BlockBlastInput[]) {
  const res = await fetch(`${BASE}/api/blitz/submit`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ runId, inputs, clientScore: 0 }),
  });
  return res.json();
}

(async () => {
  console.log("\nBLITZ WALL-CLOCK INTEGRITY\n");
  const cookie = await login();

  // ── 1. Honest play: really wait, then submit inputs behind the wall clock ──
  {
    const run = await startRun(cookie);
    const moves = playGreedy(run.seed, run.rulesVersion ?? 2, 20);
    const WAIT_MS = 9_000;
    await sleep(WAIT_MS);
    // Timestamps spread across the time actually spent — what the board records.
    const inputs: BlockBlastInput[] = moves.map((m, i) => ({
      ...m,
      t: Math.round(((i + 1) / (moves.length + 1)) * (WAIT_MS - 500)),
    }));
    const out = await submit(cookie, run.runId, inputs);
    check(
      "an honest run is scored in full",
      out.rejected === 0 && out.applied === moves.length,
      `${out.applied}/${moves.length} applied, ${out.rejected} rejected, score ${out.serverScore}`
    );
  }

  // ── 2. The offline optimiser: same shape, submitted instantly ──
  {
    const run = await startRun(cookie);
    const moves = playGreedy(run.seed, run.rulesVersion ?? 2, 44);
    const durationMs = (run.durationS ?? 60) * 1000;
    // Claims a full round's worth of play, submitted immediately.
    const inputs: BlockBlastInput[] = moves.map((m, i) => ({
      ...m,
      t: Math.round(((i + 1) / (moves.length + 1)) * durationMs * 0.95),
    }));
    const out = await submit(cookie, run.runId, inputs);
    check(
      "an instantly-submitted full round is rejected",
      out.rejected > 0 && out.payoutTetri === 0,
      `${out.applied} applied, ${out.rejected} rejected, payout ${out.payoutTetri}`
    );
    check(
      "and it never profits",
      (out.payoutTetri ?? 0) <= run.entryTetri,
      `paid ${out.payoutTetri} on a ${run.entryTetri} entry`
    );
  }

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
