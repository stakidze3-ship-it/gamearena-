/**
 * A live 1v1 match. The server keeps an authoritative engine per player and
 * feeds it the streamed inputs — the client's score is never trusted. At the
 * end it computes both scores itself and settles escrow atomically through the
 * double-entry ledger (winner + rake, or refund on a draw), persisting the
 * full input log as a replay.
 */
import type { WebSocket } from "ws";
import {
  prisma,
  Prisma,
  openReviewCase,
  refundMatchIn,
  settleMatchIn,
} from "@gamearena/db";
import {
  analyzeInputTiming,
  DEFAULT_GLICKO,
  isWinRateAnomalous,
  settlePot,
  updatePair,
  type Glicko,
} from "@gamearena/shared";
import {
  type BlockBlastInput,
  type GameDefinition,
  type GameEngine,
} from "@gamearena/games";
import { send } from "./protocol";

export interface RoomPlayer {
  userId: string;
  username: string;
  isBot: boolean;
  ws: WebSocket | null;
  engine: GameEngine<unknown, BlockBlastInput>;
  score: number;
  inputs: BlockBlastInput[];
  lastT: number;
}

export class MatchRoom {
  private ended = false;
  private endTimer: NodeJS.Timeout | null = null;
  private botTimers: NodeJS.Timeout[] = [];
  readonly durationMs: number;

  constructor(
    readonly matchId: string,
    readonly gameId: string,
    readonly def: GameDefinition,
    readonly seed: string,
    readonly seedHash: string,
    readonly stakeTetri: number,
    readonly rakeBps: number,
    readonly potTetri: number,
    readonly players: [RoomPlayer, RoomPlayer],
    durationS: number,
    private readonly onCleanup: (matchId: string) => void
  ) {
    this.durationMs = durationS * 1000;
  }

  private other(userId: string): RoomPlayer {
    return this.players[0].userId === userId ? this.players[1] : this.players[0];
  }

  /** Reveal the seed and begin play; schedule bot inputs and the hard cutoff. */
  start(botInputs: Map<string, BlockBlastInput[]>): void {
    for (const p of this.players) {
      send(p.ws, { t: "start", seed: this.seed, endsInMs: this.durationMs });
    }
    // Drive any bot player from its precomputed input stream.
    for (const p of this.players) {
      if (!p.isBot) continue;
      const inputs = botInputs.get(p.userId) ?? [];
      for (const input of inputs) {
        const timer = setTimeout(() => this.handleInput(p.userId, input), input.t);
        this.botTimers.push(timer);
      }
    }
    // Grace period lets last-second client inputs arrive before we settle.
    this.endTimer = setTimeout(() => void this.end(), this.durationMs + 1500);
  }

  handleInput(userId: string, input: BlockBlastInput): void {
    if (this.ended) return;
    const p = this.players.find((x) => x.userId === userId);
    if (!p) return;
    const { t, s, r, c } = input;
    if (typeof t !== "number" || t < 0 || t > this.durationMs || t < p.lastT) return;
    if (![s, r, c].every((n) => Number.isInteger(n))) return;
    if (!p.engine.applyInput({ t, s, r, c })) return;
    p.lastT = t;
    p.inputs.push({ t, s, r, c });
    p.score = p.engine.getScore();
    send(this.other(userId).ws, { t: "oppScore", score: p.score });
  }

  handleChat(userId: string, text: string): void {
    if (this.ended) return;
    const clean = text.slice(0, 200);
    const from = this.players.find((x) => x.userId === userId)?.username ?? "?";
    for (const p of this.players) {
      send(p.ws, { t: "chat", from, text: clean, self: p.userId === userId });
    }
  }

