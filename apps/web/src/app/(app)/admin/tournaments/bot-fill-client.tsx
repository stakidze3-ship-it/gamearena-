"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconChevronRight } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Fill a knockout with bots so a whole tournament can be run on demand.
 *
 * Lives under /admin, which its layout gates, and posts to an admin-only route
 * that re-checks the role server-side — hiding the button is not the permission
 * model, it is only the ergonomics.
 */

export interface AdminTournamentRow {
  id: string;
  name: string;
  status: string;
  capacity: number;
  entryCount: number;
  isTest: boolean;
  format: string;
}

export function BotFillClient({ tournaments }: { tournaments: AdminTournamentRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const [capacity, setCapacity] = useState(8);
  const [roundS, setRoundS] = useState(60);
  const [creating, setCreating] = useState(false);

  async function createTest() {
    setCreating(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/tournaments/create-test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ capacity, roundDurationS: roundS }),
      });
      const data = await res.json().catch(() => ({}));
      setMessage({
        id: "create",
        text: res.ok ? `Created "${data.name}" — fill it below.` : data.error ?? "Could not create",
        ok: res.ok,
      });
      if (res.ok) router.refresh();
    } finally {
      setCreating(false);
    }
  }

  async function fill(id: string) {
    setBusy(id);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/tournaments/${id}/fill-bots`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ id, text: data.error ?? "Bot fill failed", ok: false });
        return;
      }
      setMessage({
        id,
        text: data.alreadyFull
          ? "Already full — nothing to seat."
          : `Seated ${data.seated} bots · ${data.entryCount}/${data.capacity}. The draw runs when the countdown expires.`,
        ok: true,
      });
      router.refresh();
    } catch {
      setMessage({ id, text: "Bot fill failed", ok: false });
    } finally {
      setBusy(null);
    }
  }

  const creator = (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      <p className="text-sm font-medium">New test tournament</p>
      <p className="mt-0.5 text-xs text-muted">
        Disposable, born flagged as a test. Use this rather than bot-filling the real event.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-muted">
          Seats
          <select
            value={capacity}
            onChange={(e) => setCapacity(Number(e.target.value))}
            className="mt-1 block rounded-lg border border-border bg-bg px-2 py-1.5 text-sm text-fg"
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
            className="mt-1 block rounded-lg border border-border bg-bg px-2 py-1.5 text-sm text-fg"
          >
            {[30, 60, 120, 180].map((n) => (
              <option key={n} value={n}>{n}s</option>
            ))}
          </select>
        </label>
        <Button variant="primary" size="sm" disabled={creating} onClick={createTest}>
          {creating ? "Creating…" : "Create test tournament"}
        </Button>
      </div>
      {message?.id === "create" && (
        <p className={`mt-2 text-sm ${message.ok ? "text-gain" : "text-loss"}`}>{message.text}</p>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      {creator}
      {tournaments.map((t) => {
        const seatsLeft = Math.max(0, t.capacity - t.entryCount);
        const fillable = t.status === "SCHEDULED" && seatsLeft > 0;
        return (
          <div key={t.id} className="rounded-xl border border-border bg-surface px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium">{t.name}</p>
                  {t.isTest && <Badge tone="amber">Test</Badge>}
                  <Badge tone={t.status === "RUNNING" ? "gold" : t.status === "FINISHED" ? "muted" : "neutral"}>
                    {t.status}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  <span className="tnum">{t.entryCount}</span>/<span className="tnum">{t.capacity}</span> seats
                  {seatsLeft > 0 && ` · ${seatsLeft} empty`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/tournaments/${t.id}`}
                  className="text-sm text-muted transition-colors duration-150 hover:text-fg"
                >
                  Open
                  <IconChevronRight className="ml-0.5 inline h-3.5 w-3.5" />
                </Link>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!fillable || busy === t.id}
                  onClick={() => fill(t.id)}
                >
                  {busy === t.id ? "Seating…" : `Fill ${seatsLeft} with bots`}
                </Button>
              </div>
            </div>
            {message?.id === t.id && (
              <p className={`mt-2 text-sm ${message.ok ? "text-gain" : "text-loss"}`}>{message.text}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
