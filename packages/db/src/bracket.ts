/**
 * Single-elimination knockout brackets.
 *
 * A knockout tournament pairs entrants head-to-head each round; the higher
 * score advances (64 → 32 → 16 → 8 → 4 → 2 → champion). Every match in a round
 * plays the identical, provably-fair seed (hash committed when the round opens,
 * seed revealed as it starts) so only skill separates the pair.
 *
 * Rounds are async and window-boxed: a round advances early the moment everyone
 * in it has played, and forfeits any no-shows when its window closes. Bracket
 * geometry: round r slot s feeds round r+1 slot ⌊s/2⌋, taking the a-position
 * when s is even and the b-position when s is odd.
 */
import { createHash, randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./client";
import { AccountKeys, getBalanceTetri } from "./ledger";
import { settleTournamentIn } from "./money-ops";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const newSeed = () => randomInt(100_000, 1_000_000).toString();

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * The third-place match shares the final's round, parked in slot 1 (the final
 * owns slot 0). Keeping it in-band means the round driver, the window clock and
 * the finalizer all pick it up with no special-casing — it opens on the same
 * seed as the final and must be DONE before the event settles.
 */
export const THIRD_PLACE_SLOT = 1;

/** A provisional/actual first-round slot. `a`/`b` index the ordered player
 *  list; `b` is null on a bye. Byes fall to the trailing matches. */
export interface FirstRoundSlot {
  a: number | null;
  b: number | null;
  bye: boolean;
}

/**
 * First-round pairing plan for `count` players, purely by their order (so
 * registrant #1 meets #2, #3 meets #4, …). Shared by the live draw and the
 * registration-phase preview so what players see is exactly what they get.
 */
export function firstRoundPlan(count: number): FirstRoundSlot[] {
  if (count < 1) return [];
  const size = nextPow2(count);
  const firstMatches = size / 2;
  const byes = size - count;
  const byeSet = new Set<number>();
  for (let i = 0; i < byes; i++) byeSet.add(firstMatches - 1 - i); // trailing matches get the byes
  const out: FirstRoundSlot[] = [];
  let cursor = 0;
  for (let s = 0; s < firstMatches; s++) {
    if (byeSet.has(s)) out.push({ a: cursor++, b: null, bye: true });
    else out.push({ a: cursor++, b: cursor++, bye: false });
  }
  return out;
}

/**
 * Build the bracket from the registered entrants and open round 1. Idempotent:
 * a tournament that already has bracket matches is left untouched. Returns the
 * number of entrants placed, or 0 if there were too few to start.
 */
export async function generateKnockout(tournamentId: string): Promise<number> {
  const t = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    include: { entries: true },
  });
  if (!t || t.format !== "KNOCKOUT") return 0;

  const existing = await prisma.bracketMatch.count({ where: { tournamentId } });
  if (existing > 0) return t.entries.length;
  if (t.entries.length < 2) return 0;

  // Draw in registration order so the pairings match what players saw while
  // registering (#1 vs #2, #3 vs #4, …); byes fall to the last registrants.
  const players = [...t.entries]
    .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
    .map((e) => e.userId);
  const size = nextPow2(players.length);
  const rounds = Math.log2(size);
  const plan = firstRoundPlan(players.length);

  const seed = newSeed();
  const hash = sha256(seed);
  const now = new Date();

  // Build the whole bracket in memory first, then write it in two bulk inserts.
  // A 60-seat field is ~63 rows; issuing them one-by-one inside an interactive
  // transaction risks Prisma's default 5s timeout.
  const roundOne: Prisma.BracketMatchCreateManyInput[] = [];
  const shells = new Map<string, Prisma.BracketMatchCreateManyInput>();
  for (let r = 2; r <= rounds; r++) {
    for (let slot = 0; slot < size / 2 ** r; slot++) {
      shells.set(`${r}:${slot}`, { tournamentId, round: r, slot, status: "PENDING" });
    }
  }

  for (let slot = 0; slot < plan.length; slot++) {
    const m = plan[slot]!;
    if (m.bye) {
      // A bye is born decided; advance its player into the next round's shell.
      const solo = players[m.a!]!;
      roundOne.push({
        tournamentId, round: 1, slot,
        aUserId: solo, aPlayed: false,
        winnerUserId: solo, status: "DONE",
      });
      const shell = shells.get(`2:${Math.floor(slot / 2)}`);
      if (shell) {
        if (slot % 2 === 0) shell.aUserId = solo;
        else shell.bUserId = solo;
      }
    } else {
      roundOne.push({
        tournamentId, round: 1, slot,
        aUserId: players[m.a!]!, bUserId: players[m.b!]!,
        seed, seedHash: hash, openedAt: now, startedAt: now, status: "OPEN",
      });
    }
  }

  await prisma.$transaction(
    async (db) => {
      await db.bracketMatch.createMany({ data: roundOne });
      if (shells.size > 0) await db.bracketMatch.createMany({ data: [...shells.values()] });
      await db.tournament.update({
        where: { id: tournamentId },
        data: { status: "RUNNING", bracketStartedAt: now },
      });
    },
    { timeout: 20_000 }
  );

  return players.length;
}

