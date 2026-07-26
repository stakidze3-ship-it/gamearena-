/**
 * Guarantee there is always an open tournament for players to enter.
 *
 * The flagship event was originally created by the scheduler, then by the
 * build-time seed. Neither survives contact with this deployment: there is no
 * scheduler in production, and the seed step is deliberately non-fatal, so if
 * it fails the build still ships and the Tournaments page is simply empty with
 * nothing to show for it.
 *
 * Doing it lazily at read time removes both single points of failure. The page
 * that needs an event is the page that creates one, so the worst case is a
 * slightly slower first render rather than an empty product.
 *
 * Concurrency is handled with a transaction-scoped advisory lock rather than a
 * check-then-create, because sixty people refreshing at once would otherwise
 * create sixty tournaments.
 */

import { Prisma } from "@prisma/client";
import { AWAITING_PLAYERS_AT, KNOCKOUT_CONFIG, KNOCKOUT_ROUNDS } from "@gamearena/shared";
import { prisma } from "./client";

/** One well-known lock id for this operation; any constant works. */
const ENSURE_EVENT_LOCK = 918_273_645;

export interface EnsureOpenEventResult {
  created: boolean;
  tournamentId: string | null;
}

/**
 * Create the flagship knockout if no VISIBLE one is open.
 *
 * `isTest: false` is the important part of the check. A bot-filled event is
 * flagged as a test and hidden from players, but it is still SCHEDULED — so
 * counting it as "an event is open" is exactly what left production with three
 * tournaments and an empty page.
 *
 * Never throws: an event that cannot be created must not take the Tournaments
 * page down with it.
 */
export async function ensureOpenKnockout(): Promise<EnsureOpenEventResult> {
  try {
    return await prisma.$transaction(async (db) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(${ENSURE_EVENT_LOCK}::bigint)`;

      const open = await db.tournament.findFirst({
        where: {
          format: "KNOCKOUT",
          isTest: false,
          status: { in: ["SCHEDULED", "RUNNING"] },
        },
        select: { id: true },
      });
      if (open) return { created: false, tournamentId: open.id };

      const game = await db.game.findFirst({ where: { key: "block-blast", enabled: true } });
      if (!game) return { created: false, tournamentId: null };

      const t = await db.tournament.create({
        data: {
          name: KNOCKOUT_CONFIG.name,
          gameId: game.id,
          entryTetri: KNOCKOUT_CONFIG.entryTetri,
          guaranteeTetri: KNOCKOUT_CONFIG.guaranteeTetri,
          prizeStructure: KNOCKOUT_CONFIG.prizeStructure as unknown as Prisma.InputJsonValue,
          capacity: KNOCKOUT_CONFIG.capacity,
          // Fill-triggered: the field filling starts it, not the clock.
          startsAt: AWAITING_PLAYERS_AT,
          durationS: KNOCKOUT_CONFIG.roundDurationS * KNOCKOUT_ROUNDS,
          format: "KNOCKOUT",
          roundDurationS: KNOCKOUT_CONFIG.roundDurationS,
          readyWindowS: KNOCKOUT_CONFIG.readyWindowS,
          status: "SCHEDULED",
          isRecurring: true,
          isTest: false,
        },
        select: { id: true },
      });
      return { created: true, tournamentId: t.id };
    });
  } catch {
    return { created: false, tournamentId: null };
  }
}
