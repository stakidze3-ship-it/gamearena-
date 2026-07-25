/**
 * Deterministic PRNG shared by client (render) and server (validation).
 * Identical output for a given seed on every platform — this is what makes
 * a match "provably fair": both players derive the same piece sequence, and
 * the server can replay any run to recompute the exact score.
 *
 * xmur3 seeds mulberry32. No floats-of-doom: integer state, [0,1) output.
 */

/** Hash an arbitrary seed string to a uint32 for the PRNG. */
export function hashSeedToInt(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export class Rng {
  private s: number;

  constructor(seed: string | number) {
    this.s = typeof seed === "number" ? seed >>> 0 : hashSeedToInt(seed);
  }

  /** Next float in [0, 1). */
  next(): number {
    this.s |= 0;
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Next integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}