/** Place an advancing winner into their next-round slot (a for even, b for odd). */
async function advanceWinnerIn(
  db: Prisma.TransactionClient,
  tournamentId: string,
  round: number,
  slot: number,
  winnerUserId: string,
  rounds: number
) {
  if (round >= rounds) return; // champion — nowhere to advance
  const nextSlot = Math.floor(slot / 2);
  const field = slot % 2 === 0 ? "aUserId" : "bUserId";
  await db.bracketMatch.upsert({
    where: { tournamentId_round_slot: { tournamentId, round: round + 1, slot: nextSlot } },
    create: { tournamentId, round: round + 1, slot: nextSlot, status: "PENDING", [field]: winnerUserId },
    update: { [field]: winnerUserId },
  });
}

/** The player's live match this round, if they have one they still owe a run. */
export async function currentKnockoutMatch(tournamentId: string, userId: string) {
  return prisma.bracketMatch.findFirst({
    where: {
      tournamentId,
      status: "OPEN",
      OR: [
        { aUserId: userId, aPlayed: false },
        { bUserId: userId, bPlayed: false },
      ],
    },
    orderBy: { round: "asc" },
  });
}

/**
 * Record a knockout run's score into the player's open match, and resolve the
 * pairing if both sides have now played. Returns the match after the update.
 */
export async function submitKnockoutScore(
  tournamentId: string,
  userId: string,
  score: number,
  /**
   * The player's raw input stream. Stored so the match can be re-simulated and
   * watched back later, exactly as the 1v1 path does — a tournament match that
   * cannot be replayed is a hole in the provably-fair story, not just a missing
   * feature. Optional so older callers keep working.
   */
  inputLog?: unknown[]
) {
  const m = await currentKnockoutMatch(tournamentId, userId);
  if (!m) return null;

  const rounds = await roundCount(tournamentId);
  return prisma.$transaction(async (db) => {
    // Lock the row, then re-read. A plain read is not enough: under READ
    // COMMITTED the forfeit sweep can read the same OPEN row concurrently and
    // both paths then resolve it, so a player who actually ran can be
    // eliminated in favour of a no-show.
    await lockBracketMatchIn(db, m.id);
    const fresh = await db.bracketMatch.findUnique({ where: { id: m.id } });
    if (!fresh || fresh.status !== "OPEN") return null;
    const isA = fresh.aUserId === userId;
    if (isA ? fresh.aPlayed : fresh.bPlayed) return null; // already ran this round

    const log = inputLog ? (inputLog as unknown as Prisma.InputJsonValue) : undefined;
    const data = isA
      ? { aScore: score, aPlayed: true, ...(log !== undefined ? { aInputLog: log } : {}) }
      : { bScore: score, bPlayed: true, ...(log !== undefined ? { bInputLog: log } : {}) };
    const updated = await db.bracketMatch.update({ where: { id: fresh.id }, data });
    if (updated.aPlayed && updated.bPlayed) {
      await db.bracketMatch.update({
        where: { id: fresh.id },
        data: { finishedAt: new Date() },
      });
      await resolveMatchIn(db, updated, rounds);
    }
    return updated;
  });
}

