"use client";

import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatTetri, lariToTetri } from "@gamearena/shared";
import {
  ConfirmDialog,
  Note,
  Panel,
  useAdminAction,
  type ActionResult,
  type ConfirmSpec,
} from "../admin-primitives";

interface FoundUser {
  id: string;
  username: string;
  email: string;
  role: string;
  status: string;
  isBot: boolean;
  balanceTetri: number;
  lastSeenAt: string | null;
  createdAt: string;
}

interface Profile extends FoundUser {
  transactions: { id: string; kind: string; amountTetri: number; memo: string | null; at: string }[];
  tournaments: { id: string; name: string; rank: number | null; prizeTetri: number | null }[];
}

/** What GET /api/admin/users/reset-all reports the sweep would do. */
interface ResetAllPreview {
  targetTetri: number;
  eligibleCount: number;
  affectedCount: number;
  alreadyAtTargetCount: number;
  netTetri: number;
  grossTetri: number;
  creditedCount: number;
  debitedCount: number;
  includeAdmins: boolean;
  includeBots: boolean;
  maxAccounts: number;
  overCap: boolean;
}

/**
 * User administration.
 *
 * Search first, then act — either on one account, or on a set the operator has
 * picked out by hand. The bulk tools are deliberately gated behind an explicit
 * selection rather than offered as a filter: a query that selects the wrong
 * rows pays the wrong people, and by the time anyone notices, the money has
 * moved. The one filtered sweep that exists lives in the danger zone at the
 * bottom, separated from everything else and unreachable without first loading
 * a preview of exactly what it would do.
 */
