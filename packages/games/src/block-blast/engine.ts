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

/**
 * Scoring rule sets, kept side by side so a stored input log always re-scores
 * to the number it was actually paid on.
 *
 * The server persists the version a match or Blitz run was created under, and
 * simulate() resolves it back. Without this, changing scoring would silently
 * re-score every historical replay — the viewer re-simulates from the seed on
 * every load — and make settled runs look wrong after the fact.
 *
 * NEVER edit an existing version. Add a new one.
 */
export const BLOCK_BLAST_RULES_V1 = 1;
export const BLOCK_BLAST_RULES_V2 = 2;
export const BLOCK_BLAST_RULES_LATEST = BLOCK_BLAST_RULES_V2;
export type BlockBlastRulesVersion = 1 | 2;

interface Rules {
  /** Points per cleared line, scaled by lines² for simultaneous clears. */
  clearUnit: number;
  /**
   * Non-clearing placements a streak survives. v1 broke the streak on the
   * first one, which on an 8x8 with three-piece hands made combos almost
   * unreachable — measured peak combo averaged under 2, so the multiplier
   * essentially never engaged. Allowing a couple of dry placements is what
   * lets a streak actually run across a hand.
   */
  dryTolerance: number;
  /** Multiplier at streak k is 1 + comboStep × (k − 1), capped at comboMax. */
  comboStep: number;
  comboMax: number;
}

const RULES: Record<BlockBlastRulesVersion, Rules> = {
  // Frozen. This is what every match played before the feel pass was scored on.
  [BLOCK_BLAST_RULES_V1]: { clearUnit: 16, dryTolerance: 0, comboStep: 1, comboMax: Infinity },
  // clearUnit re-tuned so the score distribution — and therefore the Blitz
  // house edge — is unchanged from v1. See tools/block-blast-distribution.ts.
  [BLOCK_BLAST_RULES_V2]: { clearUnit: 9.5, dryTolerance: 2, comboStep: 0.5, comboMax: 6 },
};

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
  /** score multiplier the NEXT clear would earn at this streak */
  comboMult: number;
  /** dry placements left before the streak breaks (0 = next dud ends it) */
  comboLives: number;
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
  /** Consecutive non-clearing placements since the last clear. */
  private dry = 0;
  private readonly rules: Rules;

  constructor(seed: string, rulesVersion: BlockBlastRulesVersion = BLOCK_BLAST_RULES_LATEST) {
    this.rng = new Rng(`block-blast:${seed}`);
    this.rules = RULES[rulesVersion] ?? RULES[BLOCK_BLAST_RULES_LATEST];
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

    // Combo streak. Clearing n lines at streak k scores
    //   clearUnit × n² × (1 + comboStep × (k − 1))   capped at comboMax
    // so simultaneous clears stay the big play while a sustained streak pays a
    // steady, bounded bonus on top. A placement that clears nothing does not
    // end the streak immediately — it burns one of `dryTolerance` lives, which
    // is what makes a streak survivable across a three-piece hand.
    if (this.lastClearLines > 0) {
      this.combo += 1;
      this.dry = 0;
      this.score += Math.round(
        this.rules.clearUnit * this.lastClearLines * this.lastClearLines * this.multiplierAt(this.combo)
      );
    } else if (this.combo > 0) {
      this.dry += 1;
      if (this.dry > this.rules.dryTolerance) {
        this.combo = 0;
        this.dry = 0;
      }
    }

    if (this.hand.every((h) => h === null)) this.drawHand();
    if (!this.canPlaceAny()) this.over = true;
    return true;
  }

  /** Combo multiplier at streak k (k = 1 is the first clear, so 1.0x). */
  private multiplierAt(k: number): number {
    if (k < 1) return 1;
    return Math.min(this.rules.comboMax, 1 + this.rules.comboStep * (k - 1));
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
      comboMult: this.multiplierAt(this.combo + 1),
      comboLives: this.combo > 0 ? Math.max(0, this.rules.dryTolerance - this.dry) : 0,
    };
  }

  /** Read-only fit check for the client's ghost preview (no state change). */
  previewFits(slot: number, r: number, c: number): boolean {
    if (this.over) return false;
    const shape = this.hand[slot];
    return shape ? this.fits(shape, r, c) : false;
  }
}
