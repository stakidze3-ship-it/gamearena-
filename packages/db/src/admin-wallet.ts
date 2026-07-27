/**
 * The ledger explorer's read layer — every money movement on the platform,
 * filterable, and paged in a way that a growing table cannot break.
 *
 * The wallet section of the admin console answers one question over and over:
 * "where did this money come from, and where did it go?". The ledger already
 * holds the answer perfectly — it is double-entry and it balances — but the raw
 * tables are unreadable to an operator mid-incident: a `LedgerEntry` says
 * account `clx7f2…` moved −500, and finding out that this was nova71 paying a
 * tournament entry takes three joins by hand.
 *
 * So this file does exactly two things the raw query cannot:
 *
 *   1. IT RETURNS BOTH SIDES OF EVERY TRANSACTION, LABELLED. A row that showed
 *      only the player's leg would be a bank statement, not a ledger, and the
 *      question the console exists for — "which account did it actually come
 *      out of?" — would still need the database. Accounts are resolved to names
 *      ("nova71 · cash", "Escrow · Friday Night Knockout") at read time, in
 *      batches, never one query per row.
 *   2. IT PAGES BY CURSOR, NOT BY OFFSET. The ledger only ever grows, and it
 *      grows fastest exactly when an operator is reading it — a tournament
 *      settling posts sixty transactions in a second. Under OFFSET, every row
 *      inserted above the window shifts the whole list down, so "page 2" shows
 *      rows the operator already saw on page 1 and silently skips others.
 *      A cursor is anchored to a row, so new writes above it change nothing.
 *
 * NOTHING HERE WRITES. This is the one part of the admin surface that has no
 * mutating path at all, deliberately: an explorer that could edit the ledger
 * would make the ledger worthless as evidence. Corrections are postings, made
 * through the money operations, and they show up here as new rows — which is
 * the whole point of double-entry bookkeeping.
 */

import { Prisma, type AccountType, type TxKind } from "@prisma/client";
import { prisma } from "./client";

/**
 * The two kinds that exist in the enum and have never been posted here.
 *
 * DEPOSIT and WITHDRAWAL are real TxKinds — the schema was built for a
 * real-money platform and the payment rails are a switch-on, not a rewrite.
 * But this deployment runs on demo credits: `PAYMENTS_ENABLED` is false, there
 * is no payment provider wired up, and no code path anywhere posts either kind.
 *
 * That makes them a trap for the operator, and the trap is specific: filtering
 * the explorer to DEPOSIT returns nothing, and an empty list is exactly what a
 * BROKEN deposits view would also look like. Someone would reasonably conclude
 * that deposits are failing and escalate an outage that does not exist.
 *
 * Exported so the console can say so on screen, next to the empty list, rather
 * than leaving the operator to infer it. Delete this constant the day payments
 * are switched on — at that point an empty deposits view IS worth escalating.
 */
export const DEMO_UNUSED_TX_KINDS: readonly TxKind[] = ["DEPOSIT", "WITHDRAWAL"] as const;

/** One leg of a transaction: which account moved, by how much, in which direction. */
export interface LedgerSideView {
  /** The ENTRY id. Two entries of one transaction can hit the same account. */
  entryId: string;
  accountId: string;
  /** The raw key, e.g. "USER_CASH:clx7f2…". Shown small, for support tickets. */
  accountKey: string;
  accountType: AccountType;
  /** Resolved for humans: "nova71 · cash", "Treasury", "Escrow · <event>". */
  label: string;
  /** Set only for USER_CASH / USER_VAULT, so the console can link to the player. */
  userId: string | null;
  username: string | null;
  /** Signed, in tetri. Positive credits the account, negative debits it. */
  amountTetri: number;
}

