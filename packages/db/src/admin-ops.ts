/**
 * Operations layer for the admin console.
 *
 * Everything an operator can do to a tournament, a match, a player or the
 * platform lives here, so the API routes stay thin: parse, authorise, call one
 * of these, serialise the result. The rules the whole file is built on:
 *
 *   1. Money moves through the ledger or it does not move. Nothing here writes
 *      Account.balanceTetri, and every refund is a balanced posting. An admin
 *      tool that could break double-entry would make the entire wallet
 *      unauditable, which is worse than any bug it was built to fix.
 *   2. Anything that moves money is idempotent. Admin actions are triggered by
 *      buttons, and buttons get double-clicked.
 *   3. Force-resolving a match reuses the engine's own resolution, never a
 *      second copy of it. An operator hurrying a stalled round must not be able
 *      to produce a different winner than simply waiting would have.
 *   4. Destructive operations refuse rather than guess. Removing an entrant
 *      from a drawn bracket, or "resetting" an event whose prizes are already
 *      in players' wallets, has no correct behaviour — so it throws with a
 *      message an operator can act on.
 */

import { Prisma, type TournamentStatus } from "@prisma/client";
import {
  AWAITING_PLAYERS_AT,
  KNOCKOUT_CONFIG,
  SIGNUP_CREDIT_TETRI,
  lariToTetri,
} from "@gamearena/shared";
import { prisma } from "./client";
import {
  AccountKeys,
  getBalanceTetri,
  postTransaction,
  postTransactionIn,
} from "./ledger";
import {
  THIRD_PLACE_SLOT,
  advanceKnockout,
  advanceWinnerIn,
  cancelTournamentRefunding,
  finalizeKnockout,
  knockoutRoundLabel,
  lockBracketMatchIn,
  resolveMatchIn,
} from "./bracket";
import { finalizeTournament } from "./tournaments";
import { sweepBotBalances } from "./tournament-bots";

/**
 * Ceiling on a single hand-typed balance adjustment (₾5,000).
 *
 * Belt and braces with the route's own Zod bound: a slipped decimal point
 * should bounce at whichever layer sees it first, and the operations layer is
 * the one that cannot be forgotten. Exported so the API reuses this number
 * rather than inventing a second, different limit.
 */
export const ADMIN_ADJUSTMENT_MAX_TETRI = lariToTetri(5_000);

/** A player counts as online this long after their last recorded activity. */
export const ONLINE_WINDOW_MS = 5 * 60_000;

/** Health probes must fail fast — an admin page cannot wait on a dead host. */
const REALTIME_HEALTH_TIMEOUT_MS = 1_500;

// ─────────────────────────── Shared internals ───────────────────────────

/**
 * Undo a tournament entry: return what the player actually paid, free the join
 * for a genuine re-entry, and drop the entry row. Returns the refunded tetri.
 *
 * Two details here are the whole reason this is a shared helper rather than
 * inline code in two places.
 *
 * First, the refund is the amount THIS player actually escrowed, read back off
 * their own entry transaction — not the tournament's current `entryTetri`. If
 * the fee was edited after they joined, refunding today's price would either
 * short them or quietly drain the pool of somebody else's stake.
 *
 * Second, the entry charge's idempotency key is retired rather than left
 * behind. `registerTournamentEntryIn` keys on `tourney-entry:<tid>:<uid>`,
 * which is permanent — so a player who was removed and then re-joined would hit
 * the existing key, be seated WITHOUT being charged, and play the event for
 * free while the escrow silently ran a stake short. Renaming the key to a
 * `voided:` form keeps the transaction, its amounts and its history exactly as
 * posted (the ledger still balances to the tetri) while releasing the token
 * whose job — "don't charge this join twice" — has been explicitly reversed.
 */
async function releaseEntryIn(
  db: Prisma.TransactionClient,
  tournamentId: string,
  userId: string,
  joinedAt: Date,
  /** Where the money goes back to — the player's cash, or treasury for a bot. */
  destinationAccountKey: string,
  memo: string
): Promise<number> {
  const entryKey = `tourney-entry:${tournamentId}:${userId}`;
  const escrowKey = AccountKeys.tournamentEscrow(tournamentId);

  const charge = await db.ledgerTransaction.findUnique({
    where: { idempotencyKey: entryKey },
    include: { entries: { include: { account: true } } },
  });
  // A free entry posts no transaction at all, so there is nothing to give back.
  const escrowed =
    charge?.entries.find((e) => e.account.key === escrowKey)?.amountTetri ?? 0;

  if (escrowed > 0) {
    await postTransactionIn(db, {
      kind: "TOURNAMENT_ENTRY",
      memo,
      refType: "tournament",
      refId: tournamentId,
      // Scoped to this seat-taking, not just this pairing: a player who is
      // removed, re-joins and is removed again has a new `joinedAt` and so a
      // new key, while a double-clicked single removal keeps the same one.
      idempotencyKey: `admin-release-entry:${tournamentId}:${userId}:${joinedAt.getTime()}`,
      entries: [
        { accountKey: escrowKey, amountTetri: -escrowed },
        { accountKey: destinationAccountKey, amountTetri: escrowed },
      ],
    });
  }

  if (charge) {
    await db.ledgerTransaction.update({
      where: { id: charge.id },
      data: { idempotencyKey: `voided:${entryKey}:${joinedAt.getTime()}` },
    });
  }

  await db.tournamentEntry.deleteMany({ where: { tournamentId, userId } });
  return escrowed;
}

/**
 * The tournament, guaranteed to exist and to be in one of `allowed` states.
 *
 * Errors name the state the event is actually in, because "cannot do that" with
 * no reason is what sends an operator to a database console.
 */
async function requireTournamentIn(tournamentId: string, allowed: TournamentStatus[]) {
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!t) throw new Error("Tournament not found");
  if (!allowed.includes(t.status)) {
    throw new Error(
      `This tournament is ${t.status}; that is only possible while it is ${allowed.join(" or ")}.`
    );
  }
  return t;
}

/** Deepest round in a bracket — 1 when it has not been drawn. */
async function roundCountOf(tournamentId: string): Promise<number> {
  const top = await prisma.bracketMatch.aggregate({
    where: { tournamentId },
    _max: { round: true },
  });
  return top._max.round ?? 1;
}

