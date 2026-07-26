/**
 * Exhaustive tests for the Block Blast placement maths.
 *
 * The important property is "what you aim at is what you get": dropping a piece
 * with the pointer at the visual centre of a target footprint must resolve to
 * that exact footprint, for every shape in the set and every legal position.
 * The old floor-then-offset snapping failed this for even-sized pieces.
 *
 *   npx tsx tools/block-blast-placement-test.ts
 */
import { GRID, SHAPES } from "@gamearena/games";
import {
  ASSIST_RADIUS,
  cellPitch,
  resolvePlacement,
  snapOrigin,
  type BoardGeometry,
} from "../apps/web/src/lib/block-blast-placement";

const GEO: BoardGeometry = { left: 100, top: 200, width: 440, pad: 8, gap: 4 };
const PITCH = cellPitch(GEO);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Viewport point at the visual centre of the footprint a piece would occupy. */
function centreOf(shape: { w: number; h: number }, r: number, c: number) {
  return {
    px: GEO.left + GEO.pad + (c + shape.w / 2) * PITCH,
    py: GEO.top + GEO.pad + (r + shape.h / 2) * PITCH,
  };
}

// ── 1. Aiming at a footprint's centre resolves to that footprint ──
console.log("\n1. every shape, every legal origin, pointer at the footprint centre");
let cases = 0;
for (const shape of SHAPES) {
  for (let r = 0; r <= GRID - shape.h; r++) {
    for (let c = 0; c <= GRID - shape.w; c++) {
      const { px, py } = centreOf(shape, r, c);
      const aim = snapOrigin(shape, px, py, GEO, 0);
      cases++;
      check(
        `${shape.w}x${shape.h} @ ${r},${c}`,
        aim !== null && aim.r === r && aim.c === c,
        aim ? `got ${aim.r},${aim.c}` : "null"
      );
    }
  }
}
console.log(`   ${cases} cases`);

// ── 2. The capture zone is centred on the footprint, not offset from it ──
//
// This is the real regression. Both the old and new snapping agree when the
// pointer is at the EXACT centre of a footprint, so a centre-only test proves
// nothing. What was wrong was the zone around that centre: flooring the pointer
// cell and subtracting floor(size/2) puts the whole capture zone to the right of
// and below the footprint centre, so aiming a hair left of centre silently
// dropped the piece a column early.
console.log("\n2. capture zone is centred (the actual old bias)");
{
  /** The previous implementation, kept here purely to prove the difference. */
  const legacy = (shape: { w: number; h: number }, px: number, py: number) => {
    const sx = px - GEO.left - GEO.pad;
    const sy = py - GEO.top - GEO.pad;
    const r = Math.max(0, Math.min(GRID - shape.h, Math.floor(sy / PITCH) - Math.floor(shape.h / 2)));
    const c = Math.max(0, Math.min(GRID - shape.w, Math.floor(sx / PITCH) - Math.floor(shape.w / 2)));
    return { r, c };
  };

  let legacyWrong = 0;
  let currentWrong = 0;
  let probes = 0;
  // Probe a ring of offsets around each footprint centre, all well within
  // half a cell — every one of these should land on the aimed footprint.
  const offsets = [-0.4, -0.2, 0, 0.2, 0.4];
  for (const shape of SHAPES) {
    for (let r = 0; r <= GRID - shape.h; r++) {
      for (let c = 0; c <= GRID - shape.w; c++) {
        const centre = centreOf(shape, r, c);
        for (const ox of offsets) {
          for (const oy of offsets) {
            const px = centre.px + ox * PITCH;
            const py = centre.py + oy * PITCH;
            probes++;
            const now = snapOrigin(shape, px, py, GEO, 0);
            if (!now || now.r !== r || now.c !== c) currentWrong++;
            const old = legacy(shape, px, py);
            if (old.r !== r || old.c !== c) legacyWrong++;
          }
        }
      }
    }
  }
  console.log(`   ${probes} sub-cell probes: old missed ${legacyWrong}, current missed ${currentWrong}`);
  check("the old snapping really was biased", legacyWrong > 0, "no difference found — claim unproven");
  check("current snapping honours every near-centre aim", currentWrong === 0, `${currentWrong} missed`);
}

