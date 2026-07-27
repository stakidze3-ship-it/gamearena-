/**
 * The admin console's dashboard read.
 *
 * One function, one round of concurrent queries, everything an operator looks
 * at in the first five seconds of opening the console. It is separate from
 * admin-ops.ts because nothing here mutates anything — this file only ever
 * reads, and keeping it that way means a dashboard change can never introduce
 * a money bug.
 *
 * Three rules govern every number below.
 *
 *   1. NOTHING IS ESTIMATED. Every figure is a count or a sum of rows that
 *      exist. Where a value genuinely cannot be known — because the database
 *      is unreachable — the field is `null` and the console renders a dash.
 *      A confident zero on an operations dashboard is worse than a blank,
 *      because an operator acts on it.
 *   2. MONEY COMES FROM THE LEDGER, never from summing a denormalised column
 *      on Match or BlitzRun or TournamentEntry. Those columns describe what a
 *      row intended; the ledger records what actually moved. When they
 *      disagree the ledger is right by definition, and a dashboard that
 *      disagreed with the wallet would be the thing that hid the incident.
 *   3. EVERY MONEY LABEL SAYS WHAT IT MEANS. PAYMENTS_ENABLED is off, so none
 *      of these amounts are real currency — they are demo credits minted by
 *      SYS_TREASURY. An operator reading "revenue today: ₾420" as money the
 *      business earned is a genuine hazard during a demo season, so
 *      `paymentsEnabled` ships in the payload and the interface documents each
 *      amount in full rather than trusting the field name.
 */

import type { TxKind } from "@prisma/client";
import { prisma } from "./client";
import { AccountKeys, getBalanceTetri } from "./ledger";
import { systemSnapshot, type SystemSnapshot } from "./admin-ops";

/**
 * Transactions that take a stake OUT of a player's wallet.
 *
 * MATCH_STAKE is deliberately absent. A 1v1 stake is escrowed and then either
 * paid out or refunded, so counting it here alongside the entry fees of
 * one-way products would inflate "fees collected" with money that was only
 * ever passing through. Duel economics are the rake figure's job.
 */
const ENTRY_FEE_KINDS: TxKind[] = ["TOURNAMENT_ENTRY", "BLITZ_ENTRY"];

/**
 * Transactions that put winnings INTO a player's wallet.
 *
 * Refund kinds (MATCH_REFUND, MANUAL_REFUND) are excluded on purpose: giving a
 * stake back is a reversal, not a prize, and folding the two together would
 * make a cancelled tournament look like a payout event.
 *
 * MATCH_PAYOUT is excluded for the same reason MATCH_STAKE is excluded above,
 * and leaving it in was a real defect rather than a judgement call: counting
 * the winner's credit while ignoring both players' debits made every settled
 * duel look like pure outflow. A ₾5 duel added ₾4.38 to payouts and nothing to
 * fees, so "fees minus payouts" fell by ₾4.38 on a hand where players had
 * collectively lost ₾1.25 — it reported the opposite of what happened.
 *
 * Both duel legs therefore stay out of this pair, and duel economics are read
 * off the rake figure, which is exactly what the platform keeps from them.
 */
const PRIZE_PAYOUT_KINDS: TxKind[] = ["TOURNAMENT_PRIZE", "BLITZ_PAYOUT"];

/**
 * Midnight in the server's own timezone, which is what "today" means here.
 *
 * Matches the existing metrics page rather than inventing a second definition
 * of a day. On the production deployment the server runs in UTC, so an
 * operator in Tbilisi sees a day that ends at 04:00 local — hence
 * `todayStartedAt` is returned in the payload, so the console can show the
 * exact window instead of leaving the reader to assume their own midnight.
 */
function startOfServerDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export interface DashboardPlayers {
  /** Registered humans. Bots are excluded everywhere in this block. */
  total: number;
  /** Humans whose lastSeenAt falls inside the console's 5-minute online window. */
  online: number;
  /**
   * Humans who registered since `todayStartedAt`. Null when the query that
   * carries it failed while the rest of the block still read cleanly — an
   * unknown signup count must not blank the player count next to it.
   */
  newToday: number | null;
  /** Bot accounts, reported separately so they can never pad the player count. */
  bots: number;
}

export interface DashboardActivity {
  /** 1v1 duels in WAITING or ACTIVE — a real match somebody is sitting in. */
  activeMatches: number;
  /** Bracket matches still OPEN inside a RUNNING tournament. */
  openBracketMatches: number;
  tournamentsRunning: number;
  tournamentsScheduled: number;
}

export interface DashboardMoney {
  /**
   * All-time stakes that have LEFT player wallets: the signed sum of every
   * USER_CASH ledger entry on a TOURNAMENT_ENTRY or BLITZ_ENTRY transaction,
   * flipped so it reads as a positive amount collected.
   *
   * Signed rather than "sum of the negative ones" because a released
   * tournament seat is posted as a REVERSING transaction of the same kind
   * (see releaseTournamentEntryIn in admin-ops.ts). The signed sum therefore
   * nets refunded entries out automatically, which is the honest answer to
   * "how much did players actually pay in".
   */
  entryFeesTetri: number;
  /** The same measure, limited to entries posted since `todayStartedAt`. */
  entryFeesTodayTetri: number;
  /**
   * The bot share of the all-time figure.
   *
   * Bots are funded from the treasury before a fill and swept afterwards, so
   * their entry fees are minted credit making a round trip, not demand. Shown
   * so nobody reads a bot-filled bracket as player activity.
   */
  entryFeesFromBotsTetri: number;

