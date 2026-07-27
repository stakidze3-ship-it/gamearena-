/**
 * Admin-only bot fill for tournaments.
 *
 * Lets an operator run a whole knockout end to end without waiting for sixty
 * humans: seat every empty chair with a bot, let the normal fill trigger draw
 * the bracket, then play the bot-vs-bot matches out over time so the bracket,
 * spectator screens and prize settlement are all exercised exactly as they
 * would be in production.
 *
 * Three rules this module will not break:
 *
 *   1. Bots join through joinTournament, the same path a human uses. Nothing
 *      here writes a TournamentEntry directly, so capacity, the escrow and the
 *      fill trigger cannot drift out of agreement with reality.
 *   2. Money stays zero-sum. A bot has no balance, so its entry fee is minted
 *      from treasury first — the same thing the 1v1 demo bot already does. The
 *      treasury is the mint and is negative by design; no fake money appears
 *      from nowhere and no real player's balance is touched.
 *   3. Bot provenance is recorded, but it is NOT visibility. Filling seats
 *      stamps botFilledAt/botsSeated so an operator can always see that a
 *      field was padded and that part of the pool is treasury credit. It does
 *      NOT touch isTest. Coupling the two meant filling a real event silently
 *      deleted it from the Tournaments page, which is why filling a live
 *      tournament had to be forbidden outright.
 *
 * Two fill modes, because the two situations have genuinely different stakes:
 *
 *   · "test"          — the event is already flagged isTest. Hidden from
 *                       players, disposable, no confirmation needed.
 *   · "live-override" — a real, player-visible event. The caller must pass
 *                       acknowledgeLive, because bots will compete against
 *                       paying humans for a real prize pool. The event stays
 *                       visible and stays non-test.
 */

import { BLOCK_BLAST_RULES_LATEST, planBotRun, type BlockBlastInput } from "@gamearena/games";
import { Rng } from "@gamearena/games";
import { prisma } from "./client";
import { AccountKeys, getBalanceTetri, postTransactionIn } from "./ledger";
import { mintDemoCreditIn } from "./money-ops";
import { joinTournament } from "./tournaments";
import { submitKnockoutScore } from "./bracket";

/** Handle fragments that read like real competitive players rather than "bot17". */
const HANDLE_ROOTS = [
  "nocturne", "vex", "kite", "ember", "quartz", "halcyon", "drift", "onyx",
  "lumen", "sable", "vertex", "cinder", "prism", "wraith", "solace", "flint",
  "zephyr", "cobalt", "riven", "tundra", "arclight", "mirage", "cypher", "nova",
  "gale", "hollow", "ridge", "vanta", "koda", "spectre", "atlas", "cove",
];
const HANDLE_TAGS = [
  "", "", "", "x", "gg", "tv", "hq", "pro", "one", "zero", "prime", "ace",
];

/**
 * Deterministic, collision-resistant bot handles.
 *
 * Seeded so a given index always produces the same handle, which keeps repeat
 * test runs readable; uniqueness against the real user table is enforced by the
 * caller, which retries with a wider suffix on conflict.
 */
function botHandle(index: number, salt: number): string {
  const rng = new Rng(`bot-handle:${index}:${salt}`);
  const root = HANDLE_ROOTS[Math.floor(rng.next() * HANDLE_ROOTS.length)]!;
  const tag = HANDLE_TAGS[Math.floor(rng.next() * HANDLE_TAGS.length)]!;
  const num = 10 + Math.floor(rng.next() * 89);
  return `${root}${tag}${num}`;
}

/** Bot skill, spread across the field so a bracket has favourites and upsets. */
function botStrength(userId: string): number {
  const rng = new Rng(`bot-strength:${userId}`);
  // Centred around competent with real spread — a flat field makes every match
  // a coin flip and the bracket stops looking like a tournament.
  return 0.3 + rng.next() * 0.65;
}

export type BotFillMode = "test" | "live-override";