/** Usernames for a set of ids, as a lookup. Missing ids simply do not appear. */
async function usernamesFor(ids: Iterable<string>): Promise<Map<string, string>> {
  const list = [...new Set([...ids])];
  if (list.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: list } },
    select: { id: true, username: true },
  });
  return new Map(users.map((u) => [u.id, u.username]));
}

// ─────────────────────────── Tournament ops ───────────────────────────

export interface RemoveBotsResult {
  removed: number;
  refundedTetri: number;
  /** Seats now taken, after the removal. */
  entryCount: number;
  capacity: number;
  /** True when the fill countdown was cancelled and registration re-opened. */
  registrationReopened: boolean;
}

/**
 * Take every bot back out of a tournament that has not been drawn yet.
 *
 * The refund goes to TREASURY, not to the bot's wallet. A bot's entry fee was
 * minted from treasury in the first place (`fillTournamentWithBots`), so
 * returning it there completes the round trip and leaves the bot holding
 * nothing — the same invariant `sweepBotBalances` maintains after a settled
 * event. Paying it into the bot's cash account instead would satisfy
 * double-entry but leave fake money parked on accounts nobody audits.
 *
 * SCHEDULED only. Once a bracket is drawn, bots occupy real slots that real
 * players have already been paired against, and pulling one out would leave a
 * live match with a missing opponent and no rule for what happens next.
 */
export async function removeBotsFromTournament(tournamentId: string): Promise<RemoveBotsResult> {
  const t = await requireTournamentIn(tournamentId, ["SCHEDULED"]);

  // Belt and braces: status is the contract, but a stray bracket row means the
  // draw has happened regardless of what the status column says.
  const drawn = await prisma.bracketMatch.count({ where: { tournamentId } });
  if (drawn > 0) {
    throw new Error(
      "The bracket for this tournament has already been drawn — reset it first if you need to change the field."
    );
  }

  const botEntries = await prisma.tournamentEntry.findMany({
    where: { tournamentId, user: { isBot: true } },
    select: { userId: true, joinedAt: true },
  });

  const before = await prisma.tournamentEntry.count({ where: { tournamentId } });

  // Stop the countdown FIRST, before a single refund runs.
  //
  // Filling the last seat sets startsAt to now + countdownS, and the scheduler
  // draws any SCHEDULED event whose startsAt has passed, every few seconds.
  // Refunding sixty bots is sixty sequential transactions — comfortably longer
  // than the countdown — so cancelling it afterwards left a window where the
  // bracket got drawn over a field being deleted underneath it. That produces
  // BracketMatch rows pointing at users with no TournamentEntry, and settlement
  // then throws on every attempt: the event can never pay out, including the
  // human stakes in a live-override fill.
  //
  // Doing it first also fails in the safe direction. If this call dies partway
  // through, registration is open on a partly-emptied field, which an operator
  // can see and finish — rather than a drawn bracket that cannot settle.
  const willReopen = t.format === "KNOCKOUT" && before >= t.capacity && botEntries.length > 0;
  if (willReopen) {
    await prisma.tournament.update({
      where: { id: tournamentId },
      data: { startsAt: AWAITING_PLAYERS_AT },
    });
  }

  let refundedTetri = 0;

  for (const entry of botEntries) {
    // One transaction per bot rather than one for all of them: a 60-seat field
    // would otherwise be a single very long interactive transaction, and a
    // timeout partway through would roll back refunds that had already been
    // reported. Per-bot, an interruption leaves a clean partial state that
    // simply re-running finishes.
    refundedTetri += await prisma.$transaction(async (db) =>
      releaseEntryIn(
        db,
        tournamentId,
        entry.userId,
        entry.joinedAt,
        AccountKeys.treasury(),
        "Bot seat withdrawn by admin"
      )
    );
  }

  // Recount rather than subtract from the pre-loop snapshot. The refund loop is
  // deliberately one transaction per bot, so an interruption partway through
  // frees some seats and not others; re-running has to converge on what the
  // table actually says, not on arithmetic done before any of it happened.
  const [after, botsRemaining] = await Promise.all([
    prisma.tournamentEntry.count({ where: { tournamentId } }),
    prisma.tournamentEntry.count({ where: { tournamentId, user: { isBot: true } } }),
  ]);

  // The countdown was already cancelled above, before any money moved. This
  // only reports whether that happened.
  const registrationReopened = willReopen && after < t.capacity;

  // Provenance is written absolutely, and is written even when this call removed
  // nothing. A decrement against a stale read can drift, and a run interrupted
  // after the refunds but before this update would otherwise leave an emptied
  // event permanently claiming it was padded with bots: the retry would find no
  // bots to remove and skip the correction forever. Recomputing from the live
  // count instead means any second call repairs the record.
  const provenanceStale =
    t.botsSeated !== botsRemaining || (botsRemaining === 0 && t.botFilledAt !== null);

  if (provenanceStale || registrationReopened) {
    await prisma.tournament.update({
      where: { id: tournamentId },
      data: {
        // Provenance follows the field: with the bots gone this is a clean
        // human event again, and an "was padded with bots" marker left standing
        // would misreport the prize pool's origin.
        botsSeated: botsRemaining,
        ...(botsRemaining === 0 ? { botFilledAt: null } : {}),
        // startsAt is deliberately absent: it was reset before the refunds ran.
      },
    });
  }

  return {
    removed: botEntries.length,
    refundedTetri,
    entryCount: after,
    capacity: t.capacity,
    registrationReopened,
  };
}

export interface RemovePlayerResult {
  /**
   * Where the entry fee went. A bot's fee returns to treasury, because that is
   * where it was minted from — the route reports this so it cannot tell an
   * operator a bot was "refunded to the player".
   */
  refundedTo?: "player" | "treasury";
  refundedTetri: number;
  /** False when there was nothing to remove — a repeat call, or a wrong id. */
  removed: boolean;
}

/**
 * Take one entrant out of a tournament that has not been drawn, refunding what
 * they paid into their cash balance.
 *
 * SCHEDULED only, for the same reason bot removal is: a drawn bracket has
 * already paired this person against someone.
 *
 * Idempotent per (tournament, user) — a second call finds no entry and reports
 * `removed: false` rather than paying a second refund, and the ledger key
 * backstops that even if the entry row somehow came back.
 */