  /**
   * All-time winnings paid INTO player wallets: the signed sum of USER_CASH
   * entries on TOURNAMENT_PRIZE, BLITZ_PAYOUT and MATCH_PAYOUT transactions.
   */
  prizePayoutsTetri: number;
  /** The same measure, limited to entries posted since `todayStartedAt`. */
  prizePayoutsTodayTetri: number;
  /** The bot share of the all-time figure — see `entryFeesFromBotsTetri`. */
  prizePayoutsToBotsTetri: number;

  /**
   * Entry fees minus prize payouts. NOT profit.
   *
   * It includes stakes still locked in the escrow of an event that has not
   * settled yet, and it counts bot round-trips on both sides. It answers "are
   * players collectively up or down", nothing more.
   */
  netFromPlayersTetri: number;

  /**
   * Platform profit: the current SYS_RAKE balance.
   *
   * That account receives the rake slice of every settled duel plus whatever a
   * tournament pool did not pay out, and it is never debited, so its balance
   * IS the all-time take. Two caveats that matter:
   *
   *   · Blitz margin is NOT in here. Blitz entries credit SYS_TREASURY and
   *     blitz payouts debit it, so the margin is mixed in with the mint and no
   *     balance read can separate the two. Use `entryFees - prizePayouts` for
   *     the whole-platform picture, and read the comment on that field first.
   *   · It is demo credit while PAYMENTS_ENABLED is off. Nobody has been paid
   *     anything.
   */
  platformProfitTetri: number;

  /**
   * "Revenue today": the net movement of SYS_RAKE since `todayStartedAt`.
   *
   * The same money as `platformProfitTetri`, measured as a delta rather than a
   * balance, so it carries all of the same caveats.
   */
  revenueTodayTetri: number;
}

export interface DashboardSnapshot {
  generatedAt: string;
  /** The exact instant every "today" figure is measured from. */
  todayStartedAt: string;
  /**
   * Whether real deposits and withdrawals are live on this deployment.
   *
   * The env var is the hard gate (the feature-flag row cannot turn payments on
   * by itself), so it is what gets reported. While this is false every amount
   * in `money` is demo credit and the console must say so.
   */
  paymentsEnabled: boolean;

  /** null when the database is unreachable — see rule 1 in the file header. */
  players: DashboardPlayers | null;
  /** null when the database is unreachable. */
  activity: DashboardActivity | null;
  /** null when the database is unreachable OR the ledger reads themselves failed. */
  money: DashboardMoney | null;

  health: {
    /**
     * This request was served, so the web tier is up by definition. `uptimeS`
     * is the age of the ONE serverless instance that answered, not of the
     * deployment — a low number means a cold start, not an outage.
     */
    server: { ok: true; instanceUptimeS: number };
    database: SystemSnapshot["database"];
    realtime: SystemSnapshot["realtime"];
  };

  /**
   * Why part of this snapshot is null, in words an operator can act on. Null
   * when everything was read successfully.
   */
  degradedReason: string | null;
}

/**
 * Sum the money that moved across PLAYER WALLETS for a set of transaction kinds.
 *
 * Restricted to USER_CASH accounts on purpose. A single transaction touches
 * several accounts — a match payout credits the winner AND the rake AND debits
 * escrow — so summing every entry on it would count the same movement two or
 * three times. Filtering to the player side answers exactly one question:
 * what changed hands with the people using the product.
 *
 * Returns the signed total: negative when money left players (entry fees),
 * positive when it reached them (prizes). Callers flip the sign where that
 * reads better, and doing it that way means a reversing transaction cancels
 * its original instead of being double-counted.
 */
async function sumPlayerCashMovement(
  kinds: TxKind[],
  filters: { since?: Date; isBot?: boolean } = {}
): Promise<number> {
  const result = await prisma.ledgerEntry.aggregate({
    where: {
      tx: { kind: { in: kinds } },
      account: {
        type: "USER_CASH",
        ...(filters.isBot === undefined ? {} : { user: { isBot: filters.isBot } }),
      },
      // LedgerEntry.createdAt is written from the transaction's own createdAt,
      // including for backdated seed data, so a day window on the entry and a
      // day window on the transaction agree. The entry is indexed, so this is
      // the cheaper of the two.
      ...(filters.since ? { createdAt: { gte: filters.since } } : {}),
    },
    _sum: { amountTetri: true },
  });
  // No matching rows sums to null, which is not the same as zero to Prisma but
  // is exactly the same thing to an operator.
  return result._sum.amountTetri ?? 0;
}