export interface BotFillResult {
  seated: number;
  /** Which situation this was — the UI reports live overrides differently. */
  mode: BotFillMode;
  alreadyFull: boolean;
  entryCount: number;
  capacity: number;
  startsAt: Date;
}

/**
 * Get or create `count` bot accounts.
 *
 * Bots are persistent and reused across tournaments — creating throwaways per
 * run would bloat the user table and make repeat testing noisy. They are
 * flagged isBot, which is what excludes them from real standings.
 */
export async function ensureBotUsers(
  count: number,
  excludeUserIds: string[] = []
): Promise<{ id: string; username: string }[]> {
  const existing = await prisma.user.findMany({
    where: { isBot: true, username: { not: "ARENA_BOT" } },
    select: { id: true, username: true },
    orderBy: { createdAt: "asc" },
    take: count,
  });
  if (existing.length >= count) return existing.slice(0, count);

  const made = [...existing];
  for (let i = existing.length; i < count; i++) {
    // Retry with a widening salt. Every unique column — username, email and
    // referralCode — is derived from the same (index, salt) pair, so one bump
    // moves all of them; deriving only the username would leave the referral
    // code colliding on the retry. The create is also guarded, because another
    // request can take a handle between the check and the insert.
    let created: { id: string; username: string } | null = null;
    for (let salt = 0; salt < 60 && !created; salt++) {
      const username = botHandle(i, salt);
      const lower = username.toLowerCase();
      const taken = await prisma.user.findFirst({
        where: { usernameLower: lower },
        select: { id: true },
      });
      if (taken) continue;
      try {
        created = await prisma.user.create({
          data: {
            email: `${lower}@bots.gamearena.invalid`,
            username,
            usernameLower: lower,
            // Unusable hash: bots are never logged into.
            passwordHash: "bot-account-no-login",
            referralCode: `BOT${lower.slice(0, 10).toUpperCase()}${salt}`,
            isBot: true,
          },
          select: { id: true, username: true },
        });
      } catch (err) {
        // P2002 = unique violation on any of those columns; try the next salt.
        if ((err as { code?: string }).code !== "P2002") throw err;
      }
    }
    if (!created) throw new Error(`Could not allocate a bot handle for index ${i}`);
    made.push(created);
  }
  return made;
}

/**
 * Seat bots in every remaining chair.
 *
 * Returns once the tournament is full; the existing fill trigger inside
 * joinTournament sets `startsAt`, and the ordinary state-poll driver draws the
 * bracket when that countdown expires. Nothing here reaches around that.
 */
export interface FillBotsOptions {
  /** How many seconds the fill trigger gives the field before the draw. */
  countdownS: number;
  /**
   * Required to seat bots in a live, player-visible event.
   *
   * Not ceremony: in a live tournament the bots pay a real entry fee into a
   * real escrow and can win a real prize, so an operator has to say out loud
   * that this is what they mean. A test event needs no such acknowledgement.
   */
  acknowledgeLive?: boolean;
  /** Seat at most this many, rather than every empty chair. */
  limit?: number;
}

