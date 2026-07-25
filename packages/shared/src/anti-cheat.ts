/**
 * Input-timing analysis — a cheap first-pass signal over a match/run input log.
 * Server-side score computation is the real defence; this flags *how* the
 * inputs arrived. Two tells:
 *   - inhuman speed: many placements faster than a person can drag+drop
 *   - inhuman regularity: intervals near-constant (a metronome bot)
 * Flags feed the review queue; they never auto-punish.
 */

export interface TimingVerdict {
  flagged: boolean;
  reason?: "INPUT_SPEED" | "INPUT_REGULARITY";
  detail: {
    inputs: number;
    medianIntervalMs: number;
    fastFraction: number; // share of intervals under the human floor
    cv: number; // coefficient of variation of intervals
  };
}

const FAST_FLOOR_MS = 130; // below this, a placement is implausibly quick
const FAST_FRACTION_LIMIT = 0.6; // >60% of moves that fast → flag
const CV_FLOOR = 0.06; // intervals this uniform read as automated
const MIN_INPUTS = 10; // need a sample before judging

export function analyzeInputTiming(inputs: { t: number }[]): TimingVerdict {
  const ts = inputs.map((i) => i.t).sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < ts.length; i++) intervals.push(ts[i]! - ts[i - 1]!);

  const detail = { inputs: inputs.length, medianIntervalMs: 0, fastFraction: 0, cv: 0 };
  if (intervals.length < MIN_INPUTS) return { flagged: false, detail };

  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const mean = intervals.reduce((s, x) => s + x, 0) / intervals.length;
  const variance = intervals.reduce((s, x) => s + (x - mean) ** 2, 0) / intervals.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
  const fastFraction = intervals.filter((x) => x < FAST_FLOOR_MS).length / intervals.length;

  detail.medianIntervalMs = Math.round(median);
  detail.fastFraction = Number(fastFraction.toFixed(3));
  detail.cv = Number(cv.toFixed(3));

  if (fastFraction > FAST_FRACTION_LIMIT) return { flagged: true, reason: "INPUT_SPEED", detail };
  if (cv < CV_FLOOR) return { flagged: true, reason: "INPUT_REGULARITY", detail };
  return { flagged: false, detail };
}

/** Win-rate anomaly: implausibly high win rate over a meaningful sample. */
export const WINRATE_ANOMALY_RATE = 0.85;
export const WINRATE_ANOMALY_MIN = 30;

export function isWinRateAnomalous(wins: number, matches: number): boolean {
  return matches >= WINRATE_ANOMALY_MIN && wins / matches > WINRATE_ANOMALY_RATE;
}
