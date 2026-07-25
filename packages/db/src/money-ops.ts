/**
 * High-level money operations composed from ledger postings.
 * These are the ONLY entry points the app uses to move money.
 */

import { Prisma } from "@prisma/client";
import { SIGNUP_CREDIT_TETRI, lariToTetri, settlePot } from "@gamearena/shared";

/** ₾50 promo vault credits on signup so the vault is usable in demo. Idempotent. */
export const SIGNUP_VAULT_CREDIT_TETRI = lariToTetri(50);

/** Referral reward: ₾25 vault credits to both referrer and new player. */
export const REFERRAL_BONUS_TETRI = lariToTetri(25);

export async function grantReferralBonus(referrerId: string, refereeId: string) {
  return prisma.$transaction(async (db) => {
    await mintVaultCreditIn(db, referrerId, REFERRAL_BONUS_TETRI, "Referral reward");
    await mintVaultCreditIn(db, refereeId, REFERRAL_BONUS_TETRI, "Referred welcome bonus");
  });
}
import { prisma } from "./client";
import { AccountKeys, postTransaction, postTransactionIn } from "./ledger";

/**
 * Mint demo credit from treasury to a user (repeatable, not idempotent).
 * Used to keep the demo BOT solvent so its stake can always be escrowed.
 */
export async function mintDemoCreditIn(
  db: Prisma.TransactionClient,
  userId: string,
  amountTetri: number,
  memo = "Demo top-up"
) {
  return postTransactionIn(db, {
    kind: "ADJUSTMENT",
    memo,
    refType: "user",
    refId: userId,
    entries: [
      { accountKey: AccountKeys.treasury(), amountTetri: -amountTetri },
      { accountKey: AccountKeys.userCash(userId), amountTetri },
    ],
  });
}

/** ₾100 demo credit, minted from treasury. Idempotent per user. */
export async function grantSignupCredit(userId: string, createdAt?: Date) {
  return postTransaction({
    kind: "SIGNUP_CREDIT",
    memo: "Welcome demo credit",
    refType: "user",
    refId: userId,
    idempotencyKey: `signup:${userId}`,
    entries: [
      { accountKey: AccountKeys.treasury(), amountTetri: -SIGNUP_CREDIT_TETRI },
      { accountKey: AccountKeys.userCash(userId), amountTetri: SIGNUP_CREDIT_TETRI },
    ],
    createdAt,
  });
}

export async function grantSignupVaultCredit(userId: string, createdAt?: Date) {
  return postTransaction({
    kind: "BONUS_CREDIT",
    memo: "Welcome vault credits",
    refType: "user",
    refId: userId,
    idempotencyKey: `signup-vault:${userId}`,
    entries: [
      { accountKey: AccountKeys.promo(), amountTetri: -SIGNUP_VAULT_CREDIT_TETRI },
      { accountKey: AccountKeys.userVault(userId), amountTetri: SIGNUP_VAULT_CREDIT_TETRI },
    ],
    createdAt,
  });
}

/** Player's stake moves into match escrow (status: locked in escrow account). */
export async function lockStakeIn(
  db: Prisma.TransactionClient,
  matchId: string,
  userId: string,
  stakeTetri: number,
  createdAt?: Date
) {
  return postTransactionIn(db, {
    kind: "MATCH_STAKE",
    refType: "match",
    refId: matchId,
    idempotencyKey: `stake:${matchId}:${userId}`,
    entries: [
      { accountKey: AccountKeys.userCash(userId), amountTetri: -stakeTetri },
      { accountKey: AccountKeys.matchEscrow(matchId), amountTetri: stakeTetri },
    ],
    createdAt,
  });
}

/**
 * Atomic settlement: escrow empties to winner + rake in ONE transaction.
 * payout + rake === pot exactly (settlePot guarantees it).
 */
export async function settleMatchIn(
  db: Prisma.TransactionClient,
  matchId: string,
  winnerUserId: string,
  potTetri: number,
  rakeBps: number,
  createdAt?: Date
) {
  const { payoutTetri, rakeTetri } = settlePot(potTetri, rakeBps);
  const entries = [
    { accountKey: AccountKeys.matchEscrow(matchId), amountTetri: -potTetri },
    { accountKey: AccountKeys.userCash(winnerUserId), amountTetri: payoutTetri },
  ];
  if (rakeTetri > 0) entries.push({ accountKey: AccountKeys.rake(), amountTetri: rakeTetri });
  const res = await postTransactionIn(db, {
    kind: "MATCH_PAYOUT",
    memo: `rake ${(rakeBps / 100).toFixed(rakeBps % 100 === 0 ? 0 : 1)}%`,
    refType: "match",
    refId: matchId,
    idempotencyKey: `settle:${matchId}`,
    entries,
    createdAt,
  });
  return { ...res, payoutTetri, rakeTetri };
}

/** Draw or cancellation: both stakes return, no rake. */
export async function refundMatchIn(
  db: Prisma.TransactionClient,
  matchId: string,
  refunds: { userId: string; amountTetri: number }[]
) {
  return postTransactionIn(db, {
    kind: "MATCH_REFUND",
    refType: "match",
    refId: matchId,
    idempotencyKey: `refund:${matchId}`,
    entries: [
      {
        accountKey: AccountKeys.matchEscrow(matchId),
        amountTetri: -refunds.reduce((s, r) => s + r.amountTetri, 0),
      },
      ...refunds.map((r) => ({
        accountKey: AccountKeys.userCash(r.userId),
        amountTetri: r.amountTetri,
      })),
    ],
  });
}