// ── 3. Half-cell nudges either side of a boundary round the sensible way ──
console.log("\n3. sub-cell precision");
{
  const s = SHAPES.find((x) => x.w === 1 && x.h === 1)!;
  const base = centreOf(s, 4, 4);
  const justLeft = snapOrigin(s, base.px - PITCH * 0.45, base.py, GEO, 0);
  const justRight = snapOrigin(s, base.px + PITCH * 0.45, base.py, GEO, 0);
  const wellLeft = snapOrigin(s, base.px - PITCH * 0.75, base.py, GEO, 0);
  check("0.45 cell left still targets the same cell", justLeft?.c === 4, `got ${justLeft?.c}`);
  check("0.45 cell right still targets the same cell", justRight?.c === 4, `got ${justRight?.c}`);
  check("0.75 cell left moves one cell over", wellLeft?.c === 3, `got ${wellLeft?.c}`);
}

// ── 4. Edge tolerance: hanging just off the board still snaps on ──
console.log("\n4. edge tolerance");
{
  const s = SHAPES.find((x) => x.w === 1 && x.h === 1)!;
  const topLeft = centreOf(s, 0, 0);
  const slightlyOff = snapOrigin(s, topLeft.px - PITCH * 0.9, topLeft.py - PITCH * 0.9, GEO, 0);
  check("just off the top-left corner snaps to 0,0", slightlyOff?.r === 0 && slightlyOff?.c === 0,
    slightlyOff ? `got ${slightlyOff.r},${slightlyOff.c}` : "null");
  const wayOff = snapOrigin(s, topLeft.px - PITCH * 4, topLeft.py, GEO, 0);
  check("far off the board is a miss (null)", wayOff === null, `got ${JSON.stringify(wayOff)}`);
}

// ── 5. Assist only ever returns legal placements ──
console.log("\n5. assist integrity — never returns an illegal placement");
{
  // A board with a scattered pattern of occupied cells.
  const occupied = new Set<number>();
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 26; i++) occupied.add(Math.floor(rand() * GRID * GRID));

  const fitsFor = (shape: { w: number; h: number; cells: readonly (readonly [number, number])[] }) =>
    (r: number, c: number) => {
      if (r < 0 || c < 0 || r > GRID - shape.h || c > GRID - shape.w) return false;
      return shape.cells.every(([dr, dc]) => !occupied.has((r + dr) * GRID + (c + dc)));
    };

  let assisted = 0;
  let illegal = 0;
  let checked = 0;
  for (const shape of SHAPES) {
    const fits = fitsFor(shape);
    for (let r = 0; r <= GRID - shape.h; r++) {
      for (let c = 0; c <= GRID - shape.w; c++) {
        const { px, py } = centreOf(shape, r, c);
        const aim = snapOrigin(shape, px, py, GEO, 0);
        if (!aim) continue;
        const p = resolvePlacement(shape, aim, fits);
        checked++;
        if (p.valid && !fits(p.r, p.c)) illegal++;
        if (p.assisted) {
          assisted++;
          const dr = Math.abs(p.r - aim.r);
          const dc = Math.abs(p.c - aim.c);
          if (dr > ASSIST_RADIUS || dc > ASSIST_RADIUS) illegal++;
        }
      }
    }
  }
  check("no illegal or out-of-radius placement", illegal === 0, `${illegal} bad of ${checked}`);
  console.log(`   ${checked} placements, ${assisted} rescued by the assist (${((assisted / checked) * 100).toFixed(1)}%)`);
}

// ── 6. Assist never fires when the aimed cell is already legal ──
console.log("\n6. assist does not override a legal aim");
{
  const emptyFits = (shape: { w: number; h: number }) => (r: number, c: number) =>
    r >= 0 && c >= 0 && r <= GRID - shape.h && c <= GRID - shape.w;
  let overridden = 0;
  for (const shape of SHAPES) {
    for (let r = 0; r <= GRID - shape.h; r++) {
      for (let c = 0; c <= GRID - shape.w; c++) {
        const { px, py } = centreOf(shape, r, c);
        const aim = snapOrigin(shape, px, py, GEO, 0);
        if (!aim) continue;
        const p = resolvePlacement(shape, aim, emptyFits(shape));
        if (p.assisted || p.r !== r || p.c !== c) overridden++;
      }
    }
  }
  check("empty board: aim is always honoured exactly", overridden === 0, `${overridden} overridden`);
}

// ── 7. Touch lift shifts the aim upward by exactly the lift ──
console.log("\n7. touch lift");
{
  const s = SHAPES.find((x) => x.w === 1 && x.h === 1)!;
  const target = centreOf(s, 5, 5);
  const lift = PITCH * 0.9;
  const withLift = snapOrigin(s, target.px, target.py + lift, GEO, lift);
  check("finger below the target still aims at it", withLift?.r === 5 && withLift?.c === 5,
    withLift ? `got ${withLift.r},${withLift.c}` : "null");
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
