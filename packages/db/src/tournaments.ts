/**
 * Tournament settlement — shared by the web app (register/finalize routes,
 * auto-finalize on page load) and the realtime scheduler (daily recurring
 * events). Single source of truth for prize distribution.
 */
import { createHash, randomInt } from "node:crypto";
import { isAwaitingPlayers } from "@gamearena/shared";
import { cancelTournamentRefunding } from "./bracket";
import { AccountKeys, InsufficientFundsError, getBalanceTetri } from "./ledger";
import { registerTournamentEntryIn, settleTournamentIn } from "./money-ops";
import { prisma } from "./client";

export function tournamentEndsAt(startsAt: Date, durationS: number): Date {
  return new Date(startsAt.getTime() + durationS * 1000);
}

export type JoinTournamentResult =
  | {
      ok: true;
      alreadyEntered: boolean;
      entryCount: number;
      capacity: number;
      full: boolean;
      startsAt: Date;
      seed: string | null;
    }
  | { ok: false; status: number; error: string };

/**
 * Take a seat in a tournament: charge the entry into escrow, record the entry,
 * and — when that was the last seat — close registration by starting the
 * countdown to the draw.
 *
 * The whole thing runs under a row lock on the tournament so the final seat is
 * handed out exactly once no matter how many people tap Join simultaneously.
 * Idempotent per user: a second call returns the existing entry untouched, and
 * the ledger key `tourney-entry:<tid>:<uid>` backstops it.
 */
export async function joinTournament(
  tournamentId: string,
  userId: string,
  countdownS: number
): Promise<JoinTournamentResult> {
  try {
    return await prisma.$transaction(
      async (db): Promise<JoinTournamentResult> => {
        // Serialize joins for this event; concurrent callers queue here.
        await db.$queryRaw`SELECT id FROM "Tournament" WHERE id = ${tournamentId} FOR UPDATE`;

        const t = await db.tournament.findUnique({ where: { id: tournamentId } });
        if (!t) return { ok: false, status: 404, error: "Tournament not found" };
        if (t.status === "FINISHED" || t.status === "CANCELLED") {
          return { ok: false, status: 409, error: "This tournament has ended" };
        }

        const count = await db.tournamentEntry.count({ where: { tournamentId } });
        const existing = await db.tournamentEntry.findUnique({
          where: { tournamentId_userId: { tournamentId, userId } },
        });
        if (existing) {
          return {
            ok: true, alreadyEntered: true,
            entryCount: count, capacity: t.capacity,
            full: count >= t.capacity, startsAt: t.startsAt, seed: t.seed,
          };
        }

        if (t.format === "KNOCKOUT") {
          if (t.status === "RUNNING") {
            return { ok: false, status: 409, error: "The bracket has already started" };
          }
        } else if (new Date() > tournamentEndsAt(t.startsAt, t.durationS)) {
          return { ok: false, status: 409, error: "This tournament has ended" };
        }
        if (count >= t.capacity) {
          return { ok: false, status: 409, error: "Every seat is taken" };
        }

        // Leaderboard events commit their shared seed on the first entry.
        let seed = t.seed;
        if (t.format !== "KNOCKOUT" && !seed) {
          seed = randomInt(100_000, 1_000_000).toString();
          await db.tournament.update({
            where: { id: tournamentId },
            data: {
              seed,
              seedHash: createHash("sha256").update(seed).digest("hex"),
              status: "RUNNING",
            },
          });
        }

        await db.tournamentEntry.create({ data: { tournamentId, userId } });
        await registerTournamentEntryIn(db, tournamentId, userId, t.entryTetri);

        // The last seat closes registration and starts the countdown to the
        // draw. Writing `startsAt` is all it takes — the scheduler's existing
        // "start what is due" path picks it up from there.
        const entryCount = count + 1;
        const full = entryCount >= t.capacity;
        let startsAt = t.startsAt;
        if (full && t.format === "KNOCKOUT" && isAwaitingPlayers(t.startsAt)) {
          startsAt = new Date(Date.now() + countdownS * 1000);
          await db.tournament.update({ where: { id: tournamentId }, data: { startsAt } });
        }

        return {
          ok: true, alreadyEntered: false,
          entryCount, capacity: t.capacity, full, startsAt, seed,
        };
      },
      { timeout: 15_000 }
    );
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      return { ok: false, status: 402, error: "Not enough demo credits" };
    }
    throw err;
  }
}

/**
 * Rank entrants by best score and settle the prize pool. Prizes come from the
 * escrowed entries, topped up from treasury to meet any guarantee. Idempotent:
 * a finished tournament is left untouched.
 */
export async function finalizeTournament(tournamentId: string): Promise<void> {
  const t = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    include: { entries: true },
  });
  if (!t || t.status === "FINISHED" || t.status === "CANCELLED") return;

  const pool = await getBalanceTetri(prisma, AccountKeys.tournamentEscrow(tournamentId));

  const ranked = [...t.entries]
    .filter((e) => e.bestScore != null)
    .sort((a, b) => (b.bestScore ?? 0) - (a.bestScore ?? 0));

  // Nobody posted a score, so there is no contest to settle. Paying nothing out
  // would sweep every entry fee to rake — refund the field instead.
  if (ranked.length === 0 && t.entries.length > 0) {
    await cancelTournamentRefunding(tournamentId);
    return;
  }

  const structure = t.prizeStructure as { rank: number; shareBps: number }[];
  const prizePool = Math.max(pool, t.guaranteeTetri);

  const winners: { userId: string; prizeTetri: number }[] = [];
  for (const s of structure) {
    const entry = ranked[s.rank - 1];
    if (!entry) continue;
    winners.push({ userId: entry.userId, prizeTetri: Math.floor((prizePool * s.shareBps) / 10_000) });
  }

  // One rank write per entrant plus the settlement entries exceeds Prisma's
  // default 5s budget on a large field; a rollback would leave the pool
  // escrowed and the event stuck.
  await prisma.$transaction(
    async (db) => {
      if (pool > 0 || winners.length > 0) {
        await settleTournamentIn(db, tournamentId, pool, winners);
      }
      for (let i = 0; i < ranked.length; i++) {
        const entry = ranked[i]!;
        const win = winners.find((w) => w.userId === entry.userId);
        await db.tournamentEntry.update({
          where: { tournamentId_userId: { tournamentId, userId: entry.userId } },
          data: { rank: i + 1, prizeTetri: win?.prizeTetri ?? 0 },
        });
      }
      await db.tournament.update({
        where: { id: tournamentId },
        data: { status: "FINISHED", finishedAt: new Date() },
      });
    },
    { timeout: 20_000 }
  );
}
