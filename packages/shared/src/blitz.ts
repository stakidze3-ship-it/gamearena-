/**
 * Blitz payout curve: piecewise-linear multiplier over score.
 * Points are [{ score, multBps }] sorted ascending; 10000 bps = 1.0x.
 * Below the first point → 0. Above the last → clamped at maxMultBps.
 * Curves live in the DB (BlitzConfig) — admin-adjustable, never hardcoded.
 */

export interface CurvePoint {
  score: number;
  multBps: number;
}

export function multiplierBpsForScore(curve: CurvePoint[], score: number, maxMultBps: number): number {
  if (curve.length === 0) return 0;
  const pts = [...curve].sort((a, b) => a.score - b.score);
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (score < first.score) return 0;
  if (score >= last.score) return Math.min(last.multBps, maxMultBps);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if (score >= a.score && score < b.score) {
      const t = (score - a.score) / (b.score - a.score);
      const bps = Math.round(a.multBps + t * (b.multBps - a.multBps));
      return Math.min(bps, maxMultBps);
    }
  }
  return Math.min(last.multBps, maxMultBps);
}

/** Payout in tetri, rounded down to the tetri (documented in the payout table UI). */
export function blitzPayoutTetri(
  entryTetri: number,
  curve: CurvePoint[],
  score: number,
  maxMultBps: number
): { multBps: number; payoutTetri: number } {
  const multBps = multiplierBpsForScore(curve, score, maxMultBps);
  return { multBps, payoutTetri: Math.floor((entryTetri * multBps) / 10_000) };
}

/** Default launch curve: 400→0x, 800→1.0x (break-even), 1200→1.5x, 1600→2.5x. */
export const DEFAULT_BLITZ_CURVE: CurvePoint[] = [
  { score: 400, multBps: 0 },
  { score: 800, multBps: 10_000 },
  { score: 1200, multBps: 15_000 },
  { score: 1600, multBps: 25_000 },
];
