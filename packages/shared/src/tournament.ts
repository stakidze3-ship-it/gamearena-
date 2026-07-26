/**
 * Production configuration for the flagship knockout event.
 *
 * One source of truth shared by the scheduler (which creates the event), the
 * web app (which displays and joins it) and the engine (which pays it out).
 *
 * The event is fill-triggered, not clock-triggered: registration stays open
 * until the field is exactly full, then a short countdown runs and the bracket
 * is drawn. A full field escrows 60 × ₾5 = ₾300, and the prize shares sum to
 * 10000 bps, so the pool pays out exactly ₾150 / ₾90 / ₾60 with zero rake.
 */

export interface PrizeShare {
  rank: number;
  shareBps: number;
}

export const KNOCKOUT_CONFIG = {
  name: "Block Blast Championship",
  /** Seats. 32 → an exact bracket: 32 → 16 → 8 → 4 → 2 → champion, no byes. */
  capacity: 32,
  /** ₾5 entry, in tetri. */
  entryTetri: 500,
  /** Lobby countdown between the field filling and the draw. */
  countdownS: 60,
  /** Ready check: play within this window each round or forfeit. */
  readyWindowS: 180,
  roundDurationS: 180,
  /** No guarantee: a full field funds the published prizes exactly. */
  guaranteeTetri: 0,
  // A full field is 32 × ₾5 = ₾160, and the three prizes consume all of it —
  // this event takes no rake by design.
  prizeStructure: [
    { rank: 1, shareBps: 5000 }, // ₾80
    { rank: 2, shareBps: 3125 }, // ₾50
    { rank: 3, shareBps: 1875 }, // ₾30
  ] as PrizeShare[],
};

/** Rounds needed to crown a champion from a full field (60 → 64 → 6). */
/** 32 seats → five rounds. Used only to size the event's overall window. */
export const KNOCKOUT_ROUNDS = 5;

/**
 * `startsAt` sentinel used while registration is open. The scheduler starts an
 * event when `startsAt <= now`, so parking the date far in the future keeps
 * registration open indefinitely; joining the last seat rewrites it to
 * `now + countdownS` and the existing start path takes over unchanged.
 */
export const AWAITING_PLAYERS_AT = new Date("2099-01-01T00:00:00.000Z");

/** True while the event is still waiting for its field to fill. */
export function isAwaitingPlayers(startsAt: Date): boolean {
  return startsAt.getTime() >= AWAITING_PLAYERS_AT.getTime();
}

/** Prize for a placing, given the settled pool. Mirrors the engine's maths. */
export function prizeTetriFor(
  rank: number,
  poolTetri: number,
  structure: PrizeShare[] = KNOCKOUT_CONFIG.prizeStructure
): number {
  const share = structure.find((s) => s.rank === rank);
  return share ? Math.floor((poolTetri * share.shareBps) / 10_000) : 0;
}