async function roundCount(tournamentId: string): Promise<number> {
  const top = await prisma.bracketMatch.aggregate({
    where: { tournamentId },
    _max: { round: true },
  });
  return top._max.round ?? 1;
}

/**
 * A bracket row as the hot paths read it — without the replay logs, which are
 * omitted from every bulk query. Anything that genuinely needs a log asks for
 * it explicitly rather than widening this.
 */
type BracketMatchRow = Omit<Prisma.BracketMatchGetPayload<object>, "aInputLog" | "bInputLog">;

/**
 * Take a row lock on a bracket match for the rest of the transaction.
 *
 * Five uncoordinated drivers can resolve the same match — the scheduler tick,
 * the submit route, the state endpoint and any tournament page render — and
 * Postgres runs READ COMMITTED, so a bare re-read inside a transaction still
 * lets two of them see the same OPEN row and both decide it. Serialising on
 * the row is what makes "check status, then resolve" actually atomic.
 */
async function lockBracketMatchIn(db: Prisma.TransactionClient, matchId: string): Promise<void> {
  await db.$queryRaw`SELECT id FROM "BracketMatch" WHERE id = ${matchId} FOR UPDATE`;
}

/** Decide a two-player match and advance its winner. Assumes it is unresolved. */
async function resolveMatchIn(
  db: Prisma.TransactionClient,
  m: BracketMatchRow,
  rounds: number
) {
  // Winner: higher score; a no-show loses; a-side breaks a dead tie.
  let winner = m.aUserId!;
  if (m.aPlayed && m.bPlayed) {
    winner = (m.bScore ?? 0) > (m.aScore ?? 0) ? m.bUserId! : m.aUserId!;
  } else if (m.bPlayed && !m.aPlayed) {
    winner = m.bUserId!;
  } else if (m.aPlayed && !m.bPlayed) {
    winner = m.aUserId!;
  }
  await db.bracketMatch.update({
    where: { id: m.id },
    data: { winnerUserId: winner, status: "DONE" },
  });
  await advanceWinnerIn(db, m.tournamentId, m.round, m.slot, winner, rounds);
}

/**
 * Seat the two beaten semifinalists in the third-place match once both
 * semifinals are decided. Idempotent, and a no-op when there is no bronze to
 * play for: a two-player event has no semifinal, and a semifinal reached on a
 * bye has no loser to seat.
 */
async function seatThirdPlaceMatch(
  tournamentId: string,
  all: BracketMatchRow[],
  rounds: number
): Promise<boolean> {
  if (rounds < 2) return false;
  const semis = all.filter((m) => m.round === rounds - 1);
  if (semis.length === 0 || !semis.every((m) => m.status === "DONE")) return false;

  const existing = all.find((m) => m.round === rounds && m.slot === THIRD_PLACE_SLOT);
  if (existing?.aUserId && existing.bUserId) return false; // already seated

  const losers = [...semis]
    .sort((x, y) => x.slot - y.slot)
    .map((m) =>
      m.aUserId && m.bUserId && m.winnerUserId
        ? m.winnerUserId === m.aUserId
          ? m.bUserId
          : m.aUserId
        : null
    );
  const [a, b] = losers;
  if (!a || !b) return false; // a bye reached the semifinal — no third-place match

  await prisma.bracketMatch.upsert({
    where: { tournamentId_round_slot: { tournamentId, round: rounds, slot: THIRD_PLACE_SLOT } },
    create: {
      tournamentId, round: rounds, slot: THIRD_PLACE_SLOT,
      status: "PENDING", aUserId: a, bUserId: b,
    },
    update: { aUserId: a, bUserId: b },
  });
  return true;
}

/**
 * Drive the bracket forward: resolve window-closed matches in the active round
 * (forfeiting no-shows), open the next round once the active one is fully
 * decided, and finalize when the champion is crowned. Safe to call every tick.
 */