export async function fillTournamentWithBots(
  tournamentId: string,
  options: FillBotsOptions | number
): Promise<BotFillResult> {
  // Older callers passed a bare countdown. Keep them working rather than
  // rewriting every call site for a signature change.
  const opts: FillBotsOptions =
    typeof options === "number" ? { countdownS: options } : options;

  const t = await prisma.tournament.findUnique({ where: { id: tournamentId } });
  if (!t) throw new Error("Tournament not found");
  if (t.status !== "SCHEDULED") throw new Error(`Cannot fill a ${t.status} tournament`);

  const taken = await prisma.tournamentEntry.count({ where: { tournamentId } });
  const need = Math.max(0, Math.min(t.capacity - taken, opts.limit ?? Infinity));
  if (need === 0) {
    return {
      seated: 0,
      alreadyFull: t.capacity - taken === 0,
      entryCount: taken,
      capacity: t.capacity,
      startsAt: t.startsAt,
      mode: t.isTest ? "test" : "live-override",
    };
  }

  // A live event may be filled — but only deliberately.
  //
  // This used to be a hard refusal, because filling set isTest and that hid the
  // event from every player. Provenance now lives in its own column, so the
  // only thing left to protect is the operator's intent: bots will take seats
  // in a real bracket and compete for real money.
  const mode: BotFillMode = t.isTest ? "test" : "live-override";
  if (mode === "live-override" && !opts.acknowledgeLive) {
    throw new Error(
      "This is a live, player-visible tournament. Seating bots here puts them in a real bracket competing for a real prize pool — confirm the override to proceed."
    );
  }

  // Never offer a bot that is already sitting in this field.
  //
  // ensureBotUsers returns the OLDEST bots, deterministically. Once one of them
  // holds a seat here — after a partial fill, or after an operator removed a
  // single bot — asking for more returns that same bot again. The old loop
  // funded it, got `alreadyEntered` back from joinTournament, counted a seat it
  // had not filled, and left the minted fee stranded in the bot's wallet with
  // nothing to spend it on. Clicking Fill again repeated it, every time.
  const alreadySeated = await prisma.tournamentEntry.findMany({
    where: { tournamentId },
    select: { userId: true },
  });
  const bots = await ensureBotUsers(
    need,
    alreadySeated.map((e) => e.userId)
  );

  let seated = 0;
  let entryCount = taken;
  let startsAt = t.startsAt;

  for (const bot of bots) {
    // Top the bot up to the entry fee rather than minting it outright.
    //
    // Funding by shortfall is self-correcting: a bot that still holds credit
    // from an abandoned fill spends that instead of receiving a second helping,
    // so a repeated fill cannot inflate the treasury's outlay. An idempotency
    // key would not do this — it would also block the legitimate re-funding of
    // a bot whose seat was removed and refunded to treasury.
    if (t.entryTetri > 0) {
      const balance = await getBalanceTetri(prisma, AccountKeys.userCash(bot.id));
      const shortfall = t.entryTetri - balance;
      if (shortfall > 0) {
        await prisma.$transaction(async (db) => {
          await mintDemoCreditIn(db, bot.id, shortfall, `Bot entry · ${tournamentId}`);
        });
      }
    }

    const res = await joinTournament(tournamentId, bot.id, opts.countdownS);
    if (!res.ok) break; // full, or the event moved on — stop cleanly
    // A bot that was already in this field took no new seat. Counting it would
    // report a fill that did not happen.
    if (!res.alreadyEntered) {
      seated++;
      entryCount = res.entryCount;
      startsAt = res.startsAt;
    }
    if (res.full) break;
  }

  if (seated > 0) {
    // Record that this field was padded, without hiding the event. isTest is
    // deliberately untouched here.
    await prisma.tournament.update({
      where: { id: tournamentId },
      data: { botFilledAt: new Date(), botsSeated: { increment: seated } },
    });
  }

  return { seated, alreadyFull: false, entryCount, capacity: t.capacity, startsAt, mode };
}

/**
 * Return every bot's balance to the treasury after a test event settles.
 *
 * Bots are ranked and paid exactly like humans — that is deliberate, because
 * skipping them in settlement would pay a human who lost the final the
 * champion's prize while the bracket on screen says they came second. So the
 * prize genuinely lands in the bot's account, and this sweeps it back.
 *
 * The invariant is: no bot holds a balance outside a live event. What remains
 * on SYS_TREASURY is then the exact, auditable cost of the test.
 *
 * Deliberately a separate transaction, after settlement — never inside the
 * money transaction, which must stay exactly as it is for real events.
 */