export function UsersSection() {
  const { busy, note, setNote, run } = useAdminAction();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundUser[] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [amountLari, setAmountLari] = useState("5");
  const [reason, setReason] = useState("");
  const [targetLari, setTargetLari] = useState("5");

  // Bulk selection, keyed by user id rather than by row index: the results list
  // is re-fetched after every money movement, and an index-based selection
  // would silently re-point at whoever landed in that slot next.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAmountLari, setBulkAmountLari] = useState("5");
  const [bulkReason, setBulkReason] = useState("");

  // Danger zone. The preview is held separately from the shared `note` banner
  // so that loading it cannot wipe the result of whatever the operator did last.
  const [includeAdmins, setIncludeAdmins] = useState(false);
  const [includeBots, setIncludeBots] = useState(false);
  /**
   * The sweep's own reason field, deliberately NOT shared with the per-player
   * one above. Sharing them would carry "goodwill refund for giorgi_t" into the
   * memo of the transaction that reset the balance of every account on the
   * platform — and that memo is the first thing anyone reading that transaction
   * afterwards has to go on.
   */
  const [resetReason, setResetReason] = useState("");
  const [preview, setPreview] = useState<ResetAllPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  /**
   * Throw away a loaded preview.
   *
   * Called whenever a filter changes, because the numbers on screen were
   * computed for the OLD filters and the reset button is disabled without a
   * preview. That is the whole safety property of this panel: the sweep can
   * only be fired against a filter combination the operator has actually seen
   * the consequences of.
   */
  const invalidatePreview = useCallback(() => {
    setPreview(null);
    setPreviewError(null);
  }, []);

  const loadPreview = useCallback(async () => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const params = new URLSearchParams({
        includeAdmins: String(includeAdmins),
        includeBots: String(includeBots),
      });
      const res = await fetch(`/api/admin/users/reset-all?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPreview(null);
        setPreviewError(typeof data.error === "string" ? data.error : `Preview failed (${res.status})`);
        return;
      }
      setPreview(data.preview as ResetAllPreview);
    } catch (err) {
      // A failed preview must leave the button disabled rather than fall back
      // to "probably fine" — this is the one control where guessing costs the
      // whole user base their balance.
      setPreview(null);
      setPreviewError(err instanceof Error ? err.message : "Network error");
    } finally {
      setPreviewing(false);
    }
  }, [includeAdmins, includeBots]);

  async function search() {
    const res = await run(
      "search",
      `/api/admin/users/search?q=${encodeURIComponent(query)}`,
      undefined,
      "GET"
    );
    if (res.ok) {
      setResults((res.data?.users as FoundUser[]) ?? []);
      // Cleared on every new search. A selection carried over from the previous
      // result set is a batch aimed at accounts the operator can no longer see.
      setSelected(new Set());
    }
  }

  async function open(id: string) {
    const res = await run(`profile-${id}`, `/api/admin/users/${id}`, undefined, "GET");
    if (res.ok) setProfile((res.data?.user as Profile) ?? null);
  }

  /**
   * Re-read whatever is on screen, so balances stop being stale the moment
   * money moves — then put the operation's own message back.
   *
   * The re-reads go through `run`, which owns the single result banner, so
   * without restoring it the operator would watch "Credited ₾3.00 to 2
   * accounts" be replaced by "12 accounts matched" before they had read it.
   * On the bulk tools that message is the only confirmation of what just
   * happened to somebody else's money.
   */
  async function refresh(result: ActionResult, userId?: string) {
    if (userId) await open(userId);
    if (results && query.trim()) await search();
    setNote(result);
  }

  async function adjust(user: Profile, signedLari: number) {
    const amountTetri = lariToTetri(Math.abs(signedLari)) * Math.sign(signedLari);
    const res = await run(`balance-${user.id}`, `/api/admin/users/${user.id}/balance`, {
      amountTetri,
      reason: reason.trim() || (signedLari > 0 ? "Admin credit" : "Admin debit"),
      // A fresh reference per press: two deliberate ₾5 credits are a legitimate
      // thing to do, and an idempotency key that collapsed them would silently
      // swallow the second.
      reference: `console-${Date.now()}`,
    });
    if (res.ok) open(user.id);
  }

  async function setExact(user: Profile, lari: number) {
    const res = await run(`set-balance-${user.id}`, `/api/admin/users/${user.id}/set-balance`, {
      targetTetri: lariToTetri(lari),
      reason: reason.trim() || "Admin balance correction",
      reference: `console-set-${Date.now()}`,
    });
    if (res.ok) refresh(res, user.id);
  }

  async function bulkAdjust(signedLari: number) {
    const userIds = [...selected];
    const amountTetri = lariToTetri(Math.abs(signedLari)) * Math.sign(signedLari);
    const res = await run("bulk-balance", "/api/admin/users/bulk-balance", {
      userIds,
      amountTetri,
      reason: bulkReason.trim() || (signedLari > 0 ? "Bulk admin credit" : "Bulk admin debit"),
      // Deliberately NO reference.
      //
      // A fresh clock-based reference per press is fine for a single ₾5 credit,
      // where pressing twice genuinely means "pay twice". It is not fine for a
      // batch: re-confirming after an ambiguous result would pay every selected
      // account a second time, and the ledger could not tell the two batches
      // apart. Omitting it lets the route derive the key from the batch itself,
      // so a retry of the SAME batch is a no-op however long the gap.
    });
    if (res.ok) {
      setSelected(new Set());
      refresh(res, profile?.id);
    }
  }

  // Bots are excluded from selection rather than refused after the fact: the
  // API rejects a batch containing one, and a checkbox that can build a batch
  // guaranteed to bounce is a trap rather than a feature.
  const selectableResults = (results ?? []).filter((u) => !u.isBot);
  const allSelected =
    selectableResults.length > 0 && selectableResults.every((u) => selected.has(u.id));

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-4">
      <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} />

      <Panel title="Find a player" hint="Search by username or email.">
        <div className="flex flex-wrap gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="username or email"
            className="min-w-[240px] flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-gold"
          />
          <Button variant="primary" loading={busy === "search"} onClick={search}>
            Search
          </Button>
        </div>
        <Note note={note} />

        {results && results.length === 0 && (
          <p className="mt-3 text-sm text-muted">No accounts matched.</p>
        )}
        {results && results.length > 0 && (
          <>
            {selectableResults.length > 0 && (
              <label className="mt-3 flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() =>
                    setSelected(allSelected ? new Set() : new Set(selectableResults.map((u) => u.id)))
                  }
                  className="h-4 w-4 accent-gold"
                />
                Select all {selectableResults.length} on this page
              </label>
            )}

            <div className="mt-2 space-y-1.5">
              {results.map((u) => (
                <div
                  key={u.id}
                  className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-bg px-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(u.id)}
                    onChange={() => toggleOne(u.id)}
                    disabled={u.isBot}
                    aria-label={
                      u.isBot
                        ? `${u.username} is a bot and cannot be included in a batch`
                        : `Select ${u.username}`
                    }
                    title={u.isBot ? "Bot balances are managed by the tournament funding sweep." : undefined}
                    className="h-4 w-4 shrink-0 accent-gold disabled:opacity-30"
                  />
                  <button
                    type="button"
                    onClick={() => open(u.id)}
                    className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2 text-left hover:text-gold"
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{u.username}</span>
                      <span className="text-faint">{u.email}</span>
                      {u.isBot && <Badge tone="neutral">bot</Badge>}
                      {u.role === "ADMIN" && <Badge tone="gold">admin</Badge>}
                      {u.status !== "ACTIVE" && <Badge tone="neutral">{u.status}</Badge>}
                    </span>
                    <span className="tabular-nums text-muted">{formatTetri(u.balanceTetri)}</span>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {/*
          Bulk bar.
          *
          * Appears only once something is selected, and states the count in
          * every label rather than saying "selected" — "Credit 12 accounts" is
          * a sentence an operator checks against the screen, "credit selected"
          * is one they press.
        */}
        {selected.size > 0 && (
          <div className="mt-3 rounded-xl border border-gold/30 bg-gold/5 px-3.5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium">
                {selected.size} {selected.size === 1 ? "account" : "accounts"} selected
              </p>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="text-xs text-muted hover:text-fg"
              >
                Clear selection
              </button>
            </div>

            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="text-xs text-muted">
                Amount ₾ each
                <input
                  value={bulkAmountLari}
                  onChange={(e) => setBulkAmountLari(e.target.value)}
                  inputMode="decimal"
                  className="mt-1 block w-24 rounded-lg border border-border bg-surface px-2.5 py-2 text-sm tabular-nums text-fg outline-none focus:border-gold"
                />
              </label>
              <label className="min-w-[180px] flex-1 text-xs text-muted">
                Reason (recorded in the ledger)
                <input
                  value={bulkReason}
                  onChange={(e) => setBulkReason(e.target.value)}
                  placeholder="e.g. refund for cancelled event"
                  className="mt-1 block w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-fg outline-none focus:border-gold"
                />
              </label>

              <Button
                size="sm"
                variant="primary"
                loading={busy === "bulk-balance"}
                onClick={() => {
                  const lari = Number(bulkAmountLari) || 0;
                  setConfirm({
                    title: `Credit ₾${lari} to ${selected.size} accounts?`,
                    confirmLabel: `Credit ${selected.size} accounts`,
                    body: (
                      <>
                        Each selected account is credited{" "}
                        <span className="text-fg">{formatTetri(lariToTetri(Math.abs(lari)))}</span>,
                        for a total of{" "}
                        <span className="text-fg">
                          {formatTetri(lariToTetri(Math.abs(lari)) * selected.size)}
                        </span>
                        .
                      </>
                    ),
                    consequences: [
                      "The whole batch posts as one ledger transaction — it either pays everybody or nobody.",
                      "Players are not notified.",
                      "Reversing it means debiting each account back.",
                    ],
                    onConfirm: () => bulkAdjust(lari),
                  });
                }}
              >
                Credit {selected.size}
              </Button>

              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const lari = Number(bulkAmountLari) || 0;
                  setConfirm({
                    title: `Remove ₾${lari} from ${selected.size} accounts?`,
                    danger: true,
                    confirmLabel: `Debit ${selected.size} accounts`,
                    body: (
                      <>
                        Each selected account is debited{" "}
                        <span className="text-fg">{formatTetri(lariToTetri(Math.abs(lari)))}</span>,
                        for a total of{" "}
                        <span className="text-fg">
                          {formatTetri(lariToTetri(Math.abs(lari)) * selected.size)}
                        </span>
                        .
                      </>
                    ),
                    consequences: [
                      "If even one account cannot afford it, the whole batch is refused and nothing moves.",
                      "Players are not notified.",
                    ],
                    onConfirm: () => bulkAdjust(-lari),
                  });
                }}
              >
                Debit {selected.size}
              </Button>
            </div>
          </div>
        )}
      </Panel>

      {profile && (
        <Panel
          title={profile.username}
          hint={`${profile.email} · joined ${new Date(profile.createdAt).toLocaleDateString()}`}
          right={
            <div className="text-right">
              <div className="text-2xs uppercase tracking-wider text-faint">Balance</div>
              <div className="font-display text-xl font-semibold tabular-nums">
                {formatTetri(profile.balanceTetri)}
              </div>
            </div>
          }
        >
          {/* Money */}
          <div className="rounded-xl border border-border bg-bg px-3.5 py-3">
            <p className="text-xs font-medium">Adjust balance</p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="text-xs text-muted">
                Amount ₾
                <input
                  value={amountLari}
                  onChange={(e) => setAmountLari(e.target.value)}
                  inputMode="decimal"
                  className="mt-1 block w-24 rounded-lg border border-border bg-surface px-2.5 py-2 text-sm tabular-nums text-fg outline-none focus:border-gold"
                />
              </label>
              <label className="min-w-[180px] flex-1 text-xs text-muted">
                Reason (recorded in the ledger)
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. goodwill refund"
                  className="mt-1 block w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-fg outline-none focus:border-gold"
                />
              </label>
              <Button
                size="sm"
                variant="primary"
                loading={busy === `balance-${profile.id}`}
                onClick={() => adjust(profile, Number(amountLari) || 0)}
              >
                Add money
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setConfirm({
                    title: `Remove ₾${amountLari} from ${profile.username}?`,
                    danger: true,
                    confirmLabel: "Remove money",
                    body: <>This debits a real player balance and is recorded in the ledger.</>,
                    consequences: ["The player is not notified.", "It cannot be reversed except by crediting it back."],
                    onConfirm: () => adjust(profile, -(Number(amountLari) || 0)),
                  })
                }
              >
                Remove money
              </Button>
            </div>
          </div>

          {/*
            Set an exact balance.
            *
            * Separate from the adjustment control above because it answers a
            * different question. "Credit ₾5" is an adjustment; "this account
            * should be showing ₾20" is a target, and making the operator
            * subtract the current balance themselves — off a figure that may
            * have gone stale since this panel rendered — is how the wrong
            * number gets typed. The server does the subtraction against a
            * balance read at the moment of the write, and moves the difference.
          */}
          <div className="mt-3 rounded-xl border border-border bg-bg px-3.5 py-3">
            <p className="text-xs font-medium">Set exact balance</p>
            <p className="mt-0.5 text-2xs text-faint">
              Moves the difference through the ledger — it never writes a balance.
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="text-xs text-muted">
                Should end up at ₾
                <input
                  value={targetLari}
                  onChange={(e) => setTargetLari(e.target.value)}
                  inputMode="decimal"
                  className="mt-1 block w-28 rounded-lg border border-border bg-surface px-2.5 py-2 text-sm tabular-nums text-fg outline-none focus:border-gold"
                />
              </label>
              <Button
                size="sm"
                variant="ghost"
                loading={busy === `set-balance-${profile.id}`}
                onClick={() => {
                  const lari = Number(targetLari) || 0;
                  const targetTetri = lariToTetri(lari);
                  const deltaTetri = targetTetri - profile.balanceTetri;
                  setConfirm({
                    title: `Set ${profile.username} to ${formatTetri(targetTetri)}?`,
                    danger: deltaTetri < 0,
                    confirmLabel: "Set balance",
                    body: (
                      <>
                        {profile.username} is holding{" "}
                        <span className="text-fg">{formatTetri(profile.balanceTetri)}</span>. This{" "}
                        {deltaTetri === 0 ? (
                          <>is already the target, so nothing will move.</>
                        ) : (
                          <>
                            {deltaTetri > 0 ? "credits" : "debits"}{" "}
                            <span className="text-fg">{formatTetri(Math.abs(deltaTetri))}</span>.
                          </>
                        )}
                      </>
                    ),
                    consequences: [
                      "The difference is posted against treasury as a normal double-entry transaction.",
                      "The balance shown here may be seconds old — the server recomputes the difference against the live balance.",
                    ],
                    onConfirm: () => setExact(profile, lari),
                  });
                }}
              >
                Set balance
              </Button>
            </div>
          </div>

          {/* Access */}
          <div className="mt-3 flex flex-wrap gap-2">
            {/*
              One control, not two.
              *
              * The schema has exactly one "may not sign in" column
              * (User.suspendedAt). Freeze and ban both write it, so offering
              * them as separate buttons would imply two states that do not
              * exist — and an operator who "unfroze" someone expecting them to
              * still be banned would be wrong. A real ban tier needs its own
              * column; until then this says what actually happens.
            */}
            <Button
              size="sm"
              variant="ghost"
              loading={busy === `freeze-${profile.id}`}
              onClick={() => {
                const suspending = profile.status === "ACTIVE";
                const act = async () => {
                  const res = await run(
                    `freeze-${profile.id}`,
                    `/api/admin/users/${profile.id}/freeze`,
                    { frozen: suspending }
                  );
                  if (res.ok) open(profile.id);
                };
                if (!suspending) return act();
                setConfirm({
                  title: `Suspend ${profile.username}?`,
                  danger: true,
                  confirmLabel: "Suspend account",
                  body: (
                    <>
                      Signs the account out and blocks it from playing, entering events or
                      logging back in.
                    </>
                  ),
                  consequences: [
                    "Freeze and ban are the same state on this platform — there is one suspension flag, not two.",
                    "Any balance stays in the account.",
                    "Open tournament entries are not automatically refunded — remove them from the event separately if needed.",
                  ],
                  onConfirm: act,
                });
              }}
            >
              {profile.status === "ACTIVE" ? "Suspend (freeze / ban)" : "Restore access"}
            </Button>

            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setConfirm({
                  title: `Reset ${profile.username} to the signup balance?`,
                  confirmLabel: "Reset balance",
                  body: <>Sets this account back to the ₾5 demo grant exactly.</>,
                  consequences: [
                    `Current balance is ${formatTetri(profile.balanceTetri)} — the difference is written to treasury.`,
                  ],
                  onConfirm: async () => {
                    const res = await run(
                      `reset-${profile.id}`,
                      `/api/admin/users/${profile.id}/reset-demo-balance`
                    );
                    if (res.ok) open(profile.id);
                  },
                })
              }
            >
              Reset demo balance
            </Button>
          </div>

          {/* Wallet history */}
          {profile.transactions.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-xs font-medium text-muted">Recent wallet activity</p>
              <div className="space-y-1">
                {profile.transactions.slice(0, 8).map((tx) => (
                  <div
                    key={tx.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg px-3 py-1.5 text-xs"
                  >
                    <span className="min-w-0 truncate">
                      <span className="font-mono text-faint">{tx.kind}</span>{" "}
                      <span className="text-muted">{tx.memo}</span>
                    </span>
                    <span
                      className={`tabular-nums ${tx.amountTetri >= 0 ? "text-emerald-300" : "text-red-300"}`}
                    >
                      {tx.amountTetri >= 0 ? "+" : "−"}
                      {formatTetri(Math.abs(tx.amountTetri))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Panel>
      )}

      {/*
        DANGER ZONE.
        *
        * Visually separated from everything above, and last on the page, because
        * it is the only control here that touches accounts the operator has not
        * individually looked at. The safety property is structural rather than
        * decorative: the sweep button is disabled until a preview has been
        * loaded, and changing either filter throws the preview away — so it is
        * not possible to fire this against a set of accounts whose real count
        * and real total have not been on screen first.
      */}
      <section className="rounded-2xl border border-red-500/40 bg-red-500/[0.04] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-medium text-red-300">Danger zone</h3>
            <p className="mt-0.5 text-sm text-muted">
              Rewrites the cash balance of every account matching the filters, in one transaction.
            </p>
          </div>
          <Badge tone="loss">irreversible</Badge>
        </div>

        <div className="mt-4 rounded-xl border border-border bg-bg px-3.5 py-3">
          <p className="text-xs font-medium">Reset all balances to the signup grant</p>

          <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-2">
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={includeAdmins}
                onChange={(e) => {
                  setIncludeAdmins(e.target.checked);
                  invalidatePreview();
                }}
                className="h-4 w-4 accent-gold"
              />
              Include admin accounts
              <span className="text-faint">(off by default — this includes you)</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={includeBots}
                onChange={(e) => {
                  setIncludeBots(e.target.checked);
                  invalidatePreview();
                }}
                className="h-4 w-4 accent-gold"
              />
              Include bots
              <span className="text-faint">(off by default — bot money is swept by their events)</span>
            </label>
          </div>

          <label className="mt-3 block text-xs text-muted">
            Reason (written into the ledger transaction that moves everybody&apos;s money)
            <input
              value={resetReason}
              onChange={(e) => setResetReason(e.target.value)}
              placeholder="e.g. resetting the demo economy before launch"
              className="mt-1 block w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-sm text-fg outline-none focus:border-gold"
            />
          </label>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" loading={previewing} onClick={loadPreview}>
              {preview ? "Refresh preview" : "Check what this would do"}
            </Button>

            <Button
              size="sm"
              variant="ghost"
              className="border border-red-500/40 text-red-300 hover:bg-red-500/10"
              // Disabled without a loaded preview, and disabled when the preview
              // says the sweep would be refused. Both states are explained in
              // the line below rather than left as a dead button.
              disabled={!preview || preview.overCap || preview.affectedCount === 0 || previewing}
              loading={busy === "reset-all"}
              onClick={() => {
                if (!preview) return;
                setConfirm({
                  title: `Reset ${preview.affectedCount} balances to ${formatTetri(preview.targetTetri)}?`,
                  danger: true,
                  confirmLabel: `Reset ${preview.affectedCount} accounts`,
                  typeToConfirm: "RESET ALL",
                  body: (
                    <>
                      <span className="text-fg">{preview.affectedCount}</span> of{" "}
                      {preview.eligibleCount} selected accounts will move, and{" "}
                      <span className="text-fg">{formatTetri(preview.grossTetri)}</span> will change
                      hands in total.{" "}
                      {preview.creditedCount > 0 && (
                        <>
                          {preview.creditedCount} topped up
                          {preview.debitedCount > 0 ? ", " : ". "}
                        </>
                      )}
                      {preview.debitedCount > 0 && <>{preview.debitedCount} drawn down. </>}
                      {preview.alreadyAtTargetCount > 0 && (
                        <>
                          {preview.alreadyAtTargetCount} are already on the grant and are left
                          alone.
                        </>
                      )}
                    </>
                  ),
                  consequences: [
                    preview.includeAdmins
                      ? "ADMIN ACCOUNTS ARE INCLUDED — your own balance will be reset too."
                      : "Admin accounts are excluded.",
                    preview.includeBots
                      ? "BOT ACCOUNTS ARE INCLUDED — their events sweep those balances back to treasury, so this can leave a treasury drift."
                      : "Bot accounts are excluded.",
                    "It runs as one transaction: every account resets or none does. While it runs, no money can move anywhere on the platform.",
                    "There is no undo. The only way back is to re-credit each account by hand.",
                    "These figures were read a moment ago — the sweep recomputes them against live balances.",
                  ],
                  onConfirm: async () => {
                    const res = await run("reset-all", "/api/admin/users/reset-all", {
                      includeAdmins,
                      includeBots,
                      reason: resetReason.trim() || "Bulk balance reset",
                    });
                    // Whatever happened, the preview on screen is now describing
                    // a world that no longer exists.
                    invalidatePreview();
                    if (res.ok) refresh(res, profile?.id);
                  },
                });
              }}
            >
              Reset all balances
            </Button>
          </div>

          {previewError && (
            <p className="mt-2.5 text-xs text-red-300">{previewError}</p>
          )}

          {!preview && !previewError && (
            <p className="mt-2.5 text-xs text-faint">
              Load a preview first — the sweep stays disabled until its real numbers are on screen.
            </p>
          )}

          {preview && (
            <div className="mt-3 space-y-1.5 rounded-lg border border-border bg-surface px-3 py-2.5 text-xs">
              <p>
                <span className="font-display text-base font-semibold tabular-nums text-fg">
                  {preview.affectedCount}
                </span>{" "}
                <span className="text-muted">
                  of {preview.eligibleCount} selected accounts would move
                </span>
              </p>
              <p className="text-muted">
                <span className="tabular-nums text-fg">{formatTetri(preview.grossTetri)}</span> would
                change hands ({preview.creditedCount} topped up, {preview.debitedCount} drawn down,{" "}
                {preview.alreadyAtTargetCount} already on the grant).
              </p>
              <p className="text-muted">
                Treasury{" "}
                {preview.netTetri === 0 ? (
                  <span className="text-fg">is unchanged</span>
                ) : preview.netTetri > 0 ? (
                  <>
                    mints{" "}
                    <span className="tabular-nums text-emerald-300">
                      {formatTetri(preview.netTetri)}
                    </span>{" "}
                    into player wallets
                  </>
                ) : (
                  <>
                    takes back{" "}
                    <span className="tabular-nums text-red-300">
                      {formatTetri(Math.abs(preview.netTetri))}
                    </span>
                  </>
                )}
                .
              </p>
              {preview.overCap && (
                <p className="text-red-300">
                  Over the {preview.maxAccounts}-account cap. The sweep will REFUSE — it will not
                  reset the first {preview.maxAccounts} and stop. Narrow the filters, or run this as
                  a maintenance-window migration.
                </p>
              )}
              {!preview.overCap && preview.affectedCount === 0 && (
                <p className="text-muted">Every selected account is already on the grant.</p>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
