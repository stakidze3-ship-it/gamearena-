/**
 * Block Blast piece set — polyominoes normalized to a (0,0) top-left origin.
 * Weighted so small/medium pieces are common and the big ones (3x3, 5-lines)
 * stay rare, which keeps an 8x8 board playable instead of jamming instantly.
 */

export type Cell = readonly [number, number]; // [row, col]

export interface Shape {
  readonly id: number;
  readonly cells: readonly Cell[];
  readonly w: number;
  readonly h: number;
  readonly size: number;
  readonly weight: number;
}

const RAW: { cells: Cell[]; weight: number }[] = [
  // ── dot ──
  { cells: [[0, 0]], weight: 3 },

  // ── lines ──
  { cells: [[0, 0], [0, 1]], weight: 5 },
  { cells: [[0, 0], [1, 0]], weight: 5 },
  { cells: [[0, 0], [0, 1], [0, 2]], weight: 5 },
  { cells: [[0, 0], [1, 0], [2, 0]], weight: 5 },
  { cells: [[0, 0], [0, 1], [0, 2], [0, 3]], weight: 3 },
  { cells: [[0, 0], [1, 0], [2, 0], [3, 0]], weight: 3 },
  { cells: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]], weight: 2 },
  { cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]], weight: 2 },

  // ── squares & rectangles ──
  { cells: [[0, 0], [0, 1], [1, 0], [1, 1]], weight: 4 },
  { cells: [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]], weight: 2 },
  { cells: [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1]], weight: 2 },
  {
    cells: [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]],
    weight: 1,
  },

  // ── small L (tromino corner) × 4 ──
  { cells: [[0, 0], [1, 0], [1, 1]], weight: 4 },
  { cells: [[0, 1], [1, 0], [1, 1]], weight: 4 },
  { cells: [[0, 0], [0, 1], [1, 0]], weight: 4 },
  { cells: [[0, 0], [0, 1], [1, 1]], weight: 4 },

  // ── big L (3x3 corner, 5 cells) × 4 ──
  { cells: [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]], weight: 2 },
  { cells: [[0, 0], [0, 1], [0, 2], [1, 0], [2, 0]], weight: 2 },
  { cells: [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]], weight: 2 },
  { cells: [[0, 2], [1, 2], [2, 0], [2, 1], [2, 2]], weight: 2 },

  // ── S / Z ──
  { cells: [[0, 1], [0, 2], [1, 0], [1, 1]], weight: 2 },
  { cells: [[0, 0], [0, 1], [1, 1], [1, 2]], weight: 2 },
  { cells: [[0, 0], [1, 0], [1, 1], [2, 1]], weight: 2 },
  { cells: [[0, 1], [1, 0], [1, 1], [2, 0]], weight: 2 },

  // ── T × 4 ──
  { cells: [[0, 0], [0, 1], [0, 2], [1, 1]], weight: 2 },
  { cells: [[0, 1], [1, 0], [1, 1], [2, 1]], weight: 2 },
  { cells: [[0, 1], [1, 0], [1, 1], [1, 2]], weight: 2 },
  { cells: [[0, 0], [1, 0], [1, 1], [2, 0]], weight: 2 },
];

function build(entry: { cells: Cell[]; weight: number }, id: number): Shape {
  let w = 0;
  let h = 0;
  for (const [r, c] of entry.cells) {
    if (r + 1 > h) h = r + 1;
    if (c + 1 > w) w = c + 1;
  }
  return { id, cells: entry.cells, w, h, size: entry.cells.length, weight: entry.weight };
}

export const SHAPES: readonly Shape[] = RAW.map(build);

export const SHAPE_WEIGHT_TOTAL = SHAPES.reduce((s, x) => s + x.weight, 0);
