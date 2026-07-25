/**
 * Block Blast — deterministic 8x8 engine.
 *
 * Rules: three pieces per hand, drawn from the seed's RNG. Place a piece on
 * empty cells; any fully-filled row or column clears. Score:
 *   +1 per cell placed
 *   +GRID_CLEAR_UNIT × n²  when n lines clear at once (combo-rewarding)
 * A new hand is drawn once all three pieces are used. The game is "over" when
 * no piece in the current hand can be placed anywhere (stuck board). Timed
 * mode (60s) is enforced by the harness via input timestamps, not here.
 *
 * Pure and deterministic: identical score on client and server for the same
 * (seed, inputs). No wall-clock, no Math.random.
 */

import { Rng } from "../rng";
import type { GameEngine, GameInput } from "../sdk";
import { SHAPES, SHAPE_WEIGHT_TOTAL, type Shape } from "./pieces";

export const GRID = 8;
const HAND = 3;
// Tuned against the full piece set + combo streak so a strong 60s run lands
// near the ~800 Blitz break-even (keeps the published payout curve honest).
const CLEAR_UNIT = 16;

export interface BlockBlastInput extends GameInput {
  s: number; // hand slot 0..2
  r: number; // anchor row (piece top-left)
  c: number; // anchor col
}

export interface BlockBlastState {
  grid: boolean[]; // GRID*GRID, row-major
  hand: (Shape | null)[]; // length 3, null = already placed
  score: number;
  handNo: number;
  over: boolean;
  /** cells cleared by the most recent placement (for the clear animation) */
  lastCleared: number[];
  lastClearLines: number;
  /** current combo streak — consecutive placements that cleared ≥1 line */
  combo: number;
}

export class BlockBlastEngine implements GameEngine<BlockBlastState, BlockBlastInput> {
  private grid: boolean[] = new Array(GRID * GRID).fill(false);
  private hand: (Shape | null)[] = [];
  private readonly rng: Rng;
  private score = 0;
  private handNo = 0;
  private over = false;
  private lastCleared: number[] = [];
  private lastClearLines = 0;
  private combo = 0;

  constructor(seed: string) {
    this.rng = new Rng(`block-blast:${seed}`);
    this.drawHand();
  }

  /** Weighted draw — small pieces common, 3x3 / 5-lines rare. Deterministic. */
  private pickShape(): Shape {
    let roll = this.rng.int(SHAPE_WEIGHT_TOTAL);
    for (const shape of SHAPES) {
      roll -= shape.weight;
      if (roll < 0) return shape;
    }
    return SHAPES[0]!;
  }

  private drawHand(): void {
    this.hand = Array.from({ length: HAND }, () => this.pickShape());
    this.handNo++;
  }

  private fits(shape: Shape, r: number, c: number): boolean {
    for (const [dr, dc] of shape.cells) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= GRID || cc >= GRID) return false;
      if (this.grid[rr * GRID + cc]) return false;
    }
    return true;
  }

  private canPlaceAny(): boolean {
    for (const shape of this.hand) {
      if (!shape) continue;
      for (let r = 0; r <= GRID - shape.h; r++) {
        for (let c = 0; c <= GRID - shape.w; c++) {
          if (this.fits(shape, r, c)) return true;
        }
      }
    }
    return false;
  }

  private clearLines(): void {
    const fullRows: number[] = [];
    const fullCols: number[] = [];
    for (let i = 0; i < GRID; i++) {
      let rowFull = true;
      let colFull = true;
      for (let j = 0; j < GRID; j++) {
        if (!this.grid[i * GRID + j]) rowFull = false;
        if (!this.grid[j * GRID + i]) colFull = false;
      }
      if (rowFull) fullRows.push(i);
      if (colFull) fullCols.push(i);
    }

    const n = fullRows.length + fullCols.length;
    this.lastCleared = [];
    this.lastClearLines = n;
    if (n === 0) return;

    const toClear = new Set<number>();
    for (const r of fullRows) for (let j = 0; j < GRID; j++) toClear.add(r * GRID + j);
    for (const c of fullCols) for (let i = 0; i < GRID; i++) toClear.add(i * GRID + c);
    for (const idx of toClear) this.grid[idx] = false;

    this.lastCleared = [...toClear];
    // Scoring (incl. the combo streak) is applied by applyInput.
  }

  applyInput(input: BlockBlastInput): boolean {
    if (this.over) return false;
    const { s, r, c } = input;
    if (s < 0 || s >= HAND) return false;
    const shape = this.hand[s];
    if (!shape) return false;
    if (!this.fits(shape, r, c)) return false;

    for (const [dr, dc] of shape.cells) {
      this.grid[(r + dr) * GRID + (c + dc)] = true;
    }
    this.score += shape.size;
    this.hand[s] = null;

    this.clearLines();

    // Combo streak: consecutive clearing placements escalate the payout.
    // Clear n lines while on a combo of k → CLEAR_UNIT × n² × k. A placement
    // that clears nothing breaks the streak.
    if (this.lastClearLines > 0) {
      this.combo += 1;
      this.score += CLEAR_UNIT * this.lastClearLines * this.lastClearLines * this.combo;
    } else {
      this.combo = 0;
    }

    if (this.hand.every((h) => h === null)) this.drawHand();
    if (!this.canPlaceAny()) this.over = true;
    return true;
  }

  getScore(): number {
    return this.score;
  }

  isOver(): boolean {
    return this.over;
  }

  getState(): BlockBlastState {
    return {
      grid: [...this.grid],
      hand: [...this.hand],
      score: this.score,
      handNo: this.handNo,
      over: this.over,
      lastCleared: [...this.lastCleared],
      lastClearLines: this.lastClearLines,
      combo: this.combo,
    };
  }

  /** Read-only fit check for the client's ghost preview (no state change). */
  previewFits(slot: number, r: number, c: number): boolean {
    if (this.over) return false;
    const shape = this.hand[slot];
    return shape ? this.fits(shape, r, c) : false;
  }
}
