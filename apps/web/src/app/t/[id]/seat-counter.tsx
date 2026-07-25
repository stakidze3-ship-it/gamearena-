"use client";

import { useTournamentLive } from "@/lib/use-tournament-live";

/**
 * Live seat counter for the public invite page. Someone who opens the link from
 * WhatsApp sees the field filling in real time — that urgency is the point.
 */
export function SeatCounter({
  tournamentId,
  entryCount,
  capacity,
  status,
}: {
  tournamentId: string;
  entryCount: number;
  capacity: number;
  status: string;
}) {
  const live = useTournamentLive(tournamentId, {
    enabled: status === "SCHEDULED",
    intervalMs: 4_000,
  });
  const count = live?.entryCount ?? entryCount;
  const left = Math.max(0, capacity - count);
  const pct = Math.min(100, Math.round((count / Math.max(1, capacity)) * 100));

  return (
    <div>
      <p className="tnum font-display text-4xl font-bold tracking-tight md:text-5xl">
        {count}
        <span className="text-muted">/{capacity}</span>
      </p>
      <div
        className="mx-auto mt-4 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-raised"
        role="progressbar"
        aria-valuenow={count}
        aria-valuemin={0}
        aria-valuemax={capacity}
      >
        <div
          className="h-full rounded-full bg-gold transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-3 text-sm text-muted">
        {status !== "SCHEDULED"
          ? "This tournament is under way."
          : left === 0
            ? "Field complete — the bracket is being drawn."
            : `${left} ${left === 1 ? "seat" : "seats"} left. It starts the moment the last one goes.`}
      </p>
    </div>
  );
}
