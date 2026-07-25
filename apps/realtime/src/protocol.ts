/** Wire protocol between match clients and the realtime service. */

import type { BlockBlastInput } from "@gamearena/games";

// ── Client → Server ──
export type ClientMessage =
  | { t: "join"; gameKey: string; stakeTetri: number; challengeId?: string }
  | { t: "input"; input: BlockBlastInput }
  | { t: "chat"; text: string }
  | { t: "leave" };

// ── Server → Client ──
export type ServerMessage =
  | { t: "queued"; stakeTetri: number }
  | {
      t: "matched";
      matchId: string;
      seedHash: string;
      opponent: { username: string; isBot: boolean };
      stakeTetri: number;
      potTetri: number;
      rakeBps: number;
      durationS: number;
      startInMs: number;
    }
  | { t: "start"; seed: string; endsInMs: number }
  | { t: "oppScore"; score: number }
  | { t: "chat"; from: string; text: string; self: boolean }
  | {
      t: "result";
      matchId: string;
      youScore: number;
      oppScore: number;
      outcome: "win" | "loss" | "draw";
      stakeTetri: number;
      potTetri: number;
      payoutTetri: number;
      rakeTetri: number;
      netTetri: number;
      seed: string;
    }
  | { t: "error"; message: string };

export function send(ws: { send: (data: string) => void } | null, msg: ServerMessage): void {
  ws?.send(JSON.stringify(msg));
}
