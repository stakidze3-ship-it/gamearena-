"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatTetri, lariToTetri } from "@gamearena/shared";
import { ConfirmDialog, Note, Panel, useAdminAction, type ConfirmSpec } from "../admin-primitives";

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

/**
 * User administration.
 *
 * Search first, then act on one account at a time. Deliberately not a bulk
 * grid: every control here moves money or removes someone's access, and a
 * layout that makes it easy to act on the wrong row is a liability rather than
 * a convenience.
 */
export function UsersSection() {
  const { busy, note, run } = useAdminAction();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundUser[] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [amountLari, setAmountLari] = useState("5");
  const [reason, setReason] = useState("");

  async function search() {
    const res = await run("search", `/api/admin/users/search?q=${encodeURIComponent(query)}`, undefined, "GET");
    if (res.ok) setResults((res.data?.users as FoundUser[]) ?? []);
  }

  async function open(id: string) {
    const res = await run(`profile-${id}`, `/api/admin/users/${id}`, undefined, "GET");
    if (res.ok) setProfile((res.data?.user as Profile) ?? null);
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
          <div className="mt-3 space-y-1.5">
            {results.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => open(u.id)}
                className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-left text-sm hover:border-gold/40"
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
            ))}
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
    </div>
  );
}
