"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { TBody, THead, Td, Th, Tr } from "@/components/ui/table";
import { Note, Panel, useAdminAction } from "../admin-primitives";

/**
 * The ledger explorer.
 *
 * Every other section of this console changes something. This one only reads —
 * and it is the section an operator ends up in whenever a question starts with
 * "where did the money go". It is built around three commitments:
 *
 *   1. BOTH SIDES OF EVERY TRANSACTION ARE ON SCREEN. A list showing only the
 *      player's leg is a bank statement; the question being asked is which
 *      account the money actually came out of, and answering half of it sends
 *      the operator back to the database.
 *   2. AN EMPTY LIST ALWAYS EXPLAINS ITSELF. "No rows" and "this filter can
 *      never have rows" look identical, and confusing them is how an operator
 *      escalates an outage that does not exist — see the payments note below.
 *   3. THE EXPORT MATCHES THE SCREEN. The download link is built from the same
 *      filter state as the list and parsed by the same code server-side, so
 *      "export what I am looking at" is exact rather than approximate.
 */

interface LedgerSide {
  entryId: string;
  accountKey: string;
  accountType: string;
  label: string;
  userId: string | null;
  username: string | null;
  amountTetri: number;
}

interface LedgerTransaction {
  id: string;
  kind: string;
  memo: string | null;
  refType: string | null;
  refId: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  amountTetri: number;
  sides: LedgerSide[];
  balanced: boolean;
}

interface PageMeta {
  kinds: string[];
  demoUnusedKinds: string[];
  paymentsEnabled: boolean;
  resolvedUser: { id: string; username: string } | null;
  notice: string | null;
  message?: string;
}

/**
 * Enum spellings are not operator-facing language. MATCH_PAYOUT tells someone
 * who already knows the schema what they already know; "Match win (settlement)"
 * tells everybody else. The raw kind stays visible in the export, which is
 * where a machine reads it.
 */
const KIND_LABELS: Record<string, string> = {
  SIGNUP_CREDIT: "Signup credit",
  MATCH_STAKE: "Match stake",
  MATCH_PAYOUT: "Match settlement",
  MATCH_REFUND: "Match refund",
  BLITZ_ENTRY: "Blitz entry",
  BLITZ_PAYOUT: "Blitz payout",
  RAKEBACK: "Rakeback",
  BONUS_CREDIT: "Bonus credit",
  VAULT_OPEN: "Vault open",
  VAULT_PRIZE: "Vault prize",
  TOURNAMENT_ENTRY: "Tournament entry",
  TOURNAMENT_PRIZE: "Tournament prize",
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
  ADJUSTMENT: "Adjustment (system)",
  MANUAL_REFUND: "Manual refund",
  ADMIN_ADJUSTMENT: "Admin adjustment",
};

const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

/**
 * Filter presets, because the questions operators actually arrive with are
 * about families of movement rather than single enum members. "Show me the
 * refunds" means both MATCH_REFUND and MANUAL_REFUND, and an operator who picks
 * one of the two and sees a short list has been quietly misled.
 *
 * The single-kind list underneath is generated from the enum the API sends, so
 * a new TxKind appears in this dropdown without anyone remembering to add it.
 */
const KIND_PRESETS = [
  { key: "all", label: "All kinds", kinds: [] as string[] },
  {
    key: "entries",
    label: "Entry fees & stakes",
    kinds: ["TOURNAMENT_ENTRY", "MATCH_STAKE", "BLITZ_ENTRY"],
  },
  {
    key: "prizes",
    label: "Prize payouts",
    kinds: ["TOURNAMENT_PRIZE", "MATCH_PAYOUT", "BLITZ_PAYOUT", "VAULT_PRIZE"],
  },
  { key: "refunds", label: "Refunds", kinds: ["MATCH_REFUND", "MANUAL_REFUND"] },
  {
    key: "manual",
    label: "Manual adjustments",
    kinds: ["ADMIN_ADJUSTMENT", "ADJUSTMENT", "MANUAL_REFUND"],
  },
  {
    key: "credits",
    label: "Signup & bonus credits",
    kinds: ["SIGNUP_CREDIT", "BONUS_CREDIT", "RAKEBACK"],
  },
  { key: "payments", label: "Deposits & withdrawals", kinds: ["DEPOSIT", "WITHDRAWAL"] },
] as const;

/** The filter dropdown's value: either a named preset or one exact kind. */
function kindsForSelection(selection: string): string[] {
  if (selection.startsWith("kind:")) return [selection.slice(5)];
  const preset = KIND_PRESETS.find((p) => `preset:${p.key}` === selection);
  return preset ? [...preset.kinds] : [];
}

interface Filters {
  selection: string;
  user: string;
  from: string;
  to: string;
  q: string;
}

