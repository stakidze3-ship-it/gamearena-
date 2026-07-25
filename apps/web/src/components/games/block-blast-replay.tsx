"use client";

import { BlockBlastEngine, GRID, type BlockBlastInput } from "@gamearena/games";
import { cn } from "@/lib/cn";

/**
 * Read-only Block Blast board reconstructed from a stored input log at time T.
 * Re-simulates from the seed through the shared engine — the same code that
 * scored the match — so a replay is provably the real game, not a recording.
 */

const PALETTE = ["#8f84f5", "#4cc3f7", "#2fd9a4", "#ffb84d", "#ff7b7b", "#c98cff"];

export interface ReplayFrame {
  grid: boolean[];
  colors: (string | null)[];
  score: number;
  over: boolean;
  placed: number;
}

/** Deterministically rebuild the board state at (and including) time `tMax`. */
export function replayTo(seed: string, inputs: BlockBlastInput[], tMax: number): ReplayFrame {
  const eng = new BlockBlastEngine(seed);
  const colors: (string | null)[] = new Array(GRID * GRID).fill(null);
  let counter = 0;
  let placed = 0;
  for (const inp of inputs) {
    if (inp.t > tMax) break;
    const shape = eng.getState().hand[inp.s];
    if (!eng.applyInput(inp)) continue;
    const color = PALETTE[counter++ % PALETTE.length]!;
    if (shape) for (const [dr, dc] of shape.cells) colors[(inp.r + dr) * GRID + (inp.c + dc)] = color;
    for (const idx of eng.getState().lastCleared) colors[idx] = null;
    placed++;
  }
  const st = eng.getState();
  return { grid: st.grid, colors, score: st.score, over: st.over, placed };
}

export function ReplayBoard({ frame, className }: { frame: ReplayFrame; className?: string }) {
  return (
    <div className={cn("grid aspect-square grid-cols-8 gap-1 rounded-2xl border border-border bg-surface p-2", className)}>
      {Array.from({ length: GRID * GRID }, (_, idx) => {
        const color = frame.colors[idx];
        return (
          <div
            key={idx}
            className={cn("relative rounded-[5px]", !color && "bg-bg")}
            style={color ? { backgroundColor: color } : undefined}
          >
            {color && <span className="absolute inset-x-0 top-0 h-1/3 rounded-t-[5px] bg-white/25" />}
          </div>
        );
      })}
    </div>
  );
}