export async function removePlayerFromTournament(
  tournamentId: string,
  userId: string
): Promise<RemovePlayerResult> {
  await requireTournamentIn(tournamentId, ["SCHEDULED"]);

  const entry = await prisma.tournamentEntry.findUnique({
    where: { tournamentId_userId: { tournamentId, userId } },
    select: { joinedAt: true },
  });
  if (!entry) return { refundedTetri: 0, removed: false };

  // Where the money goes depends on where it came from.
  //
  // A human paid their entry out of their own balance, so it goes back there. A
  // bot's fee was minted from treasury, so returning it to the bot's wallet
  // would strand fake money on an account nothing settles — and sweepBotBalances
  // cannot recover it, because that only visits bots which still hold an entry
  // and this removes the entry. removeBotsFromTournament already routes to
  // treasury for exactly this reason; the single-player path has to agree.
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { isBot: true },
  });
  const isBot = target?.isBot === true;

  const refundedTetri = await prisma.$transaction(async (db) =>
    releaseEntryIn(
      db,
      tournamentId,
      userId,
      entry.joinedAt,
      isBot ? AccountKeys.treasury() : AccountKeys.userCash(userId),
      isBot ? "Bot seat withdrawn by admin" : "Tournament entry withdrawn by admin"
    )
  );

  return { refundedTetri, removed: true, refundedTo: isBot ? "treasury" : "player" };
}

export interface ForceAdvanceResult {
  /** The round the forced match was in. */
  round: number;
  roundLabel: string;
  bracketMatchId: string;
  /** Where they landed, or null when they just won the whole thing. */
  advancedTo: { round: number; slot: number } | null;
}

/**
 * Push a player through their current match in a running knockout.
 *
 * The support tool for a match that cannot resolve itself — a crashed client,
 * a player whose run was lost, an opponent who will demonstrably never appear.
 * It resolves the pairing in the named player's favour immediately and lets the
 * ordinary driver take it from there.
 */
export async function forceAdvancePlayer(
  tournamentId: string,
  userId: string
): Promise<ForceAdvanceResult> {
  await requireTournamentIn(tournamentId, ["RUNNING"]);

  // Their live pairing, whether or not they have already played it — an
  // operator forcing someone through is usually doing it precisely because the
  // match is stuck after one side ran.
  const match = await prisma.bracketMatch.findFirst({
    where: {
      tournamentId,
      status: "OPEN",
      OR: [{ aUserId: userId }, { bUserId: userId }],
    },
    orderBy: { round: "asc" },
    select: { id: true },
  });
  if (!match) {
    throw new Error("That player has no open match in this tournament right now.");
  }

  const decided = await declareMatchWinner(match.id, userId);
  return {
    round: decided.round,
    roundLabel: decided.roundLabel,
    bracketMatchId: decided.bracketMatchId,
    advancedTo: decided.advancedTo,
  };
}

export interface ResetTournamentResult {
  deletedMatches: number;
  /** Seats still taken — entries and their escrow are deliberately untouched. */
  entryCount: number;
  escrowTetri: number;
}

/**
 * Throw the bracket away and put the event back in the lobby.
 *
 * This is "redraw", not "refund": entries stay, escrow stays, and the same
 * field will be paired again on a fresh seed. Only the bracket is destroyed.
 *
 * It refuses on a FINISHED or CANCELLED event, and that refusal is the whole
 * safety story. Those events have already settled — the prize money is in
 * players' wallets and the escrow is empty. Redrawing one would produce a
 * bracket with no pool behind it, and the settlement key `tourney-settle:<id>`
 * would then block the second payout, so the new champion would win nothing
 * while the old one kept everything. There is no version of that an operator
 * wants, so it is not offered.
 */
export async function resetTournament(tournamentId: string): Promise<ResetTournamentResult> {
  const t = await requireTournamentIn(tournamentId, ["SCHEDULED", "RUNNING"]);

  const escrowTetri = await getBalanceTetri(
    prisma,
    AccountKeys.tournamentEscrow(tournamentId)
  );

  const { deletedMatches, entryCount } = await prisma.$transaction(async (db) => {
    const deleted = await db.bracketMatch.deleteMany({ where: { tournamentId } });
    // Placings and prize columns describe a bracket that no longer exists.
    // Leaving them would have the tournament page show finishing positions for
    // an event that is back in registration.
    await db.tournamentEntry.updateMany({
      where: { tournamentId },
      data: { rank: null, prizeTetri: null },
    });
    const entries = await db.tournamentEntry.count({ where: { tournamentId } });
    await db.tournament.update({
      where: { id: tournamentId },
      data: {
        status: "SCHEDULED",
        bracketStartedAt: null,
        seed: null,
        seedHash: null,
        finishedAt: null,
// Where the clock lands depends on whether the field is still full.
        //
        // An empty-ish field parks on the "waiting for players" sentinel so the
        // poll driver does not instantly redraw what an operator just cleared.
        // A FULL field cannot use that sentinel: the draw is triggered by a
        // join, and a full tournament refuses joins, so startsAt would sit in
        // 2099 forever. Worse, the lobby keeper picks the oldest SCHEDULED
        // knockout and stops when it is full — so a reset 32-player event would
        // freeze tournament registration for the entire platform until someone
        // noticed. A full field therefore gets a fresh countdown instead.
        startsAt: entries >= t.capacity ? new Date(Date.now() + KNOCKOUT_CONFIG.countdownS * 1000) : AWAITING_PLAYERS_AT,
      },
    });
    return { deletedMatches: deleted.count, entryCount: entries };
  });

  return { deletedMatches, entryCount, escrowTetri };
}

export interface EndTournamentResult {
  status: TournamentStatus;
  /** Matches an operator's impatience decided rather than the players. */
  forcedMatches: number;
  /** Bot winnings returned to treasury after settlement. */
  botTetriRecovered: number;
}

/**
 * Settle a running tournament right now.
 *
 * Settlement itself is NOT reimplemented here — `finalizeKnockout` and
 * `finalizeTournament` remain the only code that ranks a field and pays it out.
 * What this adds is getting the bracket into a state they will accept:
 * `finalizeKnockout` refuses to pay out until the final is decided, so every
 * still-open match is resolved on its current scores, by the engine's own rule,
 * round after round until the champion exists.
 *
 * Bot balances are swept back to treasury afterwards — bots are ranked and paid
 * exactly like humans (skipping them would hand a beaten human the champion's
 * prize), so the money genuinely lands in their accounts and is returned in a
 * separate step, never inside the settlement transaction.
 */
