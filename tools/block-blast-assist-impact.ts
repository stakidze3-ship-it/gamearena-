/**
 * What the placement assist costs the house.
 *
 * The engine harnesses measure perfect placement, so they cannot see this: the
 * assist only ever helps a player who MIS-AIMS. Widening it converts failed
 * drops into placements, and placement count is the largest single lever on the
 * Blitz margin — more pieces down in 60 seconds means more cleared lines and a
 * higher score, without any rule changing.
 *
 * This models a player whose finger lands with gaussian error around the cell
 * they meant, replays the same intentions at each assist radius, and reports
 * both the drop success rate and the resulting expected payout.
 *
 *   npx tsx tools/block-blast-assist-impact.ts [runs]
 */
import { BlockBlastEngine, GRID, type Shape } from "@gamearena/games";
import { DEFAULT_BLITZ_CURVE, multiplierBpsForScore } from "@gamearena/shared";
import { cellPitch, resolvePlacement, snapOrigin, type BoardGeometry } from "../apps/web/src/lib/block-blast-placement";

const RUNS = Number(process.argv[2] ?? 300);
const GEO: BoardGeometry = { left: 0, top: 0, width: 440, pad: 8, gap: 4 };
const PITCH = cellPitch(GEO);
const MAX_MULT_BPS = 25_000;

/** Aim error in cells (1 sigma). 0.35 ≈ a third of a cell — a normal thumb. */
const AIM_SIGMA_CELLS = Number(process.env.SIGMA ?? 0.35);

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Box–Muller, so the error is gaussian rather than uniform. */
function gauss(rand: () => number): number {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Viewport point at the centre of the footprint a piece would occupy. */
function centreOf(shape: { w: number; h: number }, r: number, c: number) {
  return {
    px: GEO.left + GEO.pad + (c + shape.w / 2) * PITCH,
    py: GEO.top + GEO.pad + (r + shape.h / 2) * PITCH,
  };
}

/** Pick the placement the player INTENDS: greedy on lines, as a human would. */
function intend(eng: BlockBlastEngine, grid: boolean[], hand: (Shape | null)[]) {
  let best: { s: number; r: number; c: number; lines: number } | null = null;
  for (let s = 0; s < 3; s++) {
    const shape = hand[s];
    if (!shape) continue;
    for (let r = 0; r <= GRID - shape.h; r++) {
      for (let c = 0; c <= GRID - shape.w; c++) {
        if (!eng.previewFits(s, r, c)) continue;
        const g = grid.slice();
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
  return best;
}

/**
 * Play one run with a shaky finger.
 *
 * `assistRadius` is applied by monkey-patching the module constant is not
 * possible, so instead the caller passes a resolver that mimics the radius —
 * see `resolveWith`.
 */
function playWithAim(
  seed: string,
  rand: () => number,
  resolve: (shape: Shape, aim: ReturnType<typeof snapOrigin>, fits: (r: number, c: number) => boolean) => { r: number; c: number; valid: boolean } | null,
  maxAttempts = 44
) {
  const eng = new BlockBlastEngine(seed);
  let landed = 0;
  let missed = 0;

  for (let m = 0; m < maxAttempts && !eng.isOver(); m++) {
    const st = eng.getState();
    const want = intend(eng, st.grid, st.hand);
    if (!want) break;
    const shape = st.hand[want.s]!;

    // The finger lands near the intended footprint centre, not exactly on it.
    const centre = centreOf(shape, want.r, want.c);
    const px = centre.px + gauss(rand) * AIM_SIGMA_CELLS * PITCH;
    const py = centre.py + gauss(rand) * AIM_SIGMA_CELLS * PITCH;

    const aim = snapOrigin(shape, px, py, GEO, 0);
    const placement = aim ? resolve(shape, aim, (r, c) => eng.previewFits(want.s, r, c)) : null;
    if (!placement?.valid) { missed++; continue; }
    if (!eng.applyInput({ t: 0, s: want.s, r: placement.r, c: placement.c })) { missed++; continue; }
    landed++;
  }
  return { score: eng.getScore(), landed, missed };
}

/** Reproduce resolvePlacement at an arbitrary radius. */
function resolveWith(radius: number) {
  return (
    shape: Shape,
    aim: ReturnType<typeof snapOrigin>,
    fits: (r: number, c: number) => boolean
  ) => {
    if (!aim) return null;
    if (radius === 0) return fits(aim.r, aim.c) ? { r: aim.r, c: aim.c, valid: true } : { r: aim.r, c: aim.c, valid: false };
    if (radius === 2) return resolvePlacement(shape, aim, fits); // the shipped path
    if (fits(aim.r, aim.c)) return { r: aim.r, c: aim.c, valid: true };
    let best: { r: number; c: number; d: number } | null = null;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = aim.r + dr, c = aim.c + dc;
        if (r < 0 || c < 0 || r > GRID - shape.h || c > GRID - shape.w) continue;
        if (!fits(r, c)) continue;
        const d = (r - aim.rawR) ** 2 + (c - aim.rawC) ** 2;
        if (!best || d < best.d) best = { r, c, d };
      }
    }
    return best ? { r: best.r, c: best.c, valid: true } : { r: aim.r, c: aim.c, valid: false };
  };
}

console.log(`\nPLACEMENT ASSIST IMPACT · ${RUNS} runs · aim error σ=${AIM_SIGMA_CELLS} cells\n`);
console.log("radius   median score   drops landed   drop success   E[mult]   house edge");
console.log("─".repeat(78));

for (const radius of [0, 1, 2]) {
  const rand = mulberry32(0xc0ffee);
  const resolve = resolveWith(radius);
  const rows = Array.from({ length: RUNS }, (_, i) => playWithAim(`assist-${i}`, rand, resolve));
  const scores = rows.map((r) => r.score).sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)]!;
  const landed = rows.reduce((n, r) => n + r.landed, 0);
  const attempts = landed + rows.reduce((n, r) => n + r.missed, 0);
  const eMult =
    rows.reduce((n, r) => n + multiplierBpsForScore(DEFAULT_BLITZ_CURVE, r.score, MAX_MULT_BPS), 0) /
    rows.length /
    10_000;
  console.log(
    `${String(radius).padStart(4)}     ${String(median).padStart(11)}   ${String(Math.round(landed / RUNS)).padStart(12)}   ` +
      `${((landed / attempts) * 100).toFixed(1).padStart(11)}%   ${eMult.toFixed(4).padStart(7)}   ${((1 - eMult) * 100).toFixed(1).padStart(9)}%`
  );
}
console.log("\nradius 0 = no assist · radius 2 = what now ships\n");