/** One transaction as the explorer shows it: the header plus every leg. */
export interface LedgerTransactionView {
  id: string;
  kind: TxKind;
  memo: string | null;
  refType: string | null;
  refId: string | null;
  /** Present on money movements that had to survive a double-click. */
  idempotencyKey: string | null;
  createdAt: Date;
  /**
   * The size of the movement: the sum of the POSITIVE legs.
   *
   * A double-entry transaction has no single "amount" — a ₾5 settlement moves
   * −500 out of escrow and +438/+62 into a winner and rake, and summing all
   * four numbers gives zero by construction. The credits are what actually
   * arrived somewhere, so they are what an operator means by "how much".
   */
  amountTetri: number;
  /** Every leg, credits first, so money's destination reads before its source. */
  sides: LedgerSideView[];
  /**
   * Whether the legs sum to zero. It must always be true — `postTransaction`
   * refuses anything else — so it is surfaced rather than assumed: if the
   * invariant ever breaks, the ledger explorer is where somebody is looking,
   * and a silent unbalanced row would be the one thing worth shouting about.
   */
  balanced: boolean;
}

export interface ListLedgerTransactionsInput {
  /** Page size. Clamped to 1..200 so a hand-typed query cannot pull the table. */
  limit?: number;
  /** `nextCursor` from the previous page. Null or absent starts at the newest. */
  cursor?: string | null;
  /**
   * Restrict to these kinds. Empty or absent means every kind — an empty array
   * is treated as "no filter" rather than "match nothing", because the console
   * sends `[]` for its "All kinds" option and a literal empty IN () would show
   * the operator a blank screen for the default view.
   */
  kinds?: TxKind[] | null;
  /** Every transaction touching this player's cash or vault account. */
  userId?: string | null;
  /** Inclusive lower bound on createdAt. */
  from?: Date | null;
  /** Inclusive upper bound on createdAt. The caller decides where a day ends. */
  to?: Date | null;
  /**
   * Free text across transaction id, memo, reference and player username.
   * See `searchFilter` for why each of those four is matched the way it is.
   */
  search?: string | null;
}