export async function endTournamentNow(tournamentId: string): Promise<EndTournamentResult> {
  const t = await requireTournamentIn(tournamentId, ["RUNNING"]);

  let forcedMatches = 0;

  if (t.format === "KNOCKOUT") {
    // Each pass resolves the open round and lets advanceKnockout open the next
    // one — it deliberately drives a single round per call. The bound is a
    // safety net, not a schedule: even a 1024-seat bracket is ten rounds, so
    // exhausting it means the bracket cannot converge and the check below says
    // so out loud instead of hanging.
    for (let pass = 0; pass < 40; pass++) {
      const open = await prisma.bracketMatch.findMany({
        where: { tournamentId, status: "OPEN" },
        select: { id: true },
      });
      for (const m of open) {
        const resolved = await resolveOpenMatchOnScores(tournamentId, m.id);
        if (resolved) forcedMatches++;
      }

      // Opens the next round, seats the bronze match, and finalizes once
      // everything is decided.
      await advanceKnockout(tournamentId);

      const current = await prisma.tournament.findUnique({
        where: { id: tournamentId },
        select: { status: true },
      });
      if (current?.status !== "RUNNING") break;

      const stillOpen = await prisma.bracketMatch.count({
        where: { tournamentId, status: "OPEN" },
      });
      if (stillOpen === 0 && open.length === 0) {
        // Nothing was open before this pass and nothing opened during it, so
        // the bracket is wedged — advanceKnockout has no more moves to make.
        break;
      }
    }
    await finalizeKnockout(tournamentId);
  } else {
    await finalizeTournament(tournamentId);
  }

  const after = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { status: true },
  });
  if (after?.status === "RUNNING") {
    // Almost always a slot that can never fill — a bye chain that left a
    // next-round match with one side permanently empty. Say that, rather than
    // reporting success on an event that is still running.
    const undecided = await prisma.bracketMatch.count({
      where: { tournamentId, status: { not: "DONE" } },
    });
    throw new Error(
      `Could not settle: ${undecided} match(es) are still undecided and the bracket cannot advance on its own. Reset the bracket, or cancel and refund the field.`
    );
  }

  const botTetriRecovered = await sweepBotBalances(tournamentId);
  return {
    status: after?.status ?? "FINISHED",
    forcedMatches,
    botTetriRecovered,
  };
}

export interface CancelTournamentResult {
  status: TournamentStatus;
  refundedTetri: number;
  refundedEntries: number;
  botTetriRecovered: number;
}

/**
 * Cancel an event and make every entrant whole.
 *
 * Reuses `cancelTournamentRefunding`, which splits the escrowed pool evenly
 * across the field and is idempotent, so a double-click cannot refund twice.
 * Bots are refunded like everyone else and then swept back to treasury.
 */
export async function cancelTournamentNow(tournamentId: string): Promise<CancelTournamentResult> {
  await requireTournamentIn(tournamentId, ["SCHEDULED", "RUNNING"]);

  // Read the pool before it empties — afterwards there is nothing left to
  // report, and an operator needs to see what actually went back.
  const refundedTetri = await getBalanceTetri(
    prisma,
    AccountKeys.tournamentEscrow(tournamentId)
  );
  const refundedEntries = await prisma.tournamentEntry.count({ where: { tournamentId } });

  await cancelTournamentRefunding(tournamentId);
  const botTetriRecovered = await sweepBotBalances(tournamentId);

  const after = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { status: true },
  });
  return {
    status: after?.status ?? "CANCELLED",
    refundedTetri,
    refundedEntries,
    botTetriRecovered,
  };
}

// ─────────────────────────── Match ops ───────────────────────────

export interface ActiveMatchPlayer {
  userId: string;
  username: string;
  score: number | null;
  /** Bracket matches only: whether this side has taken their run yet. */
  played: boolean;
  isBot: boolean;
}

export interface ActiveMatchView {
  /** BRACKET = a knockout pairing; DUEL = a 1v1 staked match. */
  kind: "BRACKET" | "DUEL";
  id: string;
  tournamentId: string | null;
  tournamentName: string | null;
  round: number | null;
  /** "Final", "Semifinals", "Third place", or "1v1" for a duel. */
  roundLabel: string;
  a: ActiveMatchPlayer | null;
  b: ActiveMatchPlayer | null;
  /** Duels only — what is sitting in escrow on this match. */
  stakeTetri: number | null;
  startedAt: Date | null;
  /** When the play window shuts, or null when nothing has started the clock. */
  closesAt: Date | null;
}

/**
 * Everything currently in play, in one list: open bracket matches across every
 * running tournament, plus live 1v1 duels.
 *
 * "Live" for a duel means WAITING or ACTIVE — a match sitting in WAITING still
 * holds a player's stake in escrow, so an operator looking for stuck money
 * needs to see it. SETTLED and CANCELLED are done; HOLD is escrow deliberately
 * frozen for anti-cheat review and belongs on the review screen, not here.
 */
