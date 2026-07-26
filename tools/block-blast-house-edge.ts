/**
 * House-edge comparison across engine rule sets.
 *
 * A ">= 800" count is the wrong measure: the Blitz curve is piecewise-linear,
 * so what actually decides the edge is the EXPECTED multiplier over the whole
 * score distribution. This runs the same seeded players under each rule set and
 * reports E[multiplier], which is what must stay put when scoring changes.
 *
 *   npx tsx tools/block-blast-house-edge.ts [runs]
 */
import { BlockBlastEngine, GRID, type BlockBlastRulesVersion, type Shape } from "@gamearena/games";
import { DEFAULT_BLITZ_CURVE, multiplierBpsForScore } from "@gamearena/shared";

const RUNS = Number(process.argv[2] ?? 600);
const MAX_MOVES = 44;
const MAX_MULT_BPS = 25_000;

type Cand = { s: number; r: number; c: number; lines: number; holes: number; contact: number };

function evaluate(grid: boolean[], shape: Shape, r: number, c: number) {
  const g = grid.slice();
  for (const [dr, dc] of shape.cells) g[(r + dr) * GRID + (c + dc)] = true;
  let lines = 0;
  for (let i = 0; i < GRID; i++) {
    let rf = true;
    let cf = true;
    for (let j = 0; j < GRID; j++) {
      if (!g[i * GRID + j]) rf = false;
      if (!g[j * GRID + i]) cf = false;
    }
    if (rf) lines++;
    if (cf) lines++;
  }
  let holes = 0;
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      if (g[i * GRID + j]) continue;
      let w = 0;
      if (i === 0 || g[(i - 1) * GRID + j]) w++;
      if (i === GRID - 1 || g[(i + 1) * GRID + j]) w++;
      if (j === 0 || g[i * GRID + j - 1]) w++;
      if (j === GRID - 1 || g[i * GRID + j + 1]) w++;
      if (w === 4) holes++;
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

type Skill = "casual" | "decent" | "skilled";

function playOne(seed: string, skill: Skill, rules: BlockBlastRulesVersion, rand: () => number): number {
  const eng = new BlockBlastEngine(seed, rules);
  for (let m = 0; m < MAX_MOVES && !eng.isOver(); m++) {
    const st = eng.getState();
    const legal: Cand[] = [];
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
    if (!legal.length) break;
    let pick: Cand;
    if (skill === "casual") {
      pick = rand() < 0.55 ? legal[Math.floor(rand() * legal.length)]! : legal.reduce((a, b) => (b.lines > a.lines ? b : a));
    } else if (skill === "decent") {
      pick = rand() < 0.22 ? legal[Math.floor(rand() * legal.length)]! : legal.reduce((a, b) => (b.lines > a.lines ? b : a));
    } else {
      const sc = (x: Cand) => x.lines * 100 - x.holes * 8 + x.contact * 1.5;
      pick = legal.reduce((a, b) => (sc(b) > sc(a) ? b : a));
    }
    if (!eng.applyInput({ t: 0, s: pick.s, r: pick.r, c: pick.c })) break;
  }
  return eng.getScore();
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Expected multiplier (1.0 = break-even for the player; below 1.0 = house edge). */
function expectedMult(rules: BlockBlastRulesVersion, skill: Skill): number {
  const rand = mulberry32(0xbeef);
  let total = 0;
  for (let i = 0; i < RUNS; i++) {
    const score = playOne(`dist-${i}`, skill, rules, rand);
    total += multiplierBpsForScore(DEFAULT_BLITZ_CURVE, score, MAX_MULT_BPS);
  }
  return total / RUNS / 10_000;
}

console.log(`\nHOUSE EDGE BY RULE SET · ${RUNS} runs per cell · default Blitz curve\n`);
console.log("skill      v1 E[mult]   v2 E[mult]   delta      v1 edge   v2 edge");
console.log("─".repeat(70));

for (const skill of ["casual", "decent", "skilled"] as Skill[]) {
  const a = expectedMult(1, skill);
  const b = expectedMult(2, skill);
  console.log(
    `${skill.padEnd(10)} ${a.toFixed(4).padStart(9)}   ${b.toFixed(4).padStart(10)}   ` +
      `${(b - a >= 0 ? "+" : "") + (b - a).toFixed(4)}   ` +
      `${((1 - a) * 100).toFixed(1).padStart(7)}%  ${((1 - b) * 100).toFixed(1).padStart(7)}%`
  );
}
console.log(
  "\nE[mult] is the player's expected return per unit staked. The house edge is 1 − E[mult].\n" +
    "v2 must land on v1 for the money economy to be unchanged.\n"
);