export async function sweepBotBalances(tournamentId: string): Promise<number> {
  const entries = await prisma.tournamentEntry.findMany({
    where: { tournamentId, user: { isBot: true } },
    select: { userId: true },
  });
  if (entries.length === 0) return 0;

  let recovered = 0;
  for (const { userId } of entries) {
    const balance = await getBalanceTetri(prisma, AccountKeys.userCash(userId));
    if (balance <= 0) continue;
    await prisma.$transaction(async (db) => {
      await postTransactionIn(db, {
        kind: "ADJUSTMENT",
        memo: "Bot balance returned",
        refType: "tournament",
        refId: tournamentId,
        idempotencyKey: `bot-sweep:${tournamentId}:${userId}`,
        entries: [
          { accountKey: AccountKeys.userCash(userId), amountTetri: -balance },
          { accountKey: AccountKeys.treasury(), amountTetri: balance },
        ],
      });
    });
    recovered += balance;
  }
  return recovered;
}

/**
 * When a bot playing `matchId` should submit, as an offset into the round.
 *
 * Deterministic per (match, player) so the driver can be called from any number
 * of instances and always agrees on whether a bot has "finished" yet. Spread
 * across the middle of the window: early enough that the round is not held up,
 * late enough that a human opponent has a fair chance to play, and staggered so
 * results trickle in rather than landing together.
 */
export function botSubmitDelayMs(matchId: string, userId: string, roundDurationS: number): number {
  const rng = new Rng(`bot-delay:${matchId}:${userId}`);
  const windowMs = roundDurationS * 1000;
  return Math.round(windowMs * (0.25 + rng.next() * 0.5)); // 25%..75% in
}

export interface BotDriveResult {
  submitted: number;
  pending: number;
}

/**
 * Play out any bot turns that are due in this tournament.
 *
 * Called opportunistically from the same poll that advances the bracket, so it
 * needs no scheduler and no persistent process. Each bot submits through
 * submitKnockoutScore — the same path a human uses, including its row lock — so
 * a match cannot be double-resolved no matter how many instances call this.
 *
 * A bot only plays once its deterministic delay has elapsed, which is what
 * makes the tournament unfold over minutes instead of finishing instantly.
 */
export async function driveBotMatches(tournamentId: string): Promise<BotDriveResult> {
  const t = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { id: true, roundDurationS: true, status: true, isTest: true },
  });
  if (!t || t.status !== "RUNNING") return { submitted: 0, pending: 0 };

  const open = await prisma.bracketMatch.findMany({
    where: { tournamentId, status: "OPEN" },
    select: {
      id: true, seed: true, openedAt: true, rulesVersion: true,
      aUserId: true, bUserId: true, aPlayed: true, bPlayed: true,
    },
  });
  if (open.length === 0) return { submitted: 0, pending: 0 };

  const ids = new Set<string>();
  for (const m of open) {
    if (m.aUserId) ids.add(m.aUserId);
    if (m.bUserId) ids.add(m.bUserId);
  }
  const bots = new Set(
    (
      await prisma.user.findMany({
        where: { id: { in: [...ids] }, isBot: true },
        select: { id: true },
      })
    ).map((u) => u.id)
  );
  if (bots.size === 0) return { submitted: 0, pending: 0 };

  const now = Date.now();
  let submitted = 0;
  let pending = 0;

  for (const m of open) {
    if (!m.openedAt || !m.seed) continue;
    for (const side of ["a", "b"] as const) {
      const userId = side === "a" ? m.aUserId : m.bUserId;
      const played = side === "a" ? m.aPlayed : m.bPlayed;
      if (!userId || played || !bots.has(userId)) continue;

      const due = m.openedAt.getTime() + botSubmitDelayMs(m.id, userId, t.roundDurationS);
      if (now < due) {
        pending++;
        continue;
      }

      const plan = planBotRun(
        `${m.seed}:${userId}`,
        t.roundDurationS * 1000,
        botStrength(userId),
        (m.rulesVersion as 1 | 2) ?? BLOCK_BLAST_RULES_LATEST
      );
      const result = await submitKnockoutScore(tournamentId, userId, plan.score, plan.inputs);
      if (result) submitted++;
    }
  }

  return { submitted, pending };
}

export type { BlockBlastInput };