export async function listActiveMatches(): Promise<ActiveMatchView[]> {
  const [running, duels] = await Promise.all([
    prisma.tournament.findMany({
      where: { status: "RUNNING" },
      select: { id: true, name: true, roundDurationS: true, readyWindowS: true },
    }),
    prisma.match.findMany({
      where: { status: { in: ["WAITING", "ACTIVE"] } },
      select: {
        id: true,
        stakeTetri: true,
        potTetri: true,
        startedAt: true,
        createdAt: true,
        game: { select: { durationS: true } },
        players: {
          select: {
            userId: true,
            serverScore: true,
            user: { select: { username: true, isBot: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const tournamentIds = running.map((t) => t.id);
  const bracketRows = tournamentIds.length
    ? await prisma.bracketMatch.findMany({
        where: { tournamentId: { in: tournamentIds }, status: "OPEN" },
        select: {
          id: true, tournamentId: true, round: true, slot: true, openedAt: true,
          aUserId: true, bUserId: true, aScore: true, bScore: true,
          aPlayed: true, bPlayed: true,
        },
        orderBy: [{ round: "desc" }, { slot: "asc" }],
      })
    : [];

  // How deep each running bracket is, so a round can be named. One grouped
  // query rather than one per match — an admin console that got slower as the
  // platform got busier would stop being opened at exactly the wrong moment.
  const depths = tournamentIds.length
    ? await prisma.bracketMatch.groupBy({
        by: ["tournamentId"],
        where: { tournamentId: { in: tournamentIds } },
        _max: { round: true },
      })
    : [];
  const depthOf = new Map(depths.map((d) => [d.tournamentId, d._max.round ?? 1]));
  const tournamentById = new Map(running.map((t) => [t.id, t]));

  const playerIds = new Set<string>();
  for (const m of bracketRows) {
    if (m.aUserId) playerIds.add(m.aUserId);
    if (m.bUserId) playerIds.add(m.bUserId);
  }
  const bracketUsers = playerIds.size
    ? await prisma.user.findMany({
        where: { id: { in: [...playerIds] } },
        select: { id: true, username: true, isBot: true },
      })
    : [];
  const userById = new Map(bracketUsers.map((u) => [u.id, u]));

  const views: ActiveMatchView[] = [];

  for (const m of bracketRows) {
    const t = tournamentById.get(m.tournamentId);
    if (!t) continue;
    const rounds = depthOf.get(m.tournamentId) ?? 1;
    const isThirdPlace = m.round === rounds && m.slot === THIRD_PLACE_SLOT;
    // Round 1 gets the longer ready-up window; later rounds the round window.
    const windowS = m.round === 1 ? t.readyWindowS : t.roundDurationS;

    const side = (
      userId: string | null,
      score: number | null,
      played: boolean
    ): ActiveMatchPlayer | null => {
      if (!userId) return null;
      const u = userById.get(userId);
      return {
        userId,
        username: u?.username ?? "—",
        score,
        played,
        isBot: u?.isBot ?? false,
      };
    };

    views.push({
      kind: "BRACKET",
      id: m.id,
      tournamentId: m.tournamentId,
      tournamentName: t.name,
      round: m.round,
      roundLabel: isThirdPlace ? "Third place" : knockoutRoundLabel(m.round, rounds),
      a: side(m.aUserId, m.aScore, m.aPlayed),
      b: side(m.bUserId, m.bScore, m.bPlayed),
      stakeTetri: null,
      startedAt: m.openedAt,
      closesAt: m.openedAt ? new Date(m.openedAt.getTime() + windowS * 1000) : null,
    });
  }

  for (const m of duels) {
    const side = (index: 0 | 1): ActiveMatchPlayer | null => {
      const p = m.players[index];
      if (!p) return null;
      return {
        userId: p.userId,
        username: p.user.username,
        score: p.serverScore,
        // A duel has no per-side "has run yet" flag; a posted server score is
        // the equivalent signal.
        played: p.serverScore != null,
        isBot: p.user.isBot,
      };
    };

    views.push({
      kind: "DUEL",
      id: m.id,
      tournamentId: null,
      tournamentName: null,
      round: null,
      roundLabel: "1v1",
      a: side(0),
      b: side(1),
      stakeTetri: m.stakeTetri,
      startedAt: m.startedAt,
      // A duel still WAITING has not started its clock, so it has no close time
      // — which is exactly how a stuck one is spotted.
      closesAt: m.startedAt
        ? new Date(m.startedAt.getTime() + m.game.durationS * 1000)
        : null,
    });
  }

  // Soonest deadline first — that is the order an operator has to act in.
  // Matches with no clock running sort last; they are stuck, not urgent.
  views.sort((x, y) => {
    if (!x.closesAt && !y.closesAt) return 0;
    if (!x.closesAt) return 1;
    if (!y.closesAt) return -1;
    return x.closesAt.getTime() - y.closesAt.getTime();
  });

  return views;
}

export interface DecideMatchResult {
  bracketMatchId: string;
  tournamentId: string;
  round: number;
  roundLabel: string;
  winnerUserId: string;
  winnerUsername: string;
  aScore: number | null;
  bScore: number | null;
  /** Where the winner landed, or null if they just won the tournament. */
  advancedTo: { round: number; slot: number } | null;
}

/**
 * Resolve one OPEN bracket match on its current scores, using the engine's own
 * rule. Returns the decided row, or null if it was not open by the time the
 * lock was taken. Does NOT advance the bracket — callers do that once.
 */
async function resolveOpenMatchOnScores(
  tournamentId: string,
  bracketMatchId: string
): Promise<{ round: number; slot: number; winnerUserId: string; aScore: number | null; bScore: number | null } | null> {
  const rounds = await roundCountOf(tournamentId);
  return prisma.$transaction(async (db) => {
    // Same lock the scheduler tick and the submit route take. Without it an
    // operator's force and a player's genuine submission can both see the same
    // OPEN row, and the run somebody actually played loses to a button.
    await lockBracketMatchIn(db, bracketMatchId);
    const fresh = await db.bracketMatch.findUnique({
      where: { id: bracketMatchId },
      omit: { aInputLog: true, bInputLog: true },
    });
    if (!fresh || fresh.status !== "OPEN") return null;

    await db.bracketMatch.update({
      where: { id: fresh.id },
      data: { finishedAt: fresh.finishedAt ?? new Date() },
    });
    // The engine's rule, not a second copy of it: higher score wins, a no-show
    // loses, the a-side breaks a dead tie (which also decides a match where
    // neither side ever played). resolveMatchIn advances the winner too.
    await resolveMatchIn(db, fresh, rounds);

    const decided = await db.bracketMatch.findUnique({
      where: { id: fresh.id },
      select: { round: true, slot: true, winnerUserId: true, aScore: true, bScore: true },
    });
    if (!decided?.winnerUserId) return null;
    return {
      round: decided.round,
      slot: decided.slot,
      winnerUserId: decided.winnerUserId,
      aScore: decided.aScore,
      bScore: decided.bScore,
    };
  });
}

/**
 * Resolve a stalled bracket match on the scores that are already in.
 *
 * The tie-break rule is deliberately NOT invented here — it is
 * `resolveMatchIn`'s, the same one the round's window clock applies when it
 * closes:
 *
 *   · both sides played → the higher score wins;
 *   · one side played → the no-show loses;
 *   · both played to an identical score, or neither ever played → the a-side
 *     (the higher bracket position) takes it.
 *
 * Reusing it rather than re-deriving it is the point: forcing a match early
 * must produce exactly the result waiting would have, or an operator's
 * impatience becomes a way to change who wins.
 */
export async function forceFinishMatch(bracketMatchId: string): Promise<DecideMatchResult> {
  const match = await prisma.bracketMatch.findUnique({
    where: { id: bracketMatchId },
    select: { id: true, tournamentId: true, status: true },
  });
  if (!match) throw new Error("Match not found");
  if (match.status !== "OPEN") {
    throw new Error(`That match is ${match.status}; only an open match can be finished by hand.`);
  }

  const decided = await resolveOpenMatchOnScores(match.tournamentId, bracketMatchId);
  if (!decided) {
    throw new Error("That match was resolved by the tournament itself a moment ago.");
  }

  // Let the ordinary driver open the next round, seat the bronze match and
  // finalize if that was the last one.
  await advanceKnockout(match.tournamentId);

  return buildDecideResult(match.tournamentId, bracketMatchId, decided);
}

/**
 * Hand a match to a named participant regardless of the score.
 *
 * The override for when the score is not the truth — a run lost to a crash, a
 * disqualification, a match a support ticket has already settled. Distinct from
 * `forceFinishMatch` on purpose: that one is "apply the rule now", this one is
 * "the rule is wrong here", and an audit should be able to tell them apart.
 *
 * Only an OPEN match can be redirected. Re-deciding a DONE match would leave
 * the loser already advanced into the next round — there is no unwind, so the
 * bracket would end up with the wrong two people in the final and no record of
 * why. Reset the bracket if it has genuinely gone wrong.
 */
export async function declareMatchWinner(
  bracketMatchId: string,
  winnerUserId: string
): Promise<DecideMatchResult> {
  const match = await prisma.bracketMatch.findUnique({
    where: { id: bracketMatchId },
    select: {
      id: true, tournamentId: true, status: true, round: true, slot: true,
      aUserId: true, bUserId: true,
    },
  });
  if (!match) throw new Error("Match not found");
  if (match.status !== "OPEN") {
    throw new Error(`That match is ${match.status}; only an open match can be awarded by hand.`);
  }
  if (winnerUserId !== match.aUserId && winnerUserId !== match.bUserId) {
    throw new Error("That player is not in this match.");
  }

  const rounds = await roundCountOf(match.tournamentId);

  const decided = await prisma.$transaction(async (db) => {
    await lockBracketMatchIn(db, bracketMatchId);
    const fresh = await db.bracketMatch.findUnique({
      where: { id: bracketMatchId },
      select: { id: true, status: true, round: true, slot: true, aScore: true, bScore: true },
    });
    if (!fresh || fresh.status !== "OPEN") return null;

    await db.bracketMatch.update({
      where: { id: fresh.id },
      data: { winnerUserId, status: "DONE", finishedAt: new Date() },
    });
    // The bracket's own geometry — round r slot s feeds round r+1 slot ⌊s/2⌋,
    // a-position when s is even — reused rather than restated.
    await advanceWinnerIn(db, match.tournamentId, fresh.round, fresh.slot, winnerUserId, rounds);
    return {
      round: fresh.round,
      slot: fresh.slot,
      winnerUserId,
      aScore: fresh.aScore,
      bScore: fresh.bScore,
    };
  });
  if (!decided) {
    throw new Error("That match was resolved by the tournament itself a moment ago.");
  }

  await advanceKnockout(match.tournamentId);
  return buildDecideResult(match.tournamentId, bracketMatchId, decided);
}

/** Shared shaping for the two force-resolution paths. */
async function buildDecideResult(
  tournamentId: string,
  bracketMatchId: string,
  decided: {
    round: number;
    slot: number;
    winnerUserId: string;
    aScore: number | null;
    bScore: number | null;
  }
): Promise<DecideMatchResult> {
  const rounds = await roundCountOf(tournamentId);
  const names = await usernamesFor([decided.winnerUserId]);
  const isThirdPlace = decided.round === rounds && decided.slot === THIRD_PLACE_SLOT;

  return {
    bracketMatchId,
    tournamentId,
    round: decided.round,
    roundLabel: isThirdPlace ? "Third place" : knockoutRoundLabel(decided.round, rounds),
    winnerUserId: decided.winnerUserId,
    winnerUsername: names.get(decided.winnerUserId) ?? "—",
    aScore: decided.aScore,
    bScore: decided.bScore,
    // The final has nowhere to feed, and so does the third-place match, which
    // rides in the final's round.
    advancedTo:
      decided.round >= rounds
        ? null
        : { round: decided.round + 1, slot: Math.floor(decided.slot / 2) },
  };
}

// ─────────────────────────── User ops ───────────────────────────

export interface AdminAdjustBalanceInput {
  userId: string;
  /** Signed tetri: positive credits the player, negative debits them. */
  amountTetri: number;
  reason: string;
  /** Recorded in the memo — a movement of money with no name against it is not an audit trail. */
  adminUsername: string;
  /** Distinguishes one adjustment from the next for the same player. */
  reference: string;
}

export interface AdminAdjustBalanceResult {
  balanceBeforeTetri: number;
  balanceAfterTetri: number;
  amountTetri: number;
  /** True when this reference had already been applied — nothing moved twice. */
  alreadyApplied: boolean;
}

/**
 * Move a player's cash balance by hand, in either direction.
 *
 * Deliberately ONE function rather than a credit tool and a debit tool: the
 * dangerous half of this pair is the debit, and giving it its own entry point
 * invites a second, thinner set of guards. Built on the same principles as
 * /api/admin/wallet-credit, whose shape this follows closely:
 *
 *   · Posted through the ledger, never a balance write. Treasury is the
 *     counterparty both ways — it is the mint and is negative by design, so a
 *     credit draws from it exactly as the signup grant does and a debit returns
 *     money to it.
 *   · Its own kind, ADMIN_ADJUSTMENT, so a discretionary operator movement is
 *     never confused in an audit with a goodwill refund (MANUAL_REFUND) or with
 *     machinery like bot funding and balance resets (ADJUSTMENT).
 *   · Keyed on a caller-supplied reference, so a double-click, a retry or a
 *     reload cannot pay twice — the second call returns the first result.
 *   · The issuing admin is named in the memo.
 *   · Bounded, and refuses to overdraw.
 */
export async function adminAdjustBalance(
  input: AdminAdjustBalanceInput
): Promise<AdminAdjustBalanceResult> {
  const { userId, amountTetri, reason, adminUsername, reference } = input;

  if (!Number.isSafeInteger(amountTetri)) {
    throw new Error("Amount must be a whole number of tetri.");
  }
  if (amountTetri === 0) {
    throw new Error("Amount must not be zero — there is nothing to adjust.");
  }
  if (Math.abs(amountTetri) > ADMIN_ADJUSTMENT_MAX_TETRI) {
    throw new Error(
      `Adjustments are capped at ${ADMIN_ADJUSTMENT_MAX_TETRI / 100} lari per action.`
    );
  }
  if (!reference.trim()) {
    throw new Error("A reference is required so a repeated click cannot pay twice.");
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true },
  });
  if (!user) throw new Error("No such account");

  const cashKey = AccountKeys.userCash(userId);
  const balanceBeforeTetri = await getBalanceTetri(prisma, cashKey);

  // The ledger's own floor would also stop this, but it throws mid-transaction
  // with an engine-flavoured message. An operator deserves to be told plainly
  // that they are trying to take more than the player has.
  if (amountTetri < 0 && balanceBeforeTetri + amountTetri < 0) {
    throw new Error(
      `${user.username} holds ${balanceBeforeTetri} tetri; debiting ${Math.abs(amountTetri)} would take the balance below zero.`
    );
  }

  // Guard against the OTHER surface having already paid this reference.
  //
  // /api/admin/wallet-credit keys the same operator, the same player and the
  // same ticket reference as `manual-refund:<user>:<ref>`, while this keys it as
  // `admin-adjust:<user>:<ref>`. Two different namespaces over the same money
  // means one operator working a ticket through both screens pays the player
  // twice, and both screens report success. Different kinds are worth keeping —
  // a hand-made debit must stay findable on its own — but the payment must not
  // happen twice.
  const paidByRefundSurface = await prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey: `manual-refund:${userId}:${reference}` },
    select: { id: true },
  });
  if (paidByRefundSurface) {
    const balance = await getBalanceTetri(prisma, AccountKeys.userCash(userId));
    return {
      balanceBeforeTetri: balance,
      balanceAfterTetri: balance,
      amountTetri: 0,
      alreadyApplied: true,
    };
  }

  const { alreadyPosted } = await postTransaction({
    kind: "ADMIN_ADJUSTMENT",
    memo: `${reason} — issued by ${adminUsername}`,
    refType: "user",
    refId: userId,
    idempotencyKey: `admin-adjust:${userId}:${reference}`,
    entries: [
      { accountKey: AccountKeys.treasury(), amountTetri: -amountTetri },
      { accountKey: cashKey, amountTetri },
    ],
  });

  const balanceAfterTetri = await getBalanceTetri(prisma, cashKey);
  return {
    balanceBeforeTetri,
    balanceAfterTetri,
    amountTetri,
    alreadyApplied: alreadyPosted === true,
  };
}

export interface SetAccountFrozenResult {
  userId: string;
  username: string;
  frozen: boolean;
  /** Which column carries the state — see the note on reuse below. */
  field: "suspendedAt";
  suspendedAt: Date | null;
}

/**
 * Freeze or unfreeze an account.
 *
 * Freezing REUSES the existing `User.suspendedAt` column rather than adding a
 * parallel flag. That field already means exactly this: `getCurrentUser` treats
 * a suspended user as not logged in, so setting it locks the account out of
 * every authenticated surface at once. A second "frozen" boolean would have to
 * be checked in every one of those places to have the same effect, and the
 * first place anyone forgot would be a frozen account that could still play.
 *
 * The last-active-admin guard lives here because it is derived from data. The
 * "you cannot freeze your own account" guard cannot — this layer has no session
 * — so the API route MUST still refuse when the target is the caller.
 */
export async function setAccountFrozen(
  userId: string,
  frozen: boolean
): Promise<SetAccountFrozenResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, role: true },
  });
  if (!user) throw new Error("No such account");

  if (frozen && user.role === "ADMIN") {
    const remaining = await prisma.user.count({
      where: { role: "ADMIN", suspendedAt: null, id: { not: userId } },
    });
    if (remaining === 0) {
      throw new Error(
        "Cannot freeze the last active admin — the platform would be locked out of its own admin surface."
      );
    }
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { suspendedAt: frozen ? new Date() : null },
    select: { suspendedAt: true },
  });

  return {
    userId: user.id,
    username: user.username,
    frozen,
    field: "suspendedAt",
    suspendedAt: updated.suspendedAt,
  };
}

