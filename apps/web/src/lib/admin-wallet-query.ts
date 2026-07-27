import { TxKind, prisma, type ListLedgerTransactionsInput } from "@gamearena/db";

/**
 * One parser for the ledger explorer's filters, shared by the list endpoint and
 * the CSV export.
 *
 * The two routes MUST agree about what a filter means, and the reason is not
 * tidiness. The export button on the console is documented as "download what
 * you are looking at" — if `to=2026-07-27` covered the whole day on screen but
 * stopped at midnight in the file, the operator would hand an auditor a CSV
 * that quietly omits a day's transactions and neither of them would ever know.
 * Two copies of this parsing would drift apart on exactly that kind of detail,
 * so there is one copy and both routes call it.
 */

/** Ceiling on one page of the explorer. Mirrors the operations layer's own clamp. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** Long enough for a memo phrase or a full cuid; short of a pasted document. */
const MAX_SEARCH_LENGTH = 200;

const TX_KINDS = new Set<string>(Object.values(TxKind));

export interface ParsedWalletQuery {
  filters: ListLedgerTransactionsInput;
  /**
   * The player the `user` filter resolved to, echoed back so the console can
   * show "filtered to nova71" rather than a cuid the operator never typed.
   */
  resolvedUser: { id: string; username: string } | null;
}

export type ParseWalletQueryResult =
  | { ok: true; value: ParsedWalletQuery }
  | { ok: false; error: string };

/**
 * Read a `kind` filter.
 *
 * Accepts the parameter repeated (`?kind=A&kind=B`) and comma-separated
 * (`?kind=A,B`), because the console builds one form and a human pasting a URL
 * builds the other. An unknown value is refused rather than dropped: silently
 * ignoring a typo would show the operator the unfiltered ledger while their
 * screen claimed a filter was applied, and they would draw conclusions from it.
 */
function parseKinds(params: URLSearchParams): { ok: true; kinds: TxKind[] } | { ok: false; error: string } {
  const raw = params
    .getAll("kind")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);

  const unknown = raw.find((value) => !TX_KINDS.has(value));
  if (unknown) {
    return { ok: false, error: `Unknown transaction kind: ${unknown}` };
  }
  // De-duplicated so a preset that overlaps a hand-picked kind cannot widen the
  // IN () list pointlessly.
  return { ok: true, kinds: [...new Set(raw)] as TxKind[] };
}

/**
 * Read one end of the date range.
 *
 * TIMEZONE, stated plainly because it is the detail that makes an export wrong:
 * a bare `YYYY-MM-DD` is interpreted in UTC, and the console labels the filter
 * as UTC for that reason. The alternative — the server's local timezone — is
 * whatever region the deployment happens to sit in, which is a fact about
 * hosting rather than about the operator, and it changes if the app is ever
 * moved. UTC is at least the same for everyone.
 *
 * `endOfDay` extends a bare date to 23:59:59.999 so that `to=2026-07-27`
 * includes the 27th rather than stopping at its first instant — which would
 * otherwise return an empty range whenever from and to are the same day, the
 * single most common way this filter is used.
 */
function parseBoundary(
  raw: string | null,
  { endOfDay }: { endOfDay: boolean }
): { ok: true; date: Date | null } | { ok: false; error: string } {
  if (!raw?.trim()) return { ok: true, date: null };
  const value = raw.trim();

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : value);

  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: `Could not read the date "${value}" — use YYYY-MM-DD.` };
  }
  return { ok: true, date: parsed };
}

/**
 * Resolve the `user` filter, which accepts a username or a user id.
 *
 * An operator has a name from a support message, not a cuid — but the console's
 * own links pass the id, so both have to work. The id is tried first because it
 * is unambiguous; a username lookup is exact (not a substring) since this is a
 * filter, not a search, and "show me nova7" quietly meaning "nova71, nova72 and
 * nova73" would put three players' money on one screen under one name.
 *
 * A value that matches nothing is an error rather than an empty result, for the
 * same reason the whole DEPOSIT note exists: an empty ledger view is
 * indistinguishable from a broken one, and "no such player" is the fact the
 * operator needs.
 */
async function resolveUser(
  raw: string | null
): Promise<{ ok: true; user: { id: string; username: string } | null } | { ok: false; error: string }> {
  const value = raw?.trim();
  if (!value) return { ok: true, user: null };

  const user = await prisma.user.findFirst({
    where: { OR: [{ id: value }, { usernameLower: value.toLowerCase() }] },
    select: { id: true, username: true },
  });
  if (!user) return { ok: false, error: `No account matches "${value}".` };

  return { ok: true, user };
}

/**
 * Turn a request's query string into ledger filters, or into the message the
 * operator should see.
 *
 * Returns a result rather than throwing so the routes stay flat: every failure
 * here is a 400 that names the offending value, never a 500.
 */
export async function parseWalletQuery(params: URLSearchParams): Promise<ParseWalletQueryResult> {
  const kinds = parseKinds(params);
  if (!kinds.ok) return { ok: false, error: kinds.error };

  const from = parseBoundary(params.get("from"), { endOfDay: false });
  if (!from.ok) return { ok: false, error: from.error };

  const to = parseBoundary(params.get("to"), { endOfDay: true });
  if (!to.ok) return { ok: false, error: to.error };

  if (from.date && to.date && from.date > to.date) {
    return { ok: false, error: "The start of the date range is after its end." };
  }

  const user = await resolveUser(params.get("user"));
  if (!user.ok) return { ok: false, error: user.error };

  const search = params.get("q")?.trim() ?? "";
  if (search.length > MAX_SEARCH_LENGTH) {
    return { ok: false, error: `Search text is too long (max ${MAX_SEARCH_LENGTH} characters).` };
  }

  const rawLimit = Number(params.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(MAX_LIMIT, Math.trunc(rawLimit))
    : DEFAULT_LIMIT;

  return {
    ok: true,
    value: {
      filters: {
        limit,
        cursor: params.get("cursor")?.trim() || null,
        kinds: kinds.kinds,
        userId: user.user?.id ?? null,
        from: from.date,
        to: to.date,
        search: search || null,
      },
      resolvedUser: user.user,
    },
  };
}

/**
 * Whether this deployment can post deposits or withdrawals at all.
 *
 * The env var is the hard gate — the database feature flag of the same name is
 * a soft toggle that the wallet's own buttons already ignore in favour of this
 * one. Read here so the explorer can tell the operator WHY a payments filter is
 * empty instead of leaving them to guess.
 */
export function paymentsEnabled(): boolean {
  return process.env.PAYMENTS_ENABLED === "true";
}
