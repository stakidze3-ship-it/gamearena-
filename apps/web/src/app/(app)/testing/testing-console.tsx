"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconChevronRight, IconShield } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * The whole testing flow in one screen: become admin, create an event, fill it
 * with bots, start it, watch it. Every step is a button — no shell, no curl,
 * no URL to know.
 */

export interface TestTournamentRow {
  id: string;
  name: string;
  status: string;
  capacity: number;
  entryCount: number;
  isTest: boolean;
}

type Note = { text: string; ok: boolean } | null;

export function TestingConsole({
  isAdmin,
  eligible,
  reason,
  tournaments,
}: {
  isAdmin: boolean;
  eligible: boolean;
  reason: string;
  tournaments: TestTournamentRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [capacity, setCapacity] = useState(8);
  const [roundS, setRoundS] = useState(60);

  async function call(key: string, url: string, body?: unknown): Promise<Record<string, unknown> | null> {
    setBusy(key);
    setNote(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNote({ text: (data.error as string) ?? "That didn't work", ok: false });
        return null;
      }
      return data;
    } catch {
      setNote({ text: "Network error — try again", ok: false });
      return null;
    } finally {
      setBusy(null);
    }
  }

  // ── Step 0: not an admin yet ──
  if (!isAdmin) {
    return (
      <div className="rounded-2xl border border-border bg-surface px-5 py-6">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-lg bg-gold/10 p-2">
            <IconShield className="h-5 w-5 text-gold" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">Admin tools</p>
            {eligible ? (
              <>
                <p className="mt-1 text-sm text-muted">
                  {reason === "no-admin-yet"
                    ? "This deployment has no admin yet. Enable the tools on this account to run tournament tests."
                    : "This is the owner account. Enable the admin tools to run tournament tests."}
                </p>
                <Button
                  variant="primary"
                  className="mt-4"
                  disabled={busy === "claim"}
                  onClick={async () => {
                    const ok = await call("claim", "/api/admin/claim");
                    if (ok) {
                      setNote({ text: "Admin tools enabled.", ok: true });
                      router.refresh();
                    }
                  }}
                >
                  {busy === "claim" ? "Enabling…" : "Enable admin tools"}
                </Button>
              </>
            ) : (
              <p className="mt-1 text-sm text-muted">
                An admin already exists on this deployment. Ask them to promote your account from
                Admin → Users.
              </p>
            )}
            {note && (
              <p className={cn("mt-3 text-sm", note.ok ? "text-gain" : "text-loss")}>{note.text}</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Step 1+: the console ──
  return (
    <div className="space-y-4">
      {note && (
        <p
          className={cn(
            "rounded-lg border px-3 py-2 text-sm",
            note.ok ? "border-gain/30 bg-gain/6 text-gain" : "border-loss/30 bg-loss/6 text-loss"
          )}
        >
          {note.text}
        </p>
      )}

      {/* ── Live event ── */}
      <section className="rounded-2xl border border-gold/40 bg-surface px-5 py-4">
        <p className="font-medium">Live tournament</p>
        <p className="mt-0.5 text-sm text-muted">
          A real event, visible on the Tournaments page and open for entry immediately. Not a
          test — players are charged and winners are paid.
        </p>
        <div className="mt-3 rounded-lg border border-border bg-bg px-3 py-2.5 text-xs text-muted">
          <p className="font-medium text-fg-secondary">Block Blast Championship</p>
          <p className="tnum mt-1">
            32 seats · ₾5 entry · ₾160 pool · single elimination + third-place playoff
          </p>
          <p className="tnum mt-0.5">🥇 ₾80 · 🥈 ₾50 · 🥉 ₾30</p>
        </div>
        <Button
          variant="primary"
          className="mt-3"
          disabled={busy === "championship"}
          onClick={async () => {
            const data = await call("championship", "/api/admin/tournaments/create", {
              name: "Block Blast Championship",
              gameKey: "block-blast",
              capacity: 32,
              entryLari: 5,
              prizesLari: [80, 50, 30],
            });
            if (data) {
              setNote({
                text: `Created "${data.name as string}" — live on the Tournaments page now.`,
                ok: true,
              });
              router.refresh();
            }
          }}
        >
          {busy === "championship" ? "Creating…" : "Create Block Blast Championship"}
        </Button>
      </section>

      {/* ── Create ── */}
      <section className="rounded-2xl border border-border bg-surface px-5 py-4">
        <p className="font-medium">1 · Create a TEST tournament</p>
        <p className="mt-0.5 text-sm text-muted">
          Disposable and flagged as a test — hidden from players, so your real event is never touched.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted">
            Seats
            <select
              value={capacity}
              onChange={(e) => setCapacity(Number(e.target.value))}
              className="mt-1 block rounded-lg border border-border bg-bg px-2.5 py-2 text-sm text-fg"
            >
              {[4, 8, 16, 32, 64].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            Round window
            <select
              value={roundS}
              onChange={(e) => setRoundS(Number(e.target.value))}
              className="mt-1 block rounded-lg border border-border bg-bg px-2.5 py-2 text-sm text-fg"
            >
              {[30, 60, 120, 180].map((n) => (
                <option key={n} value={n}>{n}s</option>
              ))}
            </select>
          </label>
          <Button
            variant="primary"
            disabled={busy === "create"}
            onClick={async () => {
              const data = await call("create", "/api/admin/tournaments/create-test", {
                capacity,
                roundDurationS: roundS,
              });
              if (data) {
                setNote({ text: `Created "${data.name as string}".`, ok: true });
                router.refresh();
              }
            }}
          >
            {busy === "create" ? "Creating…" : "Create test tournament"}
          </Button>
        </div>
      </section>

      {/* ── Fill / start / watch ── */}
      <section>
        <p className="mb-2 font-medium">2 · Fill, start and watch</p>
        {tournaments.length === 0 ? (
          <p className="rounded-2xl border border-border bg-surface px-5 py-8 text-center text-sm text-muted">
            No knockout tournaments yet — create one above.
          </p>
        ) : (
          <div className="space-y-2">
            {tournaments.map((t) => {
              const seatsLeft = Math.max(0, t.capacity - t.entryCount);
              const canFill = t.status === "SCHEDULED" && seatsLeft > 0;
              const canStart = t.status === "SCHEDULED" && t.entryCount >= 2;
              const live = t.status === "RUNNING";
              return (
                <div key={t.id} className="rounded-xl border border-border bg-surface px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate font-medium">{t.name}</p>
                        {t.isTest && <Badge tone="amber">Test · hidden from players</Badge>}
                        <Badge tone={live ? "gold" : t.status === "FINISHED" ? "muted" : "neutral"}>
                          {t.status}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted">
                        <span className="tnum">{t.entryCount}</span>/
                        <span className="tnum">{t.capacity}</span> seats
                        {seatsLeft > 0 && ` · ${seatsLeft} empty`}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {canFill && (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy === `fill-${t.id}`}
                          onClick={async () => {
                            const data = await call(`fill-${t.id}`, `/api/admin/tournaments/${t.id}/fill-bots`);
                            if (data) {
                              setNote({
                                text: `Seated ${data.seated as number} bots — ${data.entryCount as number}/${data.capacity as number}.`,
                                ok: true,
                              });
                              router.refresh();
                            }
                          }}
                        >
                          {busy === `fill-${t.id}` ? "Seating…" : `Fill ${seatsLeft} with bots`}
                        </Button>
                      )}
                      {canStart && (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={busy === `start-${t.id}`}
                          onClick={async () => {
                            const data = await call(`start-${t.id}`, `/api/admin/tournaments/${t.id}/start`);
                            if (data) {
                              setNote({ text: "Bracket drawn — open it to watch.", ok: true });
                              router.refresh();
                            }
                          }}
                        >
                          {busy === `start-${t.id}` ? "Starting…" : "Start now"}
                        </Button>
                      )}
                      <Link
                        href={`/tournaments/${t.id}`}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors duration-150",
                          live
                            ? "bg-gold text-bg hover:opacity-90"
                            : "text-muted hover:text-fg"
                        )}
                      >
                        {live ? "Watch live" : "Open"}
                        <IconChevronRight className="h-4 w-4" />
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Reset your own balance ── */}
      <section className="rounded-2xl border border-border bg-surface px-5 py-4">
        <p className="font-medium">3 · Feel it like a new player</p>
        <p className="mt-0.5 text-sm text-muted">
          Accounts from before the ₾5 launch kept their old balance. This sets{" "}
          <span className="text-fg-secondary">your own</span> demo cash to exactly ₾5 — the same
          one-stake bankroll every new player starts with. Vault credits are untouched.
        </p>
        <Button
          variant="secondary"
          className="mt-3"
          disabled={busy === "reset"}
          onClick={async () => {
            const data = await call("reset", "/api/admin/wallet-reset", { amountLari: 5 });
            if (data) {
              setNote({ text: "Balance set to ₾5.00 — the top bar updates on refresh.", ok: true });
              router.refresh();
            }
          }}
        >
          {busy === "reset" ? "Resetting…" : "Reset my balance to ₾5"}
        </Button>
      </section>

      <p className="text-xs text-faint">
        Bots join through the normal registration path and play out over the round window, so the
        bracket, spectator view and prize settlement behave exactly as they do for real players.
        Every bot&apos;s balance is returned to the treasury when the event settles.
      </p>
    </div>
  );
}
