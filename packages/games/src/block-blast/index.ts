import type { GameDefinition } from "../sdk";
import { BlockBlastEngine, type BlockBlastInput, type BlockBlastState } from "./engine";

export const blockBlast: GameDefinition<BlockBlastState, BlockBlastInput> = {
  key: "block-blast",
  durationS: 60,
  create: (seed) => new BlockBlastEngine(seed),
};

export { BlockBlastEngine, GRID } from "./engine";
export type { BlockBlastInput, BlockBlastState } from "./engine";
export { SHAPES } from "./pieces";
export type { Shape, Cell } from "./pieces";