/** Net movement of the platform's rake account within a window. */
async function sumRakeMovement(since: Date): Promise<number> {
  const result = await prisma.ledgerEntry.aggregate({
    where: { account: { type: "SYS_RAKE" }, createdAt: { gte: since } },
    _sum: { amountTetri: true },
  });
  return result._sum.amountTetri ?? 0;
}

/**
 * Everything the dashboard needs beyond the system snapshot, in one concurrent
 * batch: today's signups and the whole money picture.
 *
 * Resolves to null instead of throwing. The dashboard is a page an operator
 * opens BECAUSE something is wrong, and a failed ledger aggregate must degrade
 * one panel rather than take the health readout — the part that explains the
 * failure — down with it.
 */
async function readLedgerAndSignups(
  todayStart: Date
): Promise<{ newUsersToday: number; money: DashboardMoney } | null> {
  try {
    const [
      newUsersToday,
      entryFeesSigned,
      entryFeesTodaySigned,
      entryFeesFromBotsSigned,
      prizePayouts,
      prizePayoutsToday,
      prizePayoutsToBots,
      platformProfitTetri,
      revenueTodayTetri,
    ] = await Promise.all([
      prisma.user.count({ where: { isBot: false, createdAt: { gte: todayStart } } }),
      sumPlayerCashMovement(ENTRY_FEE_KINDS),
      sumPlayerCashMovement(ENTRY_FEE_KINDS, { since: todayStart }),
      sumPlayerCashMovement(ENTRY_FEE_KINDS, { isBot: true }),
      sumPlayerCashMovement(PRIZE_PAYOUT_KINDS),
      sumPlayerCashMovement(PRIZE_PAYOUT_KINDS, { since: todayStart }),
      sumPlayerCashMovement(PRIZE_PAYOUT_KINDS, { isBot: true }),
      getBalanceTetri(prisma, AccountKeys.rake()),
      sumRakeMovement(todayStart),
    ]);

    // Entry sums are negative from the player's point of view; the dashboard
    // speaks from the platform's, where a fee collected is a positive number.
    const entryFeesTetri = -entryFeesSigned;
    const entryFeesTodayTetri = -entryFeesTodaySigned;
    const entryFeesFromBotsTetri = -entryFeesFromBotsSigned;

    return {
      newUsersToday,
      money: {
        entryFeesTetri,
        entryFeesTodayTetri,
        entryFeesFromBotsTetri,
        prizePayoutsTetri: prizePayouts,
        prizePayoutsTodayTetri: prizePayoutsToday,
        prizePayoutsToBotsTetri: prizePayoutsToBots,
        netFromPlayersTetri: entryFeesTetri - prizePayouts,
        platformProfitTetri,
        revenueTodayTetri,
      },
    };
  } catch (err) {
    // Logged rather than swallowed: the console will say the panel is degraded,
    // but only the deployment log can say why.
    console.error("[admin] dashboard ledger read failed:", err);
    return null;
  }
}

/**
 * One read of the whole operations picture, for the console's first tab.
 *
 * The system snapshot and the ledger batch are started together rather than in
 * sequence. They do not depend on each other, and the snapshot's realtime probe
 * is a bounded network call that would otherwise add its latency to every
 * refresh. Each half fails independently, so a dead ledger query still leaves
 * the operator with health, and an unreachable database still leaves them with
 * the realtime verdict and an explicit reason for the blanks.
 */
export async function dashboardSnapshot(): Promise<DashboardSnapshot> {
  const now = new Date();
  const todayStart = startOfServerDay(now);

  const [system, extra] = await Promise.all([
    systemSnapshot(),
    readLedgerAndSignups(todayStart),
  ]);

  const databaseOk = system.database.ok;

  // systemSnapshot() reports zeros when the database is down, which is right
  // for a health readout and wrong for a dashboard: "0 users" and "0 active
  // matches" are claims about the platform that nobody verified. Blank them.
  const players: DashboardPlayers | null = databaseOk
    ? {
        total: system.counts.users,
        online: system.onlinePlayers,
        newToday: extra?.newUsersToday ?? null,
        bots: system.counts.bots,
      }
    : null;

  const activity: DashboardActivity | null = databaseOk
    ? {
        activeMatches: system.counts.liveDuels,
        openBracketMatches: system.counts.openBracketMatches,
        tournamentsRunning: system.counts.tournamentsRunning,
        tournamentsScheduled: system.counts.tournamentsScheduled,
      }
    : null;

  const degradedReason = !databaseOk
    ? "The database did not answer, so player, activity and money figures are unknown — not zero."
    : !extra
      ? "The ledger and signup queries failed. Health above is still live; the money figures are unknown."
      : null;

  return {
    generatedAt: now.toISOString(),
    todayStartedAt: todayStart.toISOString(),
    // The env var is the hard gate on real payments; the feature-flag row
    // cannot override it, so it is the only honest thing to report.
    paymentsEnabled: process.env.PAYMENTS_ENABLED === "true",
    players,
    activity,
    money: extra?.money ?? null,
    health: {
      server: { ok: true, instanceUptimeS: Math.round(process.uptime()) },
      database: system.database,
      realtime: system.realtime,
    },
    degradedReason,
  };
}