const EMPTY_FILTERS: Filters = { selection: "preset:all", user: "", from: "", to: "", q: "" };

/** The filters as a query string. Shared by the list request and the export link. */
function toQuery(filters: Filters): string {
  const params = new URLSearchParams();
  for (const kind of kindsForSelection(filters.selection)) params.append("kind", kind);
  if (filters.user.trim()) params.set("user", filters.user.trim());
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.q.trim()) params.set("q", filters.q.trim());
  return params.toString();
}

const fieldClass =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-gold";

/**
 * How many legs a transaction can have before its row is collapsed.
 *
 * Most postings have two, and a match settlement has three or four — those show
 * in full, which is what "both sides, legibly" means. But a bulk balance
 * adjustment across twenty-three accounts posts ONE transaction with
 * twenty-four legs, and rendering that inline turns a single row into a screen
 * and a half that buries every transaction after it.
 */
const SIDES_BEFORE_COLLAPSE = 6;

/**
 * The legs shown while a long transaction is collapsed: the largest few from
 * EACH direction, never simply the first few.
 *
 * The sides arrive credits-first, so taking the leading N off a bulk credit
 * would show twenty credits and hide the single treasury debit that funded
 * them — collapsing the row into a half-truth that contradicts the column
 * heading. Taking from both ends keeps both sides of the entry on screen, which
 * is the one thing this cell must never lose.
 */
function collapsedSides<T>(sides: T[]): { head: T[]; hidden: number; tail: T[] } {
  const take = Math.floor(SIDES_BEFORE_COLLAPSE / 2);
  return {
    head: sides.slice(0, take),
    hidden: sides.length - take * 2,
    tail: sides.slice(-take),
  };
}

/** One leg: who moved, and by how much, in the direction it moved. */
function Leg({
  side,
  onPickUser,
}: {
  side: LedgerSide;
  onPickUser: (username: string) => void;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      {side.username ? (
        // The account belongs to a player, so it doubles as a way into their
        // history — chasing "and what else happened to them" is the next thing
        // an operator does about nine times out of ten.
        <button
          type="button"
          onClick={() => onPickUser(side.username!)}
          className="truncate text-left text-fg-secondary hover:text-gold"
          title={`Show everything for ${side.username}`}
        >
          {side.label}
        </button>
      ) : (
        <span className="truncate text-fg-secondary">{side.label}</span>
      )}
      {/* Signed and coloured: this is money moving in and out, which is the one
          place the design system allows green and red. */}
      <Money tetri={side.amountTetri} signed className="shrink-0" />
    </div>
  );
}

/**
 * Both sides of one transaction, one line per leg, credits first.
 *
 * Long postings collapse to the biggest few legs in each direction with the
 * remainder behind a toggle. The count is always stated, so a collapsed row
 * says how much of itself is hidden rather than quietly showing a subset that
 * looks complete.
 */
function DoubleEntry({
  tx,
  expanded,
  onToggle,
  onPickUser,
}: {
  tx: LedgerTransaction;
  expanded: boolean;
  onToggle: () => void;
  onPickUser: (username: string) => void;
}) {
  const long = tx.sides.length > SIDES_BEFORE_COLLAPSE;

  if (!long || expanded) {
    return (
      <div className="min-w-[16rem] space-y-0.5">
        {tx.sides.map((side) => (
          <Leg key={side.entryId} side={side} onPickUser={onPickUser} />
        ))}
        {long && (
          <button
            type="button"
            onClick={onToggle}
            className="pt-0.5 text-2xs uppercase tracking-wider text-faint hover:text-gold"
          >
            Collapse
          </button>
        )}
      </div>
    );
  }

  const { head, hidden, tail } = collapsedSides(tx.sides);
  const credits = tx.sides.filter((s) => s.amountTetri > 0).length;

  return (
    <div className="min-w-[16rem] space-y-0.5">
      {head.map((side) => (
        <Leg key={side.entryId} side={side} onPickUser={onPickUser} />
      ))}
      <button
        type="button"
        onClick={onToggle}
        className="block w-full py-0.5 text-left text-2xs uppercase tracking-wider text-faint hover:text-gold"
      >
        + {hidden} more of {tx.sides.length} legs ({credits} credit
        {credits === 1 ? "" : "s"}, {tx.sides.length - credits} debit
        {tx.sides.length - credits === 1 ? "" : "s"}) — show all
      </button>
      {tail.map((side) => (
        <Leg key={side.entryId} side={side} onPickUser={onPickUser} />
      ))}
    </div>
  );
}