export async function advanceKnockout(tournamentId: string): Promise<void> {
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!t || t.format !== "KNOCKOUT" || t.status !== "RUNNING" || !t.bracketStartedAt) return;

  let all = await prisma.bracketMatch.findMany({
    omit: { aInputLog: true, bInputLog: true },
    where: { tournamentId },
    orderBy: [{ round: "asc" }, { slot: "asc" }],
  });
  if (all.length === 0) return;
  const rounds = Math.max(...all.map((m) => m.round));

  // The bronze match must exist before the final round is opened so both play
  // on the same round seed.
  if (await seatThirdPlaceMatch(tournamentId, all, rounds)) {
    all = await prisma.bracketMatch.findMany({
    omit: { aInputLog: true, bInputLog: true },
      where: { tournamentId },
      orderBy: [{ round: "asc" }, { slot: "asc" }],
    });
  }

  for (let r = 1; r <= rounds; r++) {
    const matches = all.filter((m) => m.round === r);
    if (matches.every((m) => m.status === "DONE")) continue;

    // This is the active round. Open it if the feeders just filled it.
    const needsOpen = matches.some((m) => m.status === "PENDING" && m.aUserId && m.bUserId);
    if (needsOpen) {
      const seed = newSeed();
      const hash = sha256(seed);
      const now = new Date();
      await prisma.bracketMatch.updateMany({
        // Both sides must be present — a half-filled slot stays PENDING until
        // its feeder lands.
        where: {
          tournamentId, round: r, status: "PENDING",
          aUserId: { not: null }, bUserId: { not: null },
        },
        data: { seed, seedHash: hash, openedAt: now, startedAt: now, status: "OPEN" },
      });
      // Re-read this round so window logic sees the freshly opened matches.
      matches.forEach((m) => {
        if (m.status === "PENDING" && m.aUserId && m.bUserId) {
          m.status = "OPEN";
          m.openedAt = now;
        }
      });
    }

    // Force-resolve any OPEN match whose window has closed, or where both
    // played. Round 1 gets the longer ready-up window; later rounds are quicker.
    const windowMs = (r === 1 ? t.readyWindowS : t.roundDurationS) * 1000;
    for (const m of matches) {
      if (m.status !== "OPEN") continue;
      // Lock, then re-read, so a run submitted since the tick's snapshot is
      // never lost to a forfeit — and so two concurrent drivers cannot both
      // decide the same match.
      await prisma.$transaction(async (db) => {
        await lockBracketMatchIn(db, m.id);
        const fresh = await db.bracketMatch.findUnique({ where: { id: m.id } });
        if (!fresh || fresh.status !== "OPEN") return;
        const closed = fresh.openedAt != null && Date.now() >= fresh.openedAt.getTime() + windowMs;
        if (!(fresh.aPlayed && fresh.bPlayed) && !closed) return;
        await resolveMatchIn(db, fresh, rounds);
      });
    }
    return; // one active round per tick
  }

  // Every round resolved → crown and pay out.
  await finalizeKnockout(tournamentId);
}

/**
 * Assign final placements from the bracket and settle prizes.
 *
 * Ranks 1–2 come from the final and ranks 3–4 from the third-place match. Below
 * that a player's rank is set by how deep they went — quarterfinal losers 5th
 * onward — with ties inside a depth breaking on the score they lost with.
 * Prizes follow the tournament's published structure; leftover pool becomes
 * rake. Idempotent, and refuses to settle until the bronze match is also done.
 */
