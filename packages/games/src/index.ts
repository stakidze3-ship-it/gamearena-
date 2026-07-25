export * from "./sdk";
export * from "./rng";
export * from "./block-blast";

import type { GameDefinition } from "./sdk";
import { blockBlast } from "./block-blast";

/** Registry — platform code (Blitz, matches, replays) resolves games by key. */
export const GAME_REGISTRY: Record<string, GameDefinition> = {
  [blockBlast.key]: blockBlast as GameDefinition,
};

export function getGameDefinition(key: string): GameDefinition | undefined {
  return GAME_REGISTRY[key];
}
