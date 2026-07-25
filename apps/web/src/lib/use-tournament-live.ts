"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export interface TournamentLiveState {
  status: string;
  entryCount: number;
  capacity: number;
  full: boolean;
  awaitingPlayers: boolean;
  startsAt: string;
  hasLiveMatch: boolean;
  stateKey: string;
}

/**
 * Keep a tournament screen live. Polls the compact state endpoint and re-renders
 * the server component only when something actually changed, so a lobby of 60
 * people watching seats fill costs one small query each, not a full page render.
 *
 * Returns the latest state so counters and countdowns can update between
 * refreshes.
 */
export function useTournamentLive(
  tournamentId: string,
  { enabled = true, intervalMs = 2_500 }: { enabled?: boolean; intervalMs?: number } = {}
): TournamentLiveState | null {
  const router = useRouter();
  const [state, setState] = useState<TournamentLiveState | null>(null);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    async function poll() {
      try {
        const res = await fetch(`/api/tournaments/${tournamentId}/state`, { cache: "no-store" });
        if (!res.ok || !alive) return;
        const next: TournamentLiveState = await res.json();
        if (!alive) return;
        setState(next);
        if (lastKey.current !== null && lastKey.current !== next.stateKey) router.refresh();
        lastKey.current = next.stateKey;
      } catch {
        // Offline or mid-deploy — the next tick picks it back up.
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tournamentId, enabled, intervalMs, router]);

  return state;
}