export function WalletSection() {
  const { busy, note, run } = useAdminAction();

  // Two copies of the filter state on purpose. `draft` is what the operator is
  // typing; `applied` is what the screen is currently showing. Without the
  // split, every keystroke in the search box would refetch a page of the
  // ledger, and the operator would watch rows churn under a half-typed name.
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);

  const [rows, setRows] = useState<LedgerTransaction[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);

  // Which long transactions the operator has opened up. Keyed by transaction id
  // rather than by row index, so appending a page cannot re-point an expansion
  // at whichever posting happens to land in that slot.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const query = useMemo(() => toQuery(applied), [applied]);
  const selectedKinds = useMemo(() => kindsForSelection(applied.selection), [applied.selection]);

  /**
   * Fetch a page. `append` distinguishes "load more" from a fresh filter:
   * appending keeps the rows already read, so paging through a long list does
   * not reset the operator's scroll position every time.
   */
  const load = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      const params = new URLSearchParams(query);
      if (nextCursor) params.set("cursor", nextCursor);

      const res = await run(
        append ? "more" : "load",
        `/api/admin/wallet/transactions?${params.toString()}`,
        undefined,
        "GET"
      );
      if (!res.ok) return;

      const data = res.data as unknown as PageMeta & {
        transactions: LedgerTransaction[];
        nextCursor: string | null;
      };
      setRows((prev) => (append && prev ? [...prev, ...data.transactions] : data.transactions));
      setCursor(data.nextCursor);
      setMeta({
        kinds: data.kinds ?? [],
        demoUnusedKinds: data.demoUnusedKinds ?? [],
        paymentsEnabled: data.paymentsEnabled ?? false,
        resolvedUser: data.resolvedUser ?? null,
        notice: data.notice ?? null,
        message: data.message,
      });
    },
    [query, run]
  );

  // Runs on mount and again whenever `applied` changes — which is the only
  // thing `load` closes over. Pressing Apply is therefore the single trigger
  // for a refetch, with no separate effect to keep in sync.
  useEffect(() => {
    void load(null, false);
  }, [load]);

  const toggleExpanded = useCallback((txId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(txId)) next.delete(txId);
      else next.add(txId);
      return next;
    });
  }, []);

  /** Jump straight to one player's history from a row. */
  const filterToUser = useCallback((username: string) => {
    const next = { ...EMPTY_FILTERS, user: username };
    setDraft(next);
    setApplied(next);
  }, []);

  /**
   * Whether the current filter can only ever be empty on this deployment.
   *
   * DEPOSIT and WITHDRAWAL exist in the TxKind enum because the platform was
   * built for real money, but PAYMENTS_ENABLED is false here and no code path
   * posts either kind — so these lists are empty by construction, not by fault.
   * Saying so on screen is the whole point: an empty deposits view is
   * indistinguishable from a broken one, and an operator is right to treat
   * "deposits stopped" as an incident unless something tells them otherwise.
   */
  const showPaymentsNote =
    meta !== null &&
    !meta.paymentsEnabled &&
    selectedKinds.length > 0 &&
    selectedKinds.every((kind) => meta.demoUnusedKinds.includes(kind));

  return (
    <div className="space-y-4">
      <Panel
        title="Ledger explorer"
        hint="Every posting on the platform, newest first. Read-only — corrections are made as new postings elsewhere in this console."
        right={
          <a
            href={`/api/admin/wallet/export?${query}`}
            className={buttonClasses({ variant: "secondary", size: "sm" })}
          >
            Export CSV
          </a>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs text-muted">
            Kind
            <select
              value={draft.selection}
              onChange={(e) => setDraft({ ...draft, selection: e.target.value })}
              className={`mt-1 ${fieldClass}`}
            >
              <optgroup label="Presets">
                {KIND_PRESETS.map((p) => (
                  <option key={p.key} value={`preset:${p.key}`}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
              {/* Built from the enum the API sends, so it cannot go stale. */}
              <optgroup label="One kind only">
                {(meta?.kinds ?? []).map((kind) => (
                  <option key={kind} value={`kind:${kind}`}>
                    {kindLabel(kind)}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>

          <label className="text-xs text-muted">
            Player
            <input
              value={draft.user}
              onChange={(e) => setDraft({ ...draft, user: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && setApplied(draft)}
              placeholder="username or user id"
              className={`mt-1 ${fieldClass}`}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-muted">
              From (UTC)
              <input
                type="date"
                value={draft.from}
                onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                className={`mt-1 ${fieldClass}`}
              />
            </label>
            <label className="text-xs text-muted">
              To (UTC)
              <input
                type="date"
                value={draft.to}
                onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                className={`mt-1 ${fieldClass}`}
              />
            </label>
          </div>

          <label className="text-xs text-muted">
            Search
            <input
              value={draft.q}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && setApplied(draft)}
              placeholder="username, memo or transaction id"
              className={`mt-1 ${fieldClass}`}
            />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" loading={busy === "load"} onClick={() => setApplied(draft)}>
            Apply filters
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              setApplied(EMPTY_FILTERS);
            }}
          >
            Clear
          </Button>
          {meta?.resolvedUser && (
            <Badge tone="gold">filtered to {meta.resolvedUser.username}</Badge>
          )}
          <span className="text-xs text-faint">
            Dates are UTC. Export is one row per ledger entry — both sides of a transaction share a
            transaction id.
          </span>
        </div>

        {/*
          Failures only.
          *
          * These panels only READ, and useAdminAction reports every success —
          * so rendering the banner unconditionally parked a green "Done." under
          * the heading permanently, blinking on each poll. On a console where
          * green means "your money operation succeeded", a page that produces
          * one just by loading teaches an operator to ignore the colour.
        */}
        {note && !note.ok && <Note note={note} />}

        {showPaymentsNote && (
          <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            <span className="font-medium">Deposits and withdrawals do not exist on this
            deployment.</span>{" "}
            The kinds are in the schema because the platform is built for real money, but{" "}
            <span className="font-mono">PAYMENTS_ENABLED</span> is false and nothing posts them —
            this is a demo-credit season. An empty list here is correct and is not a fault to
            escalate.
          </p>
        )}
      </Panel>

      <Panel
        title="Postings"
        hint={
          rows === null
            ? undefined
            : `${rows.length} transaction${rows.length === 1 ? "" : "s"} shown${cursor ? " — more available" : ""}.`
        }
        right={
          <Button size="sm" variant="ghost" loading={busy === "load"} onClick={() => load(null, false)}>
            Refresh
          </Button>
        }
      >
        {rows === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-border bg-bg px-4 py-6 text-center text-sm text-muted">
            {meta?.notice ?? meta?.message ?? "No transactions match these filters."}
          </p>
        ) : (
          <>
            {/*
              The scroll container is the table's own, never the page body.
              The shared <Table> primitive is not used here for exactly this
              reason: its shell is overflow-hidden, which would clip the wide
              columns on a phone instead of letting them scroll. The cell
              primitives underneath are the shared ones, so the styling still
              matches every other table in the product.
            */}
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[820px] text-sm">
                <THead>
                  <Tr>
                    {/*
                      UTC, matching the date filter and the CSV rather than the
                      operator's own clock. Local time here would mean a row
                      stamped "26 Jul 23:30" showing up under a filter for the
                      27th — technically correct in two different timezones and
                      indefensible to anyone reconciling against the export.
                    */}
                    <Th className="whitespace-nowrap">Posted (UTC)</Th>
                    <Th>Kind</Th>
                    <Th>Both sides of the entry</Th>
                    <Th className="text-right">Amount</Th>
                    <Th>Reference</Th>
                  </Tr>
                </THead>
                <TBody>
                  {rows.map((tx) => (
                    <Tr key={tx.id}>
                      <Td className="whitespace-nowrap align-top text-xs text-muted">
                        <div className="tnum">
                          {new Date(tx.createdAt).toLocaleDateString("en-GB", {
                            timeZone: "UTC",
                            day: "2-digit",
                            month: "short",
                            year: "2-digit",
                          })}
                        </div>
                        <div className="tnum text-faint">
                          {new Date(tx.createdAt).toLocaleTimeString("en-GB", {
                            timeZone: "UTC",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </div>
                      </Td>

                      <Td className="align-top">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-fg">{kindLabel(tx.kind)}</span>
                          {/* Must never appear. postTransaction refuses an
                              unbalanced posting, so if one is ever rendered the
                              ledger itself is wrong and that outranks whatever
                              the operator opened this screen for. */}
                          {!tx.balanced && <Badge tone="loss">unbalanced</Badge>}
                        </div>
                        {tx.memo && (
                          <p className="mt-0.5 max-w-[22rem] text-xs text-faint">{tx.memo}</p>
                        )}
                      </Td>

                      <Td className="align-top">
                        <DoubleEntry
                          tx={tx}
                          expanded={expanded.has(tx.id)}
                          onToggle={() => toggleExpanded(tx.id)}
                          onPickUser={filterToUser}
                        />
                      </Td>

                      {/* Neutral, not green: the size of a movement is not a
                          gain to anybody until you know which leg you are on. */}
                      <Td className="whitespace-nowrap text-right align-top">
                        <Money tetri={tx.amountTetri} className="text-fg" />
                      </Td>

                      <Td className="align-top text-xs text-faint">
                        {tx.refType && (
                          <div className="truncate">
                            {tx.refType} · {tx.refId?.slice(-6).toUpperCase()}
                          </div>
                        )}
                        <div className="tnum truncate" title={tx.id}>
                          tx {tx.id.slice(-8).toUpperCase()}
                        </div>
                      </Td>
                    </Tr>
                  ))}
                </TBody>
              </table>
            </div>

            {cursor && (
              <div className="mt-3 flex justify-center">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === "more"}
                  onClick={() => load(cursor, true)}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