export interface ResetDemoBalanceResult {
  balanceBeforeTetri: number;
  balanceAfterTetri: number;
  targetTetri: number;
  /** False when the balance was already exactly the grant. */
  changed: boolean;
}

/**
 * Put a player's demo cash back to the ₾5 signup grant, exactly.
 *
 * The target is SIGNUP_CREDIT_TETRI, read rather than restated, so this always
 * means "what a new player starts with" even if that figure changes.
 *
 * It balances rather than writes: the difference is posted against treasury in
 * one zero-sum ADJUSTMENT. ADJUSTMENT, not ADMIN_ADJUSTMENT, because a reset is
 * machinery — the same category as bot funding — and folding it in with
 * discretionary operator movements would bury the ones an auditor is looking
 * for. Cash only; vault credits are a separate economy and are left alone.
 *
 * The idempotency key carries a one-minute bucket. That is the difference
 * between a double-click (same minute, collapses into one posting) and a
 * deliberate second reset later in the session (new minute, works). A key
 * without a time component would make the reset a once-ever action; a key
 * without any bucket would make the button double-payable.
 */
export async function resetDemoBalance(userId: string): Promise<ResetDemoBalanceResult> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new Error("No such account");

  const cashKey = AccountKeys.userCash(userId);
  const balanceBeforeTetri = await getBalanceTetri(prisma, cashKey);
  const delta = SIGNUP_CREDIT_TETRI - balanceBeforeTetri; // >0 mint, <0 return

  if (delta === 0) {
    return {
      balanceBeforeTetri,
      balanceAfterTetri: balanceBeforeTetri,
      targetTetri: SIGNUP_CREDIT_TETRI,
      changed: false,
    };
  }

  const minuteBucket = Math.floor(Date.now() / 60_000);
  await postTransaction({
    kind: "ADJUSTMENT",
    memo: `Demo balance reset to the ₾${SIGNUP_CREDIT_TETRI / 100} signup grant`,
    refType: "user",
    refId: userId,
    idempotencyKey: `admin-demo-reset:${userId}:${minuteBucket}`,
    entries: [
      { accountKey: AccountKeys.treasury(), amountTetri: -delta },
      { accountKey: cashKey, amountTetri: delta },
    ],
  });

  const balanceAfterTetri = await getBalanceTetri(prisma, cashKey);
  return {
    balanceBeforeTetri,
    balanceAfterTetri,
    targetTetri: SIGNUP_CREDIT_TETRI,
    changed: true,
  };
}

