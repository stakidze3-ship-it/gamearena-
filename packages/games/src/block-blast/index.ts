import type { GameDefinition } from "../sdk";
import {
  BlockBlastEngine,
  type BlockBlastInput,
  type BlockBlastRulesVersion,
  type BlockBlastState,
} from "./engine";

export const blockBlast: GameDefinition<BlockBlastState, BlockBlastInput> = {
  key: "block-blast",
  durationS: 60,
  create: (seed, rulesVersion) => new BlockBlastEngine(seed, rulesVersion as BlockBlastRulesVersion),
};

export {
  BlockBlastEngine,
  GRID,
  BLOCK_BLAST_RULES_V1,
  BLOCK_BLAST_RULES_V2,
  BLOCK_BLAST_RULES_LATEST,
} from "./engine";
export type { BlockBlastInput, BlockBlastState, BlockBlastRulesVersion } from "./engine";
export { SHAPES } from "./pieces";
export type { Shape, Cell } from "./pieces";
