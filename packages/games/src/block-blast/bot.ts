/**
 * Deterministic Block Blast bot.
 *
 * Lives in the shared package because both the realtime service (1v1 demo
 * opponents) and the web app (tournament bot fill) need it, and apps cannot
 * import from each other.
 *
 * Deterministic on purpose. The previous bot used Math.random, so a bot's run
 * could not be reproduced — which is fine for a throwaway 1v1 opponent but not
 * for a tournament, where the match is stored, re-simulated by the server and
 * replayable by spectators. Given the same (seed, strength) this always
 * produces the same inputs, so a bot match verifies exactly like a human one.
 */

import { Rng } from "../rng";
import { BLOCK_BLAST_RULES_LATEST, BlockBlastEngine, GRID, type BlockBlastRulesVersion } from "./engine";
import type { BlockBlastInput } from "./engine";
import type { Shape } from "./pieces";

/**
 * How well a bot plays, 0..1.
 *
 * Drives both how often it takes the best available move and how many moves it
 * gets through in the round. Spread across a field so a bracket has believable
 * favourites and underdogs rather than 60 identical players.
 */
export type BotStrength = number;

export interface BotPlan {
  inputs: BlockBlastInput[];
  score: number;
}

interface Candidate {
  s: number;
  r: number;
  c: number;
  lines: number;
  holes: number;
  contact: number;
}

/** Score a hypothetical placement: lines first, then board tidiness. */
function evaluate(grid: boolean[], shape: Shape, r: number, c: number): Omit<Candidate, "s" | "r" | "c"> {
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

  // Fully enclosed empty cells are what eventually jams an 8x8 board.
  let holes = 0;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      if (g[i * GRID + j]) continue;
      let walled = 0;
      if (i === 0 || g[(i - 1) * GRID + j]) walled++;
      if (i === GRID - 1 || g[(i + 1) * GRID + j]) walled++;
      if (j === 0 || g[i * GRID + j - 1]) walled++;
      if (j === GRID - 1 || g[i * GRID + j + 1]) walled++;
      if (walled === 4) holes++;
    }
  }

  let contact = 0;
  for (const [dr, dc] of shape.cells) {
    for (const [ar, ac] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nr = r + dr + ar;
      const nc = c + dc + ac;
      if (nr < 0 || nc < 0 || nr >= GRID || nc >= GRID) contact++;
      else if (grid[nr * GRID + nc]) contact++;
    }
  }
  return { lines, holes, contact };
}

/**
 * Plan a complete bot run for a seed.
 *
 * Timestamps are spread across `durationMs` so a stored replay plays back at a
 * believable pace instead of dumping every placement at t=0.
 */
export function planBotRun(
  seed: string,
  durationMs: number,
  strength: BotStrength,
  rulesVersion: BlockBlastRulesVersion = BLOCK_BLAST_RULES_LATEST
): BotPlan {
  const rng = new Rng(`bot:${seed}:${strength.toFixed(3)}`);
  const eng = new BlockBlastEngine(seed, rulesVersion);
  const clamped = Math.max(0, Math.min(1, strength));

  // A weak bot both plays fewer moves and misplays more often.
  const maxMoves = Math.round(18 + clamped * 30); // 18..48
  const sloppiness = 0.45 * (1 - clamped); // 0.45 down to 0

  const placements: Omit<BlockBlastInput, "t">[] = [];
  for (let m = 0; m < maxMoves && !eng.isOver(); m++) {
    const st = eng.getState();
    const legal: Candidate[] = [];
    for (let s = 0; s < 3; s++) {
      const shape = st.hand[s];
      if (!shape) continue;
      for (let r = 0; r <= GRID - shape.h; r++) {
        for (let c = 0; c <= GRID - shape.w; c++) {
          if (!eng.previewFits(s, r, c)) continue;
          legal.push({ s, r, c, ...evaluate(st.grid, shape, r, c) });
        }
      }
    }
    if (legal.length === 0) break;

    let pick: Candidate;
    if (rng.next() < sloppiness) {
      pick = legal[Math.floor(rng.next() * legal.length)]!;
    } else {
      const rank = (x: Candidate) => x.lines * 100 - x.holes * 8 + x.contact * 1.5;
      pick = legal.reduce((a, b) => (rank(b) > rank(a) ? b : a));
    }
    if (!eng.applyInput({ t: 0, s: pick.s, r: pick.r, c: pick.c })) break;
    placements.push({ s: pick.s, r: pick.r, c: pick.c });
  }

  // Spread the placements over ~95% of the round with deterministic jitter, so
  // a spectator watching live sees the score climb rather than jump.
  const span = durationMs * 0.95;
  const inputs = placements.map((p, i) => {
    const base = Math.round(((i + 1) / (placements.length + 1)) * span);
    const jitter = Math.round((rng.next() - 0.5) * 500);
    return { ...p, t: Math.max(0, Math.min(durationMs - 1, base + jitter)) };
  });
  // Timestamps must be non-decreasing or simulate() drops the out-of-order ones.
  inputs.sort((a, b) => a.t - b.t);

  // Re-run through a clean engine so the reported score is exactly what the
  // server will compute from these inputs.
  const verify = new BlockBlastEngine(seed, rulesVersion);
  for (const inp of inputs) verify.applyInput(inp);

  return { inputs, score: verify.getScore() };
}
