import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import {
  AWAITING_PLAYERS_AT,
  KNOCKOUT_CONFIG,
  lariToTetri,
  formatTetri,
  prizeTetriFor,
  type PrizeShare,
} from "@gamearena/shared";

/**
 * Creating a REAL, player-visible knockout — the one implementation.
 *
 * This lives outside the route handlers because two URLs answer to it. The
 * original is /api/admin/tournaments/create; the admin console calls
 * /api/admin/tournaments/create-live, because "create" alone does not say which
 * of the two dangerous things it does (a live event and a test event are the
 * same object with wildly different consequences). Rather than stand up a
 * near-duplicate route, both handlers are three lines over this function — the
 * validation, the prize maths and the safety checks exist exactly once.
 *
 * What makes it the LIVE path: `isTest` stays false, so the event appears on
 * /tournaments the moment it exists and real players can spend real balance on
 * entry. /create-test is the hidden, disposable counterpart.
 *
 * Prizes are validated against the pool rather than trusted. A structure
 * summing over 100% would promise money the escrow does not hold, and
 * settlement would have to top it up out of treasury — which is to say the
 * platform would quietly pay the difference on every event, forever.
 *
 * Registration opens immediately: `startsAt` is the awaiting-players sentinel,
 * so the event shows as open and the draw fires when the last seat is taken.
 *
 * AUTHORISATION IS THE CALLER'S JOB. This function does not check who is
 * asking; every route above it must `await requireAdmin()` before calling in.
 */

/** Ranks must be 1..n, each once — a duplicate or a gap misdirects settlement. */
const prizeStructureSchema = z
  .array(
    z.object({
      rank: z.number().int().min(1).max(8),
      shareBps: z.number().int().min(0).max(10_000),
    })
  )
  .min(1)
  .max(8)
  .refine((shares) => new Set(shares.map((s) => s.rank)).size === shares.length, {
    message: "Each prize rank may appear only once",
  })
  .refine((shares) => shares.reduce((n, s) => n + s.shareBps, 0) <= 10_000, {
    message: "Prize shares add up to more than the whole pool",
  });

export const createLiveTournamentSchema = z.object({
  /** Public — this is what players see on the Tournaments page. */
  name: z.string().min(2).max(60).optional(),
  gameKey: z.string().default("block-blast"),
  capacity: z.number().int().min(2).max(1024),
  /**
   * Entry fee, in whichever unit the caller has to hand. Tetri is the money
   * type everywhere inside the platform, so it wins when both are given; lari
   * exists because it is what an operator types.
   */
  entryTetri: z.number().int().min(0).max(1_000_000).optional(),
  entryLari: z.number().min(0).max(10_000).optional(),
  /**
   * Prizes, either as lari per rank (biggest first) or as exact shares of the
   * pool in basis points. Omitted, the published championship split is used.
   */
  prizesLari: z.array(z.number().min(0)).min(1).max(8).optional(),
  prizeStructure: prizeStructureSchema.optional(),
  roundDurationS: z.number().int().min(30).max(3600).default(180),
  /**
   * The round-one ready-up window. Defaults to the round window rather than to
   * a fixed figure: an operator who sets a 30-second round and then waits three
   * minutes for the first one to open assumes the event is broken.
   */
  readyWindowS: z.number().int().min(30).max(3600).optional(),
});

export type CreateLiveTournamentInput = z.input<typeof createLiveTournamentSchema>;

export async function createLiveTournament(body: unknown): Promise<NextResponse> {
  const parsed = createLiveTournamentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid tournament" },
      { status: 400 }
    );
  }
  const d = parsed.data;

  const game = await prisma.game.findUnique({ where: { key: d.gameKey } });
  if (!game) {
    return NextResponse.json({ error: `No game "${d.gameKey}"` }, { status: 400 });
  }
  if (!game.enabled) {
    return NextResponse.json({ error: `${game.name} is not enabled` }, { status: 409 });
  }

  const entryTetri =
    d.entryTetri ??
    (d.entryLari !== undefined ? lariToTetri(d.entryLari) : KNOCKOUT_CONFIG.entryTetri);
  const poolTetri = entryTetri * d.capacity;

  if (poolTetri === 0) {
    return NextResponse.json({ error: "A paid event needs a non-zero entry" }, { status: 400 });
  }

  // Three ways of expressing the same thing, resolved to basis points of the
  // full pool (capacity × entry) so settlement pays exactly the advertised
  // figures. Lari amounts are converted here; an explicit bps structure is
  // taken as given; and with neither, the championship's published split is
  // reused rather than reinvented per event.
  let prizeStructure: PrizeShare[];
  if (d.prizeStructure) {
    prizeStructure = d.prizeStructure;
  } else if (d.prizesLari) {
    const prizeTetri = d.prizesLari.map((lari) => lariToTetri(lari));
    const totalPrizeTetri = prizeTetri.reduce((n, p) => n + p, 0);
    if (totalPrizeTetri > poolTetri) {
      return NextResponse.json(
        {
          error: `Prizes total more than the pool — ${formatTetri(totalPrizeTetri)} promised against ${formatTetri(poolTetri)} collected.`,
        },
        { status: 400 }
      );
    }
    prizeStructure = prizeTetri.map((tetri, i) => ({
      rank: i + 1,
      shareBps: Math.round((tetri / poolTetri) * 10_000),
    }));
  } else {
    prizeStructure = KNOCKOUT_CONFIG.prizeStructure;
  }

  const prizes = prizeStructure.map((share) => ({
    rank: share.rank,
    tetri: prizeTetriFor(share.rank, poolTetri, prizeStructure),
  }));
  const paidOutTetri = prizes.reduce((n, p) => n + p.tetri, 0);

  const name = d.name ?? `${KNOCKOUT_CONFIG.name} · ${d.capacity} seats`;
  const roundDurationS = d.roundDurationS;
  const readyWindowS = d.readyWindowS ?? roundDurationS;

  const t = await prisma.tournament.create({
    data: {
      name,
      gameId: game.id,
      entryTetri,
      guaranteeTetri: 0,
      prizeStructure: prizeStructure as unknown as object[],
      capacity: d.capacity,
      // Fills-then-starts: visible and open for registration straight away.
      startsAt: AWAITING_PLAYERS_AT,
      format: "KNOCKOUT",
      durationS: game.durationS,
      roundDurationS,
      readyWindowS,
      isTest: false,
      status: "SCHEDULED",
    },
    select: { id: true, name: true, capacity: true, entryTetri: true },
  });

  return NextResponse.json({
    ok: true,
    ...t,
    poolTetri,
    prizes,
    rakeTetri: poolTetri - paidOutTetri,
    message:
      `Created "${t.name}" · ${t.capacity} seats · ${formatTetri(entryTetri)} entry · ` +
      `${formatTetri(poolTetri)} pool · visible to players now.`,
  });
}
