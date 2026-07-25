/**
 * Double-entry ledger engine. Every money movement on the platform goes
 * through postTransaction(). Invariants enforced here:
 *
 *   1. Every transaction's entries sum to exactly 0 (zero-sum).
 *   2. All amounts are integers (tetri) and non-zero.
 *   3. USER_CASH / USER_VAULT / ESCROW_* accounts can never go negative.
 *      (SYS_TREASURY is the mint — it goes negative by design.)
 *   4. Cached Account.balanceTetri is updated atomically in the same DB
 *      transaction as the entries (verify anytime with `npm run ledger:check`).
 *   5. Optional idempotencyKey makes retries safe (settlements, webhooks).
 */

import { AccountType, Prisma, PrismaClient, TxKind } from "@prisma/client";
import { prisma } from "./client";

type Db = PrismaClient | Prisma.TransactionClient;

// ── Account keys ────────────────────────────────────────────────────────────

export const AccountKeys = {
  userCash: (userId: string) => `USER_CASH:${userId}`,
  userVault: (userId: string) => `USER_VAULT:${userId}`,
  matchEscrow: (matchId: string) => `ESCROW_MATCH:${matchId}`,
  tournamentEscrow: (tournamentId: string) => `ESCROW_TOURNAMENT:${tournamentId}`,
  treasury: () => "SYS_TREASURY",
  rake: () => "SYS_RAKE",
  promo: () => "SYS_PROMO",
} as const;

function parseKey(key: string): {
  type: AccountType;
  userId?: string;
  matchId?: string;
  tournamentId?: string;
} {
  const [head, ref] = key.split(":");
  switch (head) {
    case "USER_CASH":
      return { type: "USER_CASH", userId: ref };
    case "USER_VAULT":
      return { type: "USER_VAULT", userId: ref };
    case "ESCROW_MATCH":
      return { type: "ESCROW_MATCH", matchId: ref };
    case "ESCROW_TOURNAMENT":
      return { type: "ESCROW_TOURNAMENT", tournamentId: ref };
    case "SYS_TREASURY":
      return { type: "SYS_TREASURY" };
    case "SYS_RAKE":
      return { type: "SYS_RAKE" };
    case "SYS_PROMO":
      return { type: "SYS_PROMO" };
    default:
      throw new Error(`Unknown account key: ${key}`);
  }
}

/** Account types that may hold a negative balance (the mint + promo budget). */
const NEGATIVE_ALLOWED: ReadonlySet<AccountType> = new Set<AccountType>([
  "SYS_TREASURY",
  "SYS_PROMO",
]);

export async function ensureAccount(db: Db, key: string) {
  const existing = await db.account.findUnique({ where: { key } });
  if (existing) return existing;
  const parsed = parseKey(key);
  return db.account.upsert({
    where: { key },
    update: {},
    create: { key, ...parsed },
  });
}

// ── Posting ─────────────────────────────────────────────────────────────────

export class InsufficientFundsError extends Error {
  constructor(public accountKey: string, public requestedTetri: number) {
    super(`Insufficient funds on ${accountKey} (tried to move ${requestedTetri} tetri)`);
    this.name = "InsufficientFundsError";
  }
}

export interface PostEntry {
  accountKey: string;
  amountTetri: number; // signed; positive credits the account
}

export interface PostTxInput {
  kind: TxKind;
  entries: PostEntry[];
  memo?: string;
  refType?: string;
  refId?: string;
  idempotencyKey?: string;
  /** Backdating for seeds/imports only — runtime flows never set this. */
  createdAt?: Date;
}

function validate(input: PostTxInput) {
  if (input.entries.length < 2) throw new Error("Ledger tx needs at least 2 entries");
  let sum = 0;
  for (const e of input.entries) {
    if (!Number.isSafeInteger(e.amountTetri)) throw new Error(`Non-integer amount: ${e.amountTetri}`);
    if (e.amountTetri === 0) throw new Error("Zero-amount entry not allowed");
    sum += e.amountTetri;
  }
  if (sum !== 0) throw new Error(`Ledger tx does not balance: sum=${sum} tetri (${input.kind})`);
}

/**
 * Post a balanced transaction atomically. Pass an existing Prisma.TransactionClient
 * as `db` to compose with other writes (e.g. match settlement + status update).
 */
export async function postTransactionIn(db: Prisma.TransactionClient, input: PostTxInput) {
  validate(input);

  if (input.idempotencyKey) {
    const existing = await db.ledgerTransaction.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: { entries: true },
    });
    if (existing) return { tx: existing, alreadyPosted: true as const };
  }

  const tx = await db.ledgerTransaction.create({
    data: {
      kind: input.kind,
      memo: input.memo,
      refType: input.refType,
      refId: input.refId,
      idempotencyKey: input.idempotencyKey,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });

  for (const e of input.entries) {
    const account = await ensureAccount(db, e.accountKey);
    // Atomic increment; then enforce the non-negative floor. Throwing rolls
    // back the surrounding transaction, so partial movements never persist.
    const updated = await db.account.update({
      where: { id: account.id },
      data: { balanceTetri: { increment: e.amountTetri } },
    });
    if (updated.balanceTetri < 0 && !NEGATIVE_ALLOWED.has(updated.type)) {
      throw new InsufficientFundsError(e.accountKey, e.amountTetri);
    }
    await db.ledgerEntry.create({
      data: {
        txId: tx.id,
        accountId: account.id,
        amountTetri: e.amountTetri,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
    });
  }

  return { tx, alreadyPosted: false as const };
}

/** Standalone posting — wraps postTransactionIn in its own DB transaction. */
export async function postTransaction(input: PostTxInput) {
  return prisma.$transaction(async (db) => postTransactionIn(db, input), {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  });
}

// ── Balance reads ───────────────────────────────────────────────────────────

export async function getBalanceTetri(db: Db, accountKey: string): Promise<number> {
  const acc = await db.account.findUnique({ where: { key: accountKey } });
  return acc?.balanceTetri ?? 0;
}

export async function getUserBalances(userId: string) {
  const [cash, vault] = await Promise.all([
    getBalanceTetri(prisma, AccountKeys.userCash(userId)),
    getBalanceTetri(prisma, AccountKeys.userVault(userId)),
  ]);
  return { cashTetri: cash, vaultTetri: vault };
}
