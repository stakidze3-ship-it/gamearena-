"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Note, Panel, Stat, useAdminAction } from "../admin-primitives";

interface Snapshot {
  activeTournaments: { id: string; name: string; status: string; entryCount: number; capacity: number }[];
  onlinePlayers: number;
  database: { ok: boolean; latencyMs: number };
  realtime: { configured: boolean; url: string | null; ok: boolean; detail?: string };
  counts: Record<string, number>;
}

interface ErrorEntry {
  at: string;
  message: string;
  route?: string;
  source?: string;
  scope?: string;
}

interface JobsPayload {
  jobs: { name: string; state: string; detail: string; lastRunAt?: string | null }[];
  note?: string;
}

/** Deep tools that keep their own screens — linked rather than crammed into a tab. */
const SPECIALIST_TOOLS = [
  { href: "/admin/metrics", label: "Metrics", hint: "KPIs, retention, rake" },
  { href: "/admin/review", label: "Review queue", hint: "Anti-cheat cases" },
  { href: "/admin/calibration", label: "Blitz calibration", hint: "Payout curve + margin" },
  { href: "/admin/liveops", label: "Liveops", hint: "Announcements, happy hour" },
  { href: "/admin/flags", label: "Feature flags", hint: "Runtime toggles" },
];

/**
 * System health and background state.
 *
 * Everything here is read from something real. Where a value cannot actually be
 * known — the error buffer only covers the serverless instance that answered,
 * and there is no durable job queue — the panel says so rather than rendering a
 * confident zero, because an operator reading "0 errors" as "no errors" during
 * an incident is worse than showing nothing.
 */
export function SystemSection() {
  const { busy, note, run } = useAdminAction();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [errors, setErrors] = useState<ErrorEntry[] | null>(null);
  const [jobs, setJobs] = useState<JobsPayload | null>(null);

  const load = useCallback(async () => {
    const [s, e, j] = await Promise.all([
      run("snap", "/api/admin/system/snapshot", undefined, "GET"),
      run("errors", "/api/admin/system/errors", undefined, "GET"),
      run("jobs", "/api/admin/system/jobs", undefined, "GET"),
    ]);
    if (s.ok) setSnap((s.data as unknown as Snapshot) ?? null);
    if (e.ok) setErrors((e.data?.errors as ErrorEntry[]) ?? []);
    if (j.ok) setJobs((j.data as unknown as JobsPayload) ?? null);
  }, [run]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="space-y-4">
      <Panel
        title="Health"
        hint="Refreshes every 15s."
        right={
          <Button size="sm" variant="ghost" loading={busy === "snap"} onClick={load}>
            Refresh
          </Button>
        }
      >
        <Note note={note} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Online players" value={snap?.onlinePlayers ?? "—"} />
          <Stat
            label="Active tournaments"
            value={snap?.activeTournaments.length ?? "—"}
          />
          <Stat
            label="Database"
            value={snap ? (snap.database.ok ? `${snap.database.latencyMs}ms` : "down") : "—"}
            tone={snap ? (snap.database.ok ? "good" : "bad") : "default"}
          />
          <Stat
            label="Realtime"
            value={
              !snap
                ? "—"
                : !snap.realtime.configured
                  ? "not configured"
                  : snap.realtime.ok
                    ? "up"
                    : "unreachable"
            }
            tone={
              !snap ? "default" : !snap.realtime.configured ? "warn" : snap.realtime.ok ? "good" : "bad"
            }
          />
        </div>
        {snap && !snap.realtime.configured && (
          <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            NEXT_PUBLIC_REALTIME_URL is not set on this deployment, so 1v1 duels cannot connect.
            Tournaments are unaffected — they run over HTTP.
          </p>
        )}
      </Panel>

      <Panel title="Active tournaments" hint="Everything currently scheduled or running.">
        {!snap || snap.activeTournaments.length === 0 ? (
          <p className="text-sm text-muted">Nothing scheduled or running.</p>
        ) : (
          <div className="space-y-1.5">
            {snap.activeTournaments.map((t) => (
              <Link
                key={t.id}
                href={`/tournaments/${t.id}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg px-3 py-2 text-sm hover:border-gold/40"
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  <Badge tone={t.status === "RUNNING" ? "gold" : "neutral"}>{t.status}</Badge>
                </span>
                <span className="tabular-nums text-muted">
                  {t.entryCount}/{t.capacity}
                </span>
              </Link>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Background jobs">
        {!jobs ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <>
            <div className="space-y-1.5">
              {jobs.jobs.map((j) => (
                <div
                  key={j.name}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-sm"
                >
                  <span>
                    <span className="font-medium">{j.name}</span>
                    <span className="ml-2 text-xs text-muted">{j.detail}</span>
                  </span>
                  <Badge tone={j.state === "healthy" ? "gold" : "neutral"}>{j.state}</Badge>
                </div>
              ))}
            </div>
            {jobs.note && <p className="mt-2 text-xs text-faint">{jobs.note}</p>}
          </>
        )}
      </Panel>

      <Panel
        title="Recent errors"
        hint="Client crash reports and server exceptions captured by the telemetry sink."
      >
        {errors === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : errors.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing in this instance&apos;s buffer. Note that this is per-instance and in-memory —
            an empty list is not proof that nothing failed. The full record is in the deployment
            logs under <span className="font-mono text-faint">[CLIENT CRASH]</span> and{" "}
            <span className="font-mono text-faint">[SERVER ERROR]</span>.
          </p>
        ) : (
          <div className="space-y-1.5">
            {errors.map((e, i) => (
              <div
                key={`${e.at}-${i}`}
                className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-2 text-faint">
                  <span className="font-mono">{new Date(e.at).toLocaleTimeString()}</span>
                  {e.route && <span className="font-mono">{e.route}</span>}
                  {e.source && <Badge tone="neutral">{e.source}</Badge>}
                </div>
                <p className="mt-1 text-red-200">{e.message}</p>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Specialist tools" hint="Deeper screens that keep their own workspace.">
        <div className="grid gap-2 sm:grid-cols-2">
          {SPECIALIST_TOOLS.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="rounded-lg border border-border bg-bg px-3 py-2.5 hover:border-gold/40"
            >
              <div className="text-sm font-medium">{t.label}</div>
              <div className="text-xs text-muted">{t.hint}</div>
            </Link>
          ))}
        </div>
      </Panel>
    </div>
  );
}