export interface LedgerTransactionPage {
  transactions: LedgerTransactionView[];
  /** Pass back as `cursor` for the next page. Null when this is the last one. */
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Build the search clause.
 *
 * Four different matching rules, because the four things an operator pastes
 * into that box behave differently:
 *
 *   · A TRANSACTION ID is a cuid, and it arrives either whole (copied from this
 *     screen) or truncated (copied from a support ticket that shortened it), so
 *     it is matched as a prefix.
 *   · A REFERENCE — a tournament or match id — is matched exactly. It is never
 *     typed by hand, only pasted, and a prefix match on refId would drag in
 *     unrelated events that happen to share a cuid prefix.
 *   · A MEMO is prose written by whichever code posted the transaction, so it
 *     is a case-insensitive substring.
 *   · A USERNAME is matched against usernameLower, which the register route
 *     maintains — so `contains` on it is already case-insensitive and can use
 *     the index rather than forcing a scan with `mode: "insensitive"`.
 *
 * The username leg is a subquery through entries → account → user and is the
 * expensive one. It is worth it: "show me everything that happened to nova71"
 * without knowing their cuid is the single most common thing support needs, and
 * making them look the id up first would just move the query somewhere slower.
 */
function searchFilter(search: string): Prisma.LedgerTransactionWhereInput {
  const needle = search.trim();
  return {
    OR: [
      { id: { startsWith: needle } },
      { refId: needle },
      { idempotencyKey: { contains: needle } },
      { memo: { contains: needle, mode: "insensitive" } },
      {
        entries: {
          some: { account: { user: { usernameLower: { contains: needle.toLowerCase() } } } },
        },
      },
    ],
  };
}

function buildWhere(input: ListLedgerTransactionsInput): Prisma.LedgerTransactionWhereInput {
  const kinds = input.kinds?.length ? input.kinds : null;
  const search = input.search?.trim() ? input.search.trim() : null;

  return {
    ...(kinds ? { kind: { in: kinds } } : {}),
    ...(input.from || input.to
      ? {
          createdAt: {
            ...(input.from ? { gte: input.from } : {}),
            ...(input.to ? { lte: input.to } : {}),
          },
        }
      : {}),
    // Through the entry relation, because a transaction has no owner of its own
    // — a match settlement belongs to two players, an escrow and the rake
    // account at once, and "whose transaction is this" has no single answer.
    ...(input.userId ? { entries: { some: { account: { userId: input.userId } } } } : {}),
    ...(search ? searchFilter(search) : {}),
  };
}

/**
 * The account shape every label is derived from. Kept as one selection so the
 * page query and the label resolver cannot drift apart.
 */
const ACCOUNT_SELECT = {
  id: true,
  key: true,
  type: true,
  userId: true,
  tournamentId: true,
  matchId: true,
  user: { select: { username: true } },
} satisfies Prisma.AccountSelect;

type AccountRow = Prisma.AccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

/** Short, stable tail of a cuid — enough to tell two escrows apart on screen. */
const shortId = (id: string) => id.slice(-6).toUpperCase();

/**
 * Turn an account into something an operator can read at a glance.
 *
 * Tournament escrows are named from a batch lookup done once per page. When the
 * event has since been deleted the id is shown instead of inventing a name:
 * "Escrow · tournament 7F2K9M" is honest about what is known, where a blank or
 * a guessed label would not be.
 */
function accountLabel(account: AccountRow, tournamentNames: Map<string, string>): string {
  switch (account.type) {
    case "USER_CASH":
    case "USER_VAULT": {
      const wallet = account.type === "USER_CASH" ? "cash" : "vault";
      // A user row can legitimately be missing — an account outlives the player
      // it belonged to if one is ever deleted — and the ledger entry is still
      // real money that moved, so it must stay visible rather than render blank.
      const name = account.user?.username ?? `deleted user ${shortId(account.userId ?? account.id)}`;
      return `${name} · ${wallet}`;
    }
    case "ESCROW_TOURNAMENT": {
      const id = account.tournamentId;
      const name = id ? tournamentNames.get(id) : undefined;
      return name ? `Escrow · ${name}` : `Escrow · tournament ${shortId(id ?? account.id)}`;
    }
    case "ESCROW_MATCH":
      return `Escrow · match ${shortId(account.matchId ?? account.id)}`;
    case "SYS_TREASURY":
      // Named for what it does rather than what it is called: this account is
      // the mint, and its balance is negative by design. An operator who reads
      // "Treasury −₾4,231" as a deficit is reading it wrong.
      return "Treasury (the mint)";
    case "SYS_RAKE":
      return "Rake (platform revenue)";
    case "SYS_PROMO":
      return "Promo budget";
    default:
      return account.key;
  }
}

/**
 * Resolve the tournament names used by one page of results, in one query.
 *
 * Deliberately batched rather than an `include` on the account relation:
 * a page of 50 settlements can reference the same event fifty times, and
 * per-row lookups would issue fifty identical queries to render one screen.
 */
async function loadTournamentNames(accounts: AccountRow[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      accounts
        .filter((a) => a.type === "ESCROW_TOURNAMENT" && a.tournamentId)
        .map((a) => a.tournamentId!)
    ),
  ];
  if (ids.length === 0) return new Map();

  const rows = await prisma.tournament.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((t) => [t.id, t.name]));
}

/**
 * Read one page of the ledger, newest first.
 *
 * Ordered by (createdAt desc, id desc) rather than createdAt alone. Ties are
 * not rare here, they are the normal case: a tournament settlement posts every
 * prize inside one database transaction and they land on the same millisecond.
 * An ordering with ties is not a stable place to anchor a cursor — the same row
 * comes back on two pages, or a row between them is never shown at all.
 *
 * Pagination fetches one extra row and drops it, which answers "is there
 * another page" without a second COUNT over a table that only grows.
 */
