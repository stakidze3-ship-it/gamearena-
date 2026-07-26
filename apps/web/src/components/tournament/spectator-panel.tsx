"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconChevronRight, IconMedal, IconUsers } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

/**
 * Live spectating for a tournament.
 *
 * One poll serves every live match, so switching between matches is instant and
 * costs nothing extra — the viewer already has the data. The match they have
 * open is reported back as a heartbeat, but far less often than the poll, since
 * the heartbeat writes and the poll does not.
 *
 * Poll-driven because production has no WebSocket host. `liveKey` changes only
 * when something visible moved, so a quiet tournament costs one cheap request
 * every couple of seconds and no re-render.
 */

const POLL_MS = 2_500;
/** Comfortably inside SPECTATOR_TTL_MS so a viewer never flickers out. */
const HEARTBEAT_MS = 10_000;

export interface LiveMatch {
  matchId: string;
  round: number;
  roundLabel: string;
  slot: number;
  isFinal: boolean;
  isThirdPlace: boolean;
  a: string | null;
  b: string | null;
  aScore: number | null;
  bScore: number | null;
  aPlayed: boolean;
  bPlayed: boolean;
  secondsLeft: number;
  spectators: number;
}

interface LiveView {
  status: string;
  matches: LiveMatch[];
  totalSpectators: number;
  liveKey: string;
}