// ─────────────────────────── System ops ───────────────────────────

export interface SystemSnapshot {
  /** Tournaments currently RUNNING. */
  activeTournaments: number;
  /** Non-bot accounts seen within ONLINE_WINDOW_MS. */
  onlinePlayers: number;
  database: { ok: boolean; latencyMs: number };
  realtime: {
    /** NEXT_PUBLIC_REALTIME_URL is set at all. */
    configured: boolean;
    url: string | null;
    /** null when unconfigured or unreachable — never a thrown error. */
    ok: boolean | null;
    error: string | null;
  };
  counts: {
    users: number;
    bots: number;
    admins: number;
    tournamentsScheduled: number;
    tournamentsRunning: number;
    tournamentsFinished: number;
    openBracketMatches: number;
    liveDuels: number;
  };
}

/**
 * The realtime service's HTTP health URL, derived from the socket URL.
 *
 * NEXT_PUBLIC_REALTIME_URL is a WebSocket address (`ws://host:4001`) because
 * that is what the browser connects to; the same host serves /health over plain
 * HTTP. Returns null when unset or unparseable rather than constructing a
 * nonsense URL and fetching it.
 */
function realtimeHealthUrl(socketUrl: string | undefined): string | null {
  if (!socketUrl) return null;
  try {
    const url = new URL(socketUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    else if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = "/health";
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * One read of the platform's vital signs for the admin console's header.
 *
 * The realtime probe is the delicate part. It is a network call to a host that
 * may be down, slow or absent, made while rendering a page an operator opens
 * precisely BECAUSE something is wrong — so it is bounded by a short timeout
 * and every failure path returns `ok: false` with a reason. It must never throw
 * and it must never hang: a health check that takes the admin console down with
 * it is worse than no health check.
 */
export async function systemSnapshot(): Promise<SystemSnapshot> {
  const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MS);

  const startedAt = Date.now();
  let databaseOk = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    databaseOk = false;
  }
  const latencyMs = Date.now() - startedAt;

  // If the database is unreachable there is nothing to count and every query
  // below would throw. Report that plainly instead of failing the whole page.
  if (!databaseOk) {
    const realtime = await probeRealtime();
    return {
      activeTournaments: 0,
      onlinePlayers: 0,
      database: { ok: false, latencyMs },
      realtime,
      counts: {
        users: 0, bots: 0, admins: 0,
        tournamentsScheduled: 0, tournamentsRunning: 0, tournamentsFinished: 0,
        openBracketMatches: 0, liveDuels: 0,
      },
    };
  }

  const [
    onlinePlayers,
    users,
    bots,
    admins,
    tournamentsScheduled,
    tournamentsRunning,
    tournamentsFinished,
    openBracketMatches,
    liveDuels,
    realtime,
  ] = await Promise.all([
    prisma.user.count({ where: { isBot: false, lastSeenAt: { gte: onlineSince } } }),
    prisma.user.count({ where: { isBot: false } }),
    prisma.user.count({ where: { isBot: true } }),
    prisma.user.count({ where: { role: "ADMIN", suspendedAt: null } }),
    prisma.tournament.count({ where: { status: "SCHEDULED" } }),
    prisma.tournament.count({ where: { status: "RUNNING" } }),
    prisma.tournament.count({ where: { status: "FINISHED" } }),
    prisma.bracketMatch.count({
      where: { status: "OPEN", tournament: { status: "RUNNING" } },
    }),
    prisma.match.count({ where: { status: { in: ["WAITING", "ACTIVE"] } } }),
    probeRealtime(),
  ]);

  return {
    activeTournaments: tournamentsRunning,
    onlinePlayers,
    database: { ok: true, latencyMs },
    realtime,
    counts: {
      users, bots, admins,
      tournamentsScheduled, tournamentsRunning, tournamentsFinished,
      openBracketMatches, liveDuels,
    },
  };
}

/** Fetch the realtime service's /health. Resolves to a verdict, never throws. */
async function probeRealtime(): Promise<SystemSnapshot["realtime"]> {
  const socketUrl = process.env.NEXT_PUBLIC_REALTIME_URL;
  const healthUrl = realtimeHealthUrl(socketUrl);

  if (!socketUrl) {
    return {
      configured: false,
      url: null,
      ok: null,
      error: "NEXT_PUBLIC_REALTIME_URL is not set — realtime play cannot work.",
    };
  }
  if (!healthUrl) {
    return {
      configured: true,
      url: socketUrl,
      ok: false,
      error: `NEXT_PUBLIC_REALTIME_URL is not a usable address: ${socketUrl}`,
    };
  }

  try {
    const res = await fetch(healthUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(REALTIME_HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { configured: true, url: socketUrl, ok: false, error: `Health check returned ${res.status}` };
    }
    return { configured: true, url: socketUrl, ok: true, error: null };
  } catch (err) {
    // Includes the timeout, DNS failure, connection refused and TLS errors —
    // all of which mean the same thing to an operator: it is not answering.
    const reason = err instanceof Error ? err.message : "unreachable";
    return { configured: true, url: socketUrl, ok: false, error: `Not reachable: ${reason}` };
  }
}