export async function finalizeKnockout(tournamentId: string): Promise<void> {
  const t = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    include: { entries: true },
  });
  if (!t || t.format !== "KNOCKOUT") return;
  if (t.status === "FINISHED" || t.status === "CANCELLED") return;

  const matches = await prisma.bracketMatch.findMany({
    where: { tournamentId },
    // Replay logs are kilobytes each and this reads every row of the bracket on
    // every poll. Leaving them out keeps the hot path narrow; the replay loader
    // asks for them explicitly.
    omit: { aInputLog: true, bInputLog: true },
  });
  if (matches.length === 0) return;
  const rounds = Math.max(...matches.map((m) => m.round));
  const final = matches.find((m) => m.round === rounds && m.slot === 0);
  if (!final || final.status !== "DONE" || !final.winnerUserId) return; // not over yet
  const bronze = matches.find((m) => m.round === rounds && m.slot === THIRD_PLACE_SLOT);
  if (bronze && bronze.status !== "DONE") return; // third place still to be played

  const ranked: string[] = [];
  const seen = new Set<string>();
  const place = (userId: string | null | undefined) => {
    if (userId && !seen.has(userId)) {
      seen.add(userId);
      ranked.push(userId);
    }
  };

  // The podium is decided head-to-head.
  place(final.winnerUserId);
  place(final.winnerUserId === final.aUserId ? final.bUserId : final.aUserId);
  if (bronze?.winnerUserId) {
    place(bronze.winnerUserId);
    place(bronze.winnerUserId === bronze.aUserId ? bronze.bUserId : bronze.aUserId);
  }

  // Everyone else by the round they went out in (deeper = better), then by the
  // score they lost with. Semifinal losers are already placed by the bronze
  // match when one was played.
  const fromRound = bronze?.winnerUserId ? rounds - 2 : rounds - 1;
  for (let r = fromRound; r >= 1; r--) {
    const losers = matches
      .filter((m) => m.round === r && m.winnerUserId && m.bUserId) // real 2-player matches
      .map((m) => {
        const loser = m.winnerUserId === m.aUserId ? m.bUserId! : m.aUserId!;
        const loserScore = m.winnerUserId === m.aUserId ? m.bScore ?? -1 : m.aScore ?? -1;
        return { loser, loserScore };
      })
      .sort((x, y) => y.loserScore - x.loserScore);
    for (const l of losers) place(l.loser);
  }

  const structure = t.prizeStructure as { rank: number; shareBps: number }[];
  const pool = await getBalanceTetri(prisma, AccountKeys.tournamentEscrow(tournamentId));
  const prizePool = Math.max(pool, t.guaranteeTetri);

  const winners: { userId: string; prizeTetri: number }[] = [];
  for (const s of structure) {
    const userId = ranked[s.rank - 1];
    if (!userId) continue;
    winners.push({ userId, prizeTetri: Math.floor((prizePool * s.shareBps) / 10_000) });
  }

  // A full 60-player field writes a rank row per entrant plus the settlement
  // entries — well over Prisma's default 5s interactive-transaction budget on a
  // remote database. Timing out would roll back the payout and leave the pool
  // escrowed with the event stuck RUNNING.
  await prisma.$transaction(
    async (db) => {
      if (pool > 0 || winners.length > 0) {
        await settleTournamentIn(db, tournamentId, pool, winners);
      }
      for (let i = 0; i < ranked.length; i++) {
        const win = winners.find((w) => w.userId === ranked[i]);
        await db.tournamentEntry.update({
          where: { tournamentId_userId: { tournamentId, userId: ranked[i]! } },
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

/**
 * Cancel a tournament and make every entrant whole: refund the escrowed pool
 * from escrow and mark it cancelled. Idempotent.
 */
export async function cancelTournamentRefunding(tournamentId: string): Promise<void> {
  const t = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    include: { entries: true },
  });
  if (!t || t.status === "FINISHED" || t.status === "CANCELLED") return;

  const pool = await getBalanceTetri(prisma, AccountKeys.tournamentEscrow(tournamentId));
  const refund = t.entries.length > 0 ? Math.floor(pool / t.entries.length) : 0;
  const winners = t.entries.map((e) => ({ userId: e.userId, prizeTetri: refund }));

  // Refunding a full field posts an entry per entrant; the default 5s budget
  // is not enough, and a rollback here strands everyone's stake.
  await prisma.$transaction(
    async (db) => {
      if (pool > 0) await settleTournamentIn(db, tournamentId, pool, winners);
      await db.tournament.update({
        where: { id: tournamentId },
        data: { status: "CANCELLED", finishedAt: new Date() },
      });
    },
    { timeout: 20_000 }
  );
}

export interface BracketMatchView {
  slot: number;
  matchId: string;
  a: string | null;
  b: string | null;
  aScore: number | null;
  bScore: number | null;
  winner: string | null;
  status: string;
  /** Both sides played, so the match can be watched back. */
  hasReplay: boolean;
}

export interface KnockoutView {
  rounds: {
    round: number;
    label: string;
    matches: BracketMatchView[];
  }[];
  /** The bronze match, once both semifinals are decided. */
  thirdPlace: BracketMatchView | null;
  myMatch: {
    round: number;
    label: string;
    seed: string | null;
    opponent: string | null;
    closesAt: string | null;
    isThirdPlace: boolean;
  } | null;
}

function roundLabel(round: number, rounds: number): string {
  const fromTop = rounds - round; // 0 = final
  if (fromTop === 0) return "Final";
  if (fromTop === 1) return "Semifinals";
  if (fromTop === 2) return "Quarterfinals";
  const players = 2 ** (fromTop + 1);
  return `Round of ${players}`;
}

/** Bracket snapshot for the tournament page, resolving user ids to usernames. */
export async function knockoutView(
  tournamentId: string,
  viewerId: string,
  roundDurationS: number,
  readyWindowS: number = roundDurationS
): Promise<KnockoutView | null> {
  const matches = await prisma.bracketMatch.findMany({
    omit: { aInputLog: true, bInputLog: true },
    where: { tournamentId },
    orderBy: [{ round: "asc" }, { slot: "asc" }],
  });
  if (matches.length === 0) return null;
  const rounds = Math.max(...matches.map((m) => m.round));

  const ids = new Set<string>();
  for (const m of matches) {
    if (m.aUserId) ids.add(m.aUserId);
    if (m.bUserId) ids.add(m.bUserId);
  }
  const users = await prisma.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, username: true },
  });
  const name = new Map(users.map((u) => [u.id, u.username]));

  const toView = (m: (typeof matches)[number]): BracketMatchView => ({
    slot: m.slot,
    matchId: m.id,
    // Both sides played, so both logs exist and the match can be watched back.
    hasReplay: m.status === "DONE" && m.aPlayed && m.bPlayed,
    a: m.aUserId ? name.get(m.aUserId) ?? "—" : null,
    b: m.bUserId ? name.get(m.bUserId) ?? "—" : null,
    aScore: m.aScore,
    bScore: m.bScore,
    winner: m.winnerUserId ? name.get(m.winnerUserId) ?? null : null,
    status: m.status,
  });

  const isBronze = (m: { round: number; slot: number }) =>
    m.round === rounds && m.slot === THIRD_PLACE_SLOT;

  const roundViews = [];
  for (let r = 1; r <= rounds; r++) {
    roundViews.push({
      round: r,
      label: roundLabel(r, rounds),
      // The bronze match rides in the final's round but is shown on its own.
      matches: matches.filter((m) => m.round === r && !isBronze(m)).map(toView),
    });
  }
  const bronzeRow = matches.find(isBronze);

  const mine = await currentKnockoutMatch(tournamentId, viewerId);
  const myMatch = mine
    ? {
        round: mine.round,
        label: isBronze(mine) ? "Third place" : roundLabel(mine.round, rounds),
        isThirdPlace: isBronze(mine),
        seed: mine.seed,
        opponent: (() => {
          const oppId = mine.aUserId === viewerId ? mine.bUserId : mine.aUserId;
          return oppId ? name.get(oppId) ?? null : null;
        })(),
        closesAt: mine.openedAt
          ? new Date(
              mine.openedAt.getTime() + (mine.round === 1 ? readyWindowS : roundDurationS) * 1000
            ).toISOString()
          : null,
      }
    : null;

  return {
    rounds: roundViews,
    thirdPlace: bronzeRow ? toView(bronzeRow) : null,
    myMatch,
  };
}
