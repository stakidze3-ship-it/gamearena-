/**
 * Game SDK — the contract every game implements so the platform (matchmaking,
 * Blitz, replays, anti-cheat) stays game-agnostic. A new game plugs in by
 * providing a GameDefinition; no platform code changes.
 *
 *   create(seed) → engine     init from the deterministic seed
 *   engine.applyInput(input)  advance state; returns whether it was legal
 *   engine.getScore()         authoritative score so far
 *   engine.isOver()           terminal (e.g. board stuck)
 *   engine.getState()         snapshot for rendering (client only)
 */

/** Base input: every input carries a timestamp in ms since game start. */
export interface GameInput {
  t: number;
}

export interface GameEngine<TState = unknown, TInput extends GameInput = GameInput> {
  applyInput(input: TInput): boolean;
  getScore(): number;
  isOver(): boolean;
  getState(): TState;
}

export interface GameDefinition<TState = unknown, TInput extends GameInput = GameInput> {
  key: string;
  durationS: number;
  /**
   * `rulesVersion` pins the scoring rules a run was created under, so a stored
   * input log always re-scores to the number it was actually settled on.
   * Omitted means "latest", which is correct for new runs only.
   */
  create(seed: string, rulesVersion?: number): GameEngine<TState, TInput>;
}

export interface SimResult {
  score: number;
  over: boolean;
  applied: number;
  rejected: number;
}

/**
 * Replay an input log through a fresh engine and return the authoritative
 * score. This is the ONLY thing the server trusts — client-reported scores
 * are never read. Inputs outside [0, durationMs] or that the engine rejects
 * as illegal are dropped (and counted), so a tampered client cannot inflate.
 */
export function simulate(
  def: GameDefinition,
  seed: string,
  inputs: GameInput[],
  durationMs: number,
  rulesVersion?: number
): SimResult {
  const engine = def.create(seed, rulesVersion);
  let applied = 0;
  let rejected = 0;
  let lastT = -1;
  for (const input of inputs) {
    if (engine.isOver()) break;
    // Timestamps must be within the round and non-decreasing.
    if (typeof input.t !== "number" || input.t < 0 || input.t > durationMs || input.t < lastT) {
      rejected++;
      continue;
    }
    lastT = input.t;
    if (engine.applyInput(input)) applied++;
    else rejected++;
  }
  return { score: engine.getScore(), over: engine.isOver(), applied, rejected };
}
