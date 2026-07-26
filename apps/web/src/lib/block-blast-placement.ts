/**
 * Placement maths for the Block Blast board — pure, so it can be tested
 * exhaustively without a browser.
 *
 * Two jobs:
 *   snapOrigin      — turn a pointer position into the cell the player is aiming at
 *   resolvePlacement — turn that aim into the placement that will actually happen
 *
 * Neither can invent an illegal move: resolvePlacement only ever returns an
 * origin that `fits` already accepts, and the board draws the ghost from the
 * resolved origin, so the player always sees the exact square before releasing.
 */

import { GRID } from "@gamearena/games";

export interface Aim {
  /** Snapped, clamped origin — the cell the piece would occupy. */
  r: number;
  c: number;
  /** Un-rounded origin, kept so the assist can rank candidates by true distance. */
  rawR: number;
  rawC: number;
}

export interface Placement {
  r: number;
  c: number;
  valid: boolean;
  /** True when the assist moved the piece off the exact aimed cell. */
  assisted: boolean;
}

export interface BoardGeometry {
  /** Board bounding box in viewport coordinates. */
  left: number;
  top: number;
  width: number;
  /** Inner padding (Tailwind p-2 = 8) and inter-cell gap (gap-1 = 4). */
  pad: number;
  gap: number;
}

/**
 * How far outside the board a piece may hang and still snap back on. Without
 * it, edge placements demand pixel accuracy; with more, the piece teleports
 * away from where the player is actually pointing.
 */
export const EDGE_TOLERANCE = 1.4;

/**
 * Placement assist radius, in cells. When the aimed origin is blocked, the
 * nearest legal origin within this radius is used instead.
 *
 * Two cells rather than one, so a rough drop into a crowded board still finds
 * the gap the player was going for. The search is ranked by true distance from
 * the un-rounded aim, so a legal cell right under the finger always beats a
 * further one — widening the radius makes MORE drops succeed, it does not make
 * them land further from where you pointed.
 */
export const ASSIST_RADIUS = 2;

export function cellPitch(geo: BoardGeometry): number {
  return (geo.width - 2 * geo.pad + geo.gap) / GRID;
}

/**
 * Snap a pointer position to a piece origin.
 *
 * The piece is centred on the pointer in continuous cell space and rounded
 * once. Flooring the pointer's cell and then subtracting floor(h/2) — the
 * previous approach — biases even-sized pieces half a cell up-and-left, so a
 * 2x2 dragged to the exact centre of a cell resolved one cell off. Rounding a
 * centred value is symmetric for both parities.
 *
 * Returns null when the pointer is clearly off the board.
 */
export function snapOrigin(
  shape: { w: number; h: number },
  px: number,
  py: number,
  geo: BoardGeometry,
  lift: number
): Aim | null {
  const pitch = cellPitch(geo);
  const sx = px - geo.left - geo.pad;
  const sy = py - lift - geo.top - geo.pad;
  const height = geo.width; // the board is square

  // Bail out well clear of the board so flinging a piece away always cancels.
  if (sx < -pitch * 2 || sx > geo.width + pitch) return null;
  if (sy < -pitch * 3 || sy > height + pitch * 2) return null;

  const cx = sx / pitch - 0.5; // continuous cell coordinate of the pointer
  const cy = sy / pitch - 0.5;
  const rawR = cy - (shape.h - 1) / 2;
  const rawC = cx - (shape.w - 1) / 2;
  const r = Math.round(rawR);
  const c = Math.round(rawC);
  const maxR = GRID - shape.h;
  const maxC = GRID - shape.w;

  // Snap back on only from just outside; further out is a genuine miss.
  if (r < -EDGE_TOLERANCE || r > maxR + EDGE_TOLERANCE) return null;
  if (c < -EDGE_TOLERANCE || c > maxC + EDGE_TOLERANCE) return null;

  return { r: clamp(r, 0, maxR), c: clamp(c, 0, maxC), rawR, rawC };
}

/**
 * Resolve an aim to the placement that will actually be made.
 *
 * If the aimed origin fits, that is the answer. Otherwise the nearest legal
 * origin within ASSIST_RADIUS wins, ranked against the un-rounded aim so the
 * choice matches where the pointer really is. Ties break towards the smaller
 * (row, col) so the result is deterministic.
 */
export function resolvePlacement(
  shape: { w: number; h: number },
  aim: Aim,
  fits: (r: number, c: number) => boolean
): Placement {
  if (fits(aim.r, aim.c)) return { r: aim.r, c: aim.c, valid: true, assisted: false };

  let best: { r: number; c: number; d: number } | null = null;
  for (let dr = -ASSIST_RADIUS; dr <= ASSIST_RADIUS; dr++) {
    for (let dc = -ASSIST_RADIUS; dc <= ASSIST_RADIUS; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = aim.r + dr;
      const c = aim.c + dc;
      if (r < 0 || c < 0 || r > GRID - shape.h || c > GRID - shape.w) continue;
      if (!fits(r, c)) continue;
      // Distance from where the pointer really is, not from the rounded cell,
      // so the nearest legal square to the finger always wins.
      const d = (r - aim.rawR) ** 2 + (c - aim.rawC) ** 2;
      if (!best || d < best.d) best = { r, c, d };
    }
  }
  return best
    ? { r: best.r, c: best.c, valid: true, assisted: true }
    : { r: aim.r, c: aim.c, valid: false, assisted: false };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
