/**
 * Score-distribution harness for the Block Blast engine.
 *
 * The Blitz payout curve pays real money off the ABSOLUTE score, so any change
 * to scoring silently moves the house edge. This measures the distribution over
 * many seeds at several skill levels, so a scoring change can be re-tuned back
 * onto the same break-even instead of being eyeballed.
 *
 * Skill is modelled as lookahead + sloppiness, not as a magic number:
 *   casual  — picks the first legal move fairly often, no line-seeking
 *   decent  — greedy on lines cleared, 22% random (matches the demo bot)
 *   skilled — greedy on a shaped heuristic (lines, then flatness), no mistakes
 *
 *   npx tsx tools/block-blast-distribution.ts [runs]
 */
import {
  BLOCK_BLAST_RULES_LATEST,
  BlockBlastEngine,
  GRID,
  type BlockBlastRulesVersion,
  type Shape,
} from "@gamearena/games";

const RUNS = Number(process.argv[2] ?? 400);
const RULES = Number(process.argv[3] ?? BLOCK_BLAST_RULES_LATEST) as BlockBlastRulesVersion;
/** A 60s round is ~35-50 placements for a human at speed. */
const MAX_MOVES = 44;

type Candidate = { s: number; r: number; c: number; lines: number; holes: number; contact: number };

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

  // Isolated empty cells are what eventually jams an 8x8 board.
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

  // Placements that hug existing blocks keep the board tidy.
  let contact = 0;
  for (const [dr, dc] of shape.cells) {
    const rr = r + dr;
    const cc = c + dc;
    for (const [ar, ac] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const nr = rr + ar;
      const nc = cc + ac;
      if (nr < 0 || nc < 0 || nr >= GRID || nc >= GRID) contact++;
      else if (grid[nr * GRID + nc]) contact++;
    }
  }
  return { lines, holes, contact };
}

type Skill = "casual" | "decent" | "skilled";

function playOne(seed: string, skill: Skill, rand: () => number): { score: number; moves: number; maxCombo: number } {
  const eng = new BlockBlastEngine(seed, RULES);
  let moves = 0;
  let maxCombo = 0;

  for (let m = 0; m < MAX_MOVES && !eng.isOver(); m++) {
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
    if (skill === "casual") {
      pick = rand() < 0.55 ? legal[Math.floor(rand() * legal.length)]! : legal.reduce((a, b) => (b.lines > a.lines ? b : a));
    } else if (skill === "decent") {
      pick = rand() < 0.22 ? legal[Math.floor(rand() * legal.length)]! : legal.reduce((a, b) => (b.lines > a.lines ? b : a));
    } else {
      const score = (x: Candidate) => x.lines * 100 - x.holes * 8 + x.contact * 1.5;
      pick = legal.reduce((a, b) => (score(b) > score(a) ? b : a));
    }

    if (!eng.applyInput({ t: 0, s: pick.s, r: pick.r, c: pick.c })) break;
    moves++;
    maxCombo = Math.max(maxCombo, eng.getState().combo);
  }
  return { score: eng.getScore(), moves, maxCombo };
}

/** Deterministic PRNG so runs are comparable across engine versions. */
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const BREAK_EVEN = 800;

console.log(`\nBLOCK BLAST SCORE DISTRIBUTION · rules v${RULES} · ${RUNS} runs per skill · ${MAX_MOVES} moves max\n`);
console.log("skill     median    p25    p75    p90    p99    max  | ≥800   avg moves  avg maxCombo");
console.log("─".repeat(88));

const summary: Record<string, { median: number; pctOverBreakEven: number }> = {};

for (const skill of ["casual", "decent", "skilled"] as Skill[]) {
  const rand = mulberry32(0xbeef);
  const rows = Array.from({ length: RUNS }, (_, i) => playOne(`dist-${i}`, skill, rand));
  const scores = rows.map((r) => r.score).sort((a, b) => a - b);
  const over = scores.filter((s) => s >= BREAK_EVEN).length;
  const avgMoves = rows.reduce((n, r) => n + r.moves, 0) / rows.length;
  const avgCombo = rows.reduce((n, r) => n + r.maxCombo, 0) / rows.length;
  summary[skill] = { median: pct(scores, 50), pctOverBreakEven: (over / RUNS) * 100 };
  console.log(
    `${skill.padEnd(9)} ${String(pct(scores, 50)).padStart(5)}  ${String(pct(scores, 25)).padStart(5)}  ` +
      `${String(pct(scores, 75)).padStart(5)}  ${String(pct(scores, 90)).padStart(5)}  ` +
      `${String(pct(scores, 99)).padStart(5)}  ${String(scores[scores.length - 1]).padStart(5)}  | ` +
      `${((over / RUNS) * 100).toFixed(1).padStart(5)}%  ${avgMoves.toFixed(1).padStart(9)}  ${avgCombo.toFixed(2).padStart(12)}`
  );
}

console.log(
  `\nBreak-even is ${BREAK_EVEN}. The published curve assumes only skilled play clears it:` +
    ` casual ${summary.casual!.pctOverBreakEven.toFixed(1)}%,` +
    ` decent ${summary.decent!.pctOverBreakEven.toFixed(1)}%,` +
    ` skilled ${summary.skilled!.pctOverBreakEven.toFixed(1)}%.\n`
);