function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function SpectatorPanel({
  tournamentId,
  /** Hidden until the viewer is out — a player mid-match should be playing. */
  enabled = true,
}: {
  tournamentId: string;
  enabled?: boolean;
}) {
  const [view, setView] = useState<LiveView | null>(null);
  const [watching, setWatching] = useState<string | null>(null);
  const watchingRef = useRef<string | null>(null);
  watchingRef.current = watching;
  const lastKey = useRef<string>("");
  const lastBeat = useRef(0);

  const poll = useCallback(async () => {
    const open = watchingRef.current;
    // Only tell the server what we are watching on the heartbeat cadence.
    const beat = Date.now() - lastBeat.current >= HEARTBEAT_MS;
    const qs = open && beat ? `?watching=${encodeURIComponent(open)}` : "";
    if (open && beat) lastBeat.current = Date.now();
    try {
      const res = await fetch(`/api/tournaments/${tournamentId}/live${qs}`, { cache: "no-store" });
      if (!res.ok) return;
      const next: LiveView = await res.json();
      // The countdown moves every second even when nothing else does, so the
      // key alone would freeze the clock — always take the new payload, and use
      // the key only to decide whether the SELECTION needs revisiting.
      setView(next);
      if (next.liveKey !== lastKey.current) lastKey.current = next.liveKey;
    } catch {
      /* a dropped poll is not worth surfacing; the next one retries */
    }
  }, [tournamentId]);

  useEffect(() => {
    if (!enabled) return;
    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [enabled, poll]);

  // Follow the headline match until the viewer picks one, and recover if the
  // match being watched finishes.
  useEffect(() => {
    if (!view) return;
    const stillLive = watching && view.matches.some((m) => m.matchId === watching);
    if (!stillLive) setWatching(view.matches[0]?.matchId ?? null);
  }, [view, watching]);

  if (!enabled) return null;
  if (!view || view.matches.length === 0) {
    return (
      <section className="rounded-xl border border-border bg-surface px-4 py-6 text-center">
        <p className="text-sm text-muted">
          {view?.status === "FINISHED"
            ? "The tournament is over — every match is in the bracket below."
            : "No matches are live right now."}
        </p>
      </section>
    );
  }

  const active = view.matches.find((m) => m.matchId === watching) ?? view.matches[0]!;
  const grandFinal = view.matches.find((m) => m.isFinal);

  return (
    <section className="space-y-4">
      {/* ── Grand Final, when it is live ── */}
      {grandFinal && (
        <GrandFinal
          match={grandFinal}
          watching={active.matchId === grandFinal.matchId}
          onWatch={() => setWatching(grandFinal.matchId)}
        />
      )}

      {/* ── The match being watched ── */}
      <div className="overflow-hidden rounded-xl border border-gold/40 bg-surface">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2">
            <LiveDot />
            <span className="text-xs font-medium uppercase tracking-wider text-gold">
              {active.roundLabel}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="flex items-center gap-1">
              <IconUsers className="h-3.5 w-3.5" />
              <span className="tnum">{active.spectators}</span>
            </span>
            <span className="tnum font-semibold text-fg-secondary">{clock(active.secondsLeft)}</span>
          </div>
        </div>
        <Side name={active.a} score={active.aScore} played={active.aPlayed} />
        <div className="h-px bg-border" />
        <Side name={active.b} score={active.bScore} played={active.bPlayed} />
      </div>

      {/* ── Switcher ── */}
      {view.matches.length > 1 && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">
              {view.matches.length} live {view.matches.length === 1 ? "match" : "matches"}
            </p>
            <p className="flex items-center gap-1 text-xs text-muted">
              <IconUsers className="h-3.5 w-3.5" />
              <span className="tnum">{view.totalSpectators}</span> watching
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {view.matches.map((m) => (
              <button
                key={m.matchId}
                type="button"
                onClick={() => setWatching(m.matchId)}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors duration-150",
                  m.matchId === active.matchId
                    ? "border-gold/50 bg-gold/6"
                    : "border-border bg-bg hover:border-border-strong"
                )}
              >
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5">
                    {m.isThirdPlace && <IconMedal className="h-3.5 w-3.5 shrink-0 text-amber" />}
                    <span className="truncate text-[13px] text-fg-secondary">
                      {m.a ?? "TBD"} <span className="text-faint">vs</span> {m.b ?? "TBD"}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[11px] uppercase tracking-wide text-muted">
                    {m.roundLabel}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="tnum block text-sm font-semibold">
                    {m.aScore ?? 0}–{m.bScore ?? 0}
                  </span>
                  <span className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-muted">
                    <IconUsers className="h-3 w-3" />
                    <span className="tnum">{m.spectators}</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function LiveDot() {
  return (
    <span className="relative flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-gold opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-gold" />
    </span>
  );
}

function Side({ name, score, played }: { name: string | null; score: number | null; played: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <span className="truncate text-[15px] font-medium">{name ?? <span className="text-faint">TBD</span>}</span>
      <span className="flex items-center gap-2">
        {played && (
          <span className="text-[11px] uppercase tracking-wide text-muted">done</span>
        )}
        <span className="tnum text-2xl font-bold leading-none">{score ?? 0}</span>
      </span>
    </div>
  );
}

/** The final gets its own billing — it is the moment the whole event builds to. */
function GrandFinal({
  match,
  watching,
  onWatch,
}: {
  match: LiveMatch;
  watching: boolean;
  onWatch: () => void;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-gold/45 bg-gradient-to-b from-gold/8 to-transparent px-5 py-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <LiveDot />
          <span className="text-xs font-bold uppercase tracking-[0.18em] text-gold">Grand Final</span>
        </div>
        <span className="flex items-center gap-1 text-xs text-muted">
          <IconUsers className="h-3.5 w-3.5" />
          <span className="tnum">{match.spectators}</span>
        </span>
      </div>

      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-semibold">{match.a ?? "TBD"}</p>
          <p className="tnum mt-1 text-3xl font-bold leading-none">{match.aScore ?? 0}</p>
        </div>
        <div className="shrink-0 pb-1 text-center">
          <p className="tnum text-sm font-semibold text-gold">{clock(match.secondsLeft)}</p>
          <p className="text-[11px] uppercase tracking-wide text-faint">left</p>
        </div>
        <div className="min-w-0 flex-1 text-right">
          <p className="truncate text-lg font-semibold">{match.b ?? "TBD"}</p>
          <p className="tnum mt-1 text-3xl font-bold leading-none">{match.bScore ?? 0}</p>
        </div>
      </div>

      {!watching && (
        <button
          type="button"
          onClick={onWatch}
          className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-lg bg-gold px-4 py-2.5 text-sm font-semibold text-bg transition-opacity duration-150 hover:opacity-90"
        >
          Watch live
          <IconChevronRight className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

/** Champion celebration, shown once the event has settled. */
export function ChampionBanner({
  champion,
  prizeLabel,
  replayHref,
}: {
  champion: string;
  prizeLabel?: string | null;
  replayHref?: string | null;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-gold/50 bg-gradient-to-b from-gold/12 to-transparent px-5 py-7 text-center">
      <Badge tone="gold" className="mb-3">Champion</Badge>
      <p className="text-2xl font-bold leading-tight">{champion}</p>
      {prizeLabel && <p className="mt-1 text-sm text-gold">{prizeLabel}</p>}
      {replayHref && (
        <Link
          href={replayHref}
          className="mt-4 inline-flex items-center gap-1.5 text-sm text-muted transition-colors duration-150 hover:text-fg"
        >
          Watch the final
          <IconChevronRight className="h-4 w-4" />
        </Link>
      )}
    </div>
  );
}
