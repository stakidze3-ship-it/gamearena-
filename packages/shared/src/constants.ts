import { lariToTetri } from "./money";

/** Allowed 1v1 stakes, in tetri. */
export const STAKES_TETRI = [100, 500, 1000, 2500] as const;
export type StakeTetri = (typeof STAKES_TETRI)[number];

/**
 * Rake by stake, in basis points of the pot.
 * ₾1 → 15%, ₾5/₾10 → 12.5%, ₾25 → 10%.
 */
export const RAKE_BPS_BY_STAKE: Record<StakeTetri, number> = {
  100: 1500,
  500: 1250,
  1000: 1250,
  2500: 1000,
};

export function rakeBpsForStake(stakeTetri: number): number {
  const bps = RAKE_BPS_BY_STAKE[stakeTetri as StakeTetri];
  if (bps === undefined) throw new Error(`Invalid stake: ${stakeTetri}`);
  return bps;
}

/**
 * Split a pot into winner payout + rake. Rake rounds DOWN to the tetri
 * (platform never rounds in its own favor); winner gets the remainder,
 * so payout + rake === pot always holds exactly.
 */
export function settlePot(potTetri: number, rakeBps: number): { payoutTetri: number; rakeTetri: number } {
  const rakeTetri = Math.floor((potTetri * rakeBps) / 10_000);
  return { payoutTetri: potTetri - rakeTetri, rakeTetri };
}

/** Demo credit granted on signup: ₾100. */
export const SIGNUP_CREDIT_TETRI = lariToTetri(100);

/** Blitz entry options, in tetri. */
export const BLITZ_ENTRIES_TETRI = [100, 200, 500] as const;

/** Matchmaking */
export const MATCH_RATING_WINDOW = 150;
export const NEWCOMER_PROTECTED_MATCHES = 10;
export const MATCHMAKING_TIMEOUT_S = 30;

/** Loyalty tiers by weekly rake volume (tetri) → rakeback bps. */
export const LOYALTY_TIERS = [
  { key: "BRONZE", minWeeklyRakeTetri: 0, rakebackBps: 500 },
  { key: "SILVER", minWeeklyRakeTetri: lariToTetri(25), rakebackBps: 600 },
  { key: "GOLD", minWeeklyRakeTetri: lariToTetri(100), rakebackBps: 750 },
  { key: "PLATINUM", minWeeklyRakeTetri: lariToTetri(400), rakebackBps: 900 },
  { key: "DIAMOND", minWeeklyRakeTetri: lariToTetri(1500), rakebackBps: 1000 },
] as const;

/** Anti-cheat thresholds */
export const WINRATE_FLAG_THRESHOLD = 0.85;
export const WINRATE_FLAG_MIN_MATCHES = 30;

export const GAME_KEYS = ["block-blast", "bricks-breaker"] as const;
export type GameKey = (typeof GAME_KEYS)[number];

export const MATCH_DURATION_S: Record<GameKey, number> = {
  "block-blast": 60,
  "bricks-breaker": 90,
};