export async function listLedgerTransactions(
  input: ListLedgerTransactionsInput = {}
): Promise<LedgerTransactionPage> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(input.limit ?? DEFAULT_LIMIT)));

  const rows = await prisma.ledgerTransaction.findMany({
    where: buildWhere(input),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    // skip: 1 steps past the cursor row itself, which the caller already has.
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    include: {
      entries: {
        // Credits first: "where the money went" is the question, and reading a
        // settlement as "winner +₾8.75, rake +₾1.25, escrow −₾10.00" tells the
        // story in the order an operator thinks it.
        orderBy: { amountTetri: "desc" },
        select: {
          id: true,
          amountTetri: true,
          account: { select: ACCOUNT_SELECT },
        },
      },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const tournamentNames = await loadTournamentNames(page.flatMap((tx) => tx.entries.map((e) => e.account)));

  const transactions: LedgerTransactionView[] = page.map((tx) => {
    const sides: LedgerSideView[] = tx.entries.map((entry) => ({
      entryId: entry.id,
      accountId: entry.account.id,
      accountKey: entry.account.key,
      accountType: entry.account.type,
      label: accountLabel(entry.account, tournamentNames),
      // Only user accounts carry a player. Escrow and system accounts have a
      // null userId in the schema, so this is the honest discriminant for
      // "is this leg a person" rather than parsing the account key.
      userId: entry.account.userId,
      username: entry.account.user?.username ?? null,
      amountTetri: entry.amountTetri,
    }));

    const credited = sides.reduce((sum, s) => sum + (s.amountTetri > 0 ? s.amountTetri : 0), 0);
    const net = sides.reduce((sum, s) => sum + s.amountTetri, 0);

    return {
      id: tx.id,
      kind: tx.kind,
      memo: tx.memo,
      refType: tx.refType,
      refId: tx.refId,
      idempotencyKey: tx.idempotencyKey,
      createdAt: tx.createdAt,
      amountTetri: credited,
      sides,
      balanced: net === 0,
    };
  });

  return {
    transactions,
    nextCursor: hasMore ? (transactions[transactions.length - 1]?.id ?? null) : null,
  };
}

export interface IterateLedgerOptions {
  /** Rows fetched per round trip. Bigger is fewer queries and more memory. */
  pageSize?: number;
  /**
   * Hard ceiling on how many transactions the whole iteration will yield.
   *
   * A runaway guard, not a product limit: an export with no bound is one
   * mistyped date range away from streaming the entire ledger through a
   * serverless function until it is killed mid-file, leaving the operator with
   * a truncated CSV and no indication that it was truncated. The caller is
   * expected to notice the ceiling being hit and say so in its output.
   */
  maxTransactions?: number;
}

const DEFAULT_EXPORT_PAGE_SIZE = 200;
const DEFAULT_MAX_EXPORT_TRANSACTIONS = 100_000;

/**
 * Walk every transaction matching a filter, newest first, one page at a time.
 *
 * Exists for the CSV export, which must not build the whole result in memory:
 * a year of ledger held as a single string is how an export of a busy month
 * takes the admin process down. Yielding page by page lets the route stream
 * each chunk out and forget it.
 *
 * `limit` and `cursor` on the filter are ignored — the iteration owns both, and
 * always starts from the newest matching row. Yields `didTruncate` on the final
 * page so the caller can tell "that was everything" from "that was the ceiling".
 */
export async function* iterateLedgerTransactions(
  filters: ListLedgerTransactionsInput = {},
  options: IterateLedgerOptions = {}
): AsyncGenerator<{ transactions: LedgerTransactionView[]; didTruncate: boolean }> {
  const pageSize = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(options.pageSize ?? DEFAULT_EXPORT_PAGE_SIZE)));
  const maxTransactions = Math.max(
    1,
    Math.trunc(options.maxTransactions ?? DEFAULT_MAX_EXPORT_TRANSACTIONS)
  );

  let cursor: string | null = null;
  let emitted = 0;

  for (;;) {
    const remaining = maxTransactions - emitted;
    if (remaining <= 0) {
      // The ceiling landed exactly on a page boundary. There may or may not be
      // more rows, and claiming either would be a guess — so report truncation,
      // which is the direction that cannot mislead an operator into trusting a
      // short file.
      yield { transactions: [], didTruncate: true };
      return;
    }

    const page: LedgerTransactionPage = await listLedgerTransactions({
      ...filters,
      limit: Math.min(pageSize, remaining),
      cursor,
    });

    emitted += page.transactions.length;
    const didTruncate = page.nextCursor !== null && emitted >= maxTransactions;

    if (page.transactions.length > 0) yield { transactions: page.transactions, didTruncate };

    if (page.nextCursor === null || didTruncate) return;
    cursor = page.nextCursor;
  }
}