/** Blitz entry: player pays the house (treasury absorbs entries, pays prizes). */
export async function payBlitzEntryIn(
  db: Prisma.TransactionClient,
  runId: string,
  userId: string,
  entryTetri: number
) {
  return postTransactionIn(db, {
    kind: "BLITZ_ENTRY",
    refType: "blitz",
    refId: runId,
    idempotencyKey: `blitz-entry:${runId}`,
    entries: [
      { accountKey: AccountKeys.userCash(userId), amountTetri: -entryTetri },
      { accountKey: AccountKeys.treasury(), amountTetri: entryTetri },
    ],
  });
}

export async function payBlitzPrizeIn(
  db: Prisma.TransactionClient,
  runId: string,
  userId: string,
  payoutTetri: number
) {
  if (payoutTetri <= 0) return null; // score below floor — no payout tx
  return postTransactionIn(db, {
    kind: "BLITZ_PAYOUT",
    refType: "blitz",
    refId: runId,
    idempotencyKey: `blitz-payout:${runId}`,
    entries: [
      { accountKey: AccountKeys.treasury(), amountTetri: -payoutTetri },
      { accountKey: AccountKeys.userCash(userId), amountTetri: payoutTetri },
    ],
  });
}

// ─────────────────────────── Vault ───────────────────────────

/** Mint promo vault credits to a user (funded by SYS_PROMO). */
export async function mintVaultCreditIn(
  db: Prisma.TransactionClient,
  userId: string,
  amountTetri: number,
  memo = "Vault credit"
) {
  return postTransactionIn(db, {
    kind: "BONUS_CREDIT",
    memo,
    refType: "user",
    refId: userId,
    entries: [
      { accountKey: AccountKeys.promo(), amountTetri: -amountTetri },
      { accountKey: AccountKeys.userVault(userId), amountTetri: amountTetri },
    ],
  });
}

/**
 * Open a vault: spend `priceTetri` of vault credits, win `prizeTetri` cash.
 * The promo account absorbs the house edge (price − prize) and may go negative.
 */
export async function openVaultIn(
  db: Prisma.TransactionClient,
  openId: string,
  userId: string,
  priceTetri: number,
  prizeTetri: number
) {
  const entries: { accountKey: string; amountTetri: number }[] = [
    { accountKey: AccountKeys.userVault(userId), amountTetri: -priceTetri },
  ];
  if (prizeTetri > 0) entries.push({ accountKey: AccountKeys.userCash(userId), amountTetri: prizeTetri });
  const net = priceTetri - prizeTetri;
  if (net !== 0) entries.push({ accountKey: AccountKeys.promo(), amountTetri: net });
  return postTransactionIn(db, {
    kind: "VAULT_OPEN",
    memo: "Vault open",
    refType: "vault",
    refId: openId,
    idempotencyKey: `vault:${openId}`,
    entries,
  });
}

// ─────────────────────────── Tournaments ───────────────────────────

export async function registerTournamentEntryIn(
  db: Prisma.TransactionClient,
  tournamentId: string,
  userId: string,
  entryTetri: number
) {
  // A free entry moves no money. The ledger rightly refuses zero-amount
  // entries, so posting one would fail the whole registration.
  if (entryTetri <= 0) return null;
  return postTransactionIn(db, {
    kind: "TOURNAMENT_ENTRY",
    refType: "tournament",
    refId: tournamentId,
    idempotencyKey: `tourney-entry:${tournamentId}:${userId}`,
    entries: [
      { accountKey: AccountKeys.userCash(userId), amountTetri: -entryTetri },
      { accountKey: AccountKeys.tournamentEscrow(tournamentId), amountTetri: entryTetri },
    ],
  });
}

/**
 * Settle a tournament: empty the escrow pool to the winners. Any leftover
 * (shares summing under the pool) becomes rake; a guaranteed shortfall is
 * funded from treasury — one balancing entry covers whichever way it goes.
 */
export async function settleTournamentIn(
  db: Prisma.TransactionClient,
  tournamentId: string,
  poolTetri: number,
  winners: { userId: string; prizeTetri: number }[]
) {
  const totalPrizes = winners.reduce((s, w) => s + w.prizeTetri, 0);
  const diff = poolTetri - totalPrizes; // >0 keep as rake, <0 treasury tops up
  const entries: { accountKey: string; amountTetri: number }[] = [
    // A freeroll escrows nothing; its prizes come entirely from the guarantee,
    // and a zero-amount escrow entry would be rejected by the ledger.
    ...(poolTetri > 0
      ? [{ accountKey: AccountKeys.tournamentEscrow(tournamentId), amountTetri: -poolTetri }]
      : []),
    ...winners
      .filter((w) => w.prizeTetri > 0)
      .map((w) => ({ accountKey: AccountKeys.userCash(w.userId), amountTetri: w.prizeTetri })),
  ];
  if (diff > 0) entries.push({ accountKey: AccountKeys.rake(), amountTetri: diff });
  else if (diff < 0) entries.push({ accountKey: AccountKeys.treasury(), amountTetri: diff });

  return postTransactionIn(db, {
    kind: "TOURNAMENT_PRIZE",
    memo: "Tournament settlement",
    refType: "tournament",
    refId: tournamentId,
    idempotencyKey: `tourney-settle:${tournamentId}`,
    entries,
  });
}

export { prisma };