  /** A human dropped — finalize now so the escrow always resolves. */
  onDisconnect(userId: string): void {
    const p = this.players.find((x) => x.userId === userId);
    if (p) p.ws = null;
    if (!this.ended) void this.end();
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (this.endTimer) clearTimeout(this.endTimer);
    for (const timer of this.botTimers) clearTimeout(timer);

    const [a, b] = this.players;
    a.score = a.engine.getScore();
    b.score = b.engine.getScore();

    const draw = a.score === b.score;
    const winner = draw ? null : a.score > b.score ? a : b;
    const aResult = draw ? 0.5 : a.score > b.score ? 1 : 0;

    try {
      await prisma.$transaction(async (db) => {
        // ── Glicko-2: update both players for this game ──
        const [ga, gb] = await Promise.all([
          this.loadRating(db, a.userId),
          this.loadRating(db, b.userId),
        ]);
        const next = updatePair(ga, gb, aResult);

        await this.saveRating(db, a.userId, ga, next.a, aResult === 1);
        await this.saveRating(db, b.userId, gb, next.b, aResult === 0);

        await db.matchPlayer.update({
          where: { matchId_userId: { matchId: this.matchId, userId: a.userId } },
          data: {
            serverScore: a.score,
            inputLog: a.inputs as unknown as Prisma.InputJsonValue,
            inputCount: a.inputs.length,
            ratingBefore: ga.rating,
            ratingAfter: next.a.rating,
          },
        });
        await db.matchPlayer.update({
          where: { matchId_userId: { matchId: this.matchId, userId: b.userId } },
          data: {
            serverScore: b.score,
            inputLog: b.inputs as unknown as Prisma.InputJsonValue,
            inputCount: b.inputs.length,
            ratingBefore: gb.rating,
            ratingAfter: next.b.rating,
          },
        });

        if (draw) {
          await refundMatchIn(db, this.matchId, [
            { userId: a.userId, amountTetri: this.stakeTetri },
            { userId: b.userId, amountTetri: this.stakeTetri },
          ]);
          await db.match.update({
            where: { id: this.matchId },
            data: { status: "SETTLED", isDraw: true, endedAt: new Date(), settledAt: new Date() },
          });
        } else {
          await settleMatchIn(db, this.matchId, winner!.userId, this.potTetri, this.rakeBps);
          await db.match.update({
            where: { id: this.matchId },
            data: {
              status: "SETTLED",
              winnerUserId: winner!.userId,
              endedAt: new Date(),
              settledAt: new Date(),
            },
          });
        }
      });
    } catch (err) {
      console.error(`[match ${this.matchId}] settlement failed`, err);
    }

    // ── Anti-cheat signals (advisory, human players only) ──
    await this.runAntiCheat();

    const { payoutTetri, rakeTetri } = settlePot(this.potTetri, this.rakeBps);
    for (const p of this.players) {
      const opp = this.other(p.userId);
      const outcome = draw ? "draw" : winner!.userId === p.userId ? "win" : "loss";
      const net = draw ? 0 : outcome === "win" ? payoutTetri - this.stakeTetri : -this.stakeTetri;
      send(p.ws, {
        t: "result",
        matchId: this.matchId,
        youScore: p.score,
        oppScore: opp.score,
        outcome,
        stakeTetri: this.stakeTetri,
        potTetri: this.potTetri,
        payoutTetri: draw ? this.stakeTetri : payoutTetri,
        rakeTetri: draw ? 0 : rakeTetri,
        netTetri: net,
        seed: this.seed,
      });
    }

    this.onCleanup(this.matchId);
  }

  private async loadRating(db: Prisma.TransactionClient, userId: string): Promise<Glicko> {
    const rs = await db.ratingState.findUnique({
      where: { userId_gameId: { userId, gameId: this.gameId } },
    });
    return rs ? { rating: rs.rating, rd: rs.rd, vol: rs.volatility } : { ...DEFAULT_GLICKO };
  }

  private async saveRating(
    db: Prisma.TransactionClient,
    userId: string,
    before: Glicko,
    after: Glicko,
    won: boolean
  ): Promise<void> {
    await db.ratingState.upsert({
      where: { userId_gameId: { userId, gameId: this.gameId } },
      create: {
        userId,
        gameId: this.gameId,
        rating: after.rating,
        rd: after.rd,
        volatility: after.vol,
        matchesPlayed: 1,
        wins: won ? 1 : 0,
      },
      update: {
        rating: after.rating,
        rd: after.rd,
        volatility: after.vol,
        matchesPlayed: { increment: 1 },
        wins: won ? { increment: 1 } : undefined,
      },
    });
  }

  private async runAntiCheat(): Promise<void> {
    for (const p of this.players) {
      if (p.isBot) continue;
      try {
        // Input-timing tell for this match.
        const timing = analyzeInputTiming(p.inputs);
        if (timing.flagged && timing.reason) {
          await openReviewCase(prisma, p.userId, timing.reason, {
            matchId: this.matchId,
            ...timing.detail,
          });
        }
        // Win-rate anomaly over this game's history → hold payouts.
        const rs = await prisma.ratingState.findUnique({
          where: { userId_gameId: { userId: p.userId, gameId: this.gameId } },
        });
        if (rs && isWinRateAnomalous(rs.wins, rs.matchesPlayed)) {
          await openReviewCase(
            prisma,
            p.userId,
            "WINRATE_ANOMALY",
            { gameId: this.gameId, wins: rs.wins, matches: rs.matchesPlayed },
            true
          );
        }
      } catch (err) {
        console.error(`[match ${this.matchId}] anti-cheat failed`, err);
      }
    }
  }
}
