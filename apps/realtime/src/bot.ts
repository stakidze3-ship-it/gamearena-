/**
 * Demo bot — generates a plausible input stream for a seed by playing greedily
 * with a capped move count and occasional suboptimal moves, so a human has a
 * fair shot. Bots run ONLY in demo mode and are always labelled "BOT".
 * Inputs are spread across the round so the bot's score climbs live.
 */
import { BlockBlastEngine, GRID, type BlockBlastInput } from "@gamearena/games";

function countLines(grid: boolean[], shape: { cells: readonly (readonly [number, number])[] }, r: number, c: number): number {
  const g = grid.slice();
  for (const [dr, dc] of shape.cells) g[(r + dr) * GRID + (c + dc)] = true;
  let lines = 0;
  for (let i = 0; i < GRID; i++) {
    let rowFull = true;
    let colFull = true;
    for (let j = 0; j < GRID; j++) {
      if (!g[i * GRID + j]) rowFull = false;
      if (!g[j * GRID + i]) colFull = false;
    }
    if (rowFull) lines++;
    if (colFull) lines++;
  }
  return lines;
}

export function generateBotInputs(seed: string, durationMs: number): BlockBlastInput[] {
  const eng = new BlockBlastEngine(seed);
  const inputs: Omit<BlockBlastInput, "t">[] = [];

  const maxMoves = 34 + Math.floor(Math.random() * 18); // 34..51
  const sloppiness = 0.22; // chance of a random legal move instead of the best

  for (let m = 0; m < maxMoves && !eng.isOver(); m++) {
    const st = eng.getState();
    const legal: { s: number; r: number; c: number; gain: number }[] = [];
    for (let s = 0; s < 3; s++) {
      const shape = st.hand[s];
      if (!shape) continue;
      for (let r = 0; r <= GRID - shape.h; r++) {
        for (let c = 0; c <= GRID - shape.w; c++) {
          if (!eng.previewFits(s, r, c)) continue;
          legal.push({ s, r, c, gain: countLines(st.grid, shape, r, c) });
        }
      }
    }
    if (legal.length === 0) break;
    let pick: { s: number; r: number; c: number };
    if (Math.random() < sloppiness) {
      pick = legal[Math.floor(Math.random() * legal.length)]!;
    } else {
      pick = legal.reduce((a, b) => (b.gain > a.gain ? b : a));
    }
    if (!eng.applyInput({ t: 0, s: pick.s, r: pick.r, c: pick.c })) break;
    inputs.push({ s: pick.s, r: pick.r, c: pick.c });
  }

  // Spread the placements across ~95% of the round with light jitter.
  const span = durationMs * 0.95;
  return inputs.map((inp, i) => {
    const base = Math.round(((i + 1) / (inputs.length + 1)) * span);
    const jitter = Math.round((Math.random() - 0.5) * 400);
    return { ...inp, t: Math.max(0, Math.min(durationMs - 1, base + jitter)) };
  });
}
