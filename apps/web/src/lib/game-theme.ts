/**
 * Per-game identity on the dark base: a colored icon on a soft tinted tile.
 * Seasoning, not a takeover — cards stay dark, accents stay small.
 * New games register here; falls back to violet.
 */

export interface GameTheme {
  /** icon color */
  icon: string;
  /** soft tinted tile behind the icon */
  tile: string;
  /** badge tone matching the accent */
  badgeTone: "violet" | "amber" | "mint" | "sky" | "coral";
}

const THEMES: Record<string, GameTheme> = {
  "block-blast": {
    icon: "text-violet",
    tile: "bg-violet/12",
    badgeTone: "violet",
  },
  "bricks-breaker": {
    icon: "text-amber",
    tile: "bg-amber/12",
    badgeTone: "amber",
  },
};

export function gameTheme(key: string): GameTheme {
  return THEMES[key] ?? THEMES["block-blast"]!;
}
