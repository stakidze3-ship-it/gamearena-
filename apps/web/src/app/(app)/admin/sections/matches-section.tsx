"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Note, Panel, useAdminAction, type ConfirmSpec } from "../admin-primitives";

interface ActiveMatch {
  id: string;
  kind: "bracket" | "duel";
  tournamentId: string | null;
  tournamentName: string | null;
  roundLabel: string;
  a: { userId: string | null; username: string | null; score: number | null; played: boolean };
  b: { userId: string | null; username: string | null; score: number | null; played: boolean };
  closesAt: string | null;
  replayHref: string | null;
}

/**
 * Live match operations.
 *
 * The list refreshes on a timer because a match window closes on its own — a
 * stale screen here means an operator forcing a result onto a match that has
 * already resolved. Ten seconds is frequent enough to stay honest without
 * hammering the database from an idle tab.
 */
export function MatchesSection() {
  const { busy, note, run } = useAdminAction();
  const [matches, setMatches] = useState<ActiveMatch[] | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);

  const load = useCallback(async () => {
    const res = await run("load", "/api/admin/matches/active", undefined, "GET");
    if (res.ok) setMatches((res.data?.matches as ActiveMatch[]) ?? []);
  }, [run]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="space-y-4">
      <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} />

      <Panel
        title="Active matches"
        hint="Every open bracket match across running tournaments. Refreshes every 10s."
        right={
          <Button size="sm" variant="ghost" loading={busy === "load"} onClick={load}>
            Refresh
          </Button>
        }
      >
        <Note note={note} />
        {matches === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : matches.length === 0 ? (
          <p className="rounded-xl border border-border bg-bg px-4 py-6 text-center text-sm text-muted">
            No matches are open right now. Start a tournament to see live matches here.
          </p>
        ) : (
          <div className="space-y-2">
            {matches.map((m) => (
              <div key={m.id} className="rounded-xl border border-border bg-bg px-3.5 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {m.tournamentId ? (
                        <Link
                          href={`/tournaments/${m.tournamentId}`}
                          className="truncate text-sm font-medium hover:text-gold"
                        >
                          {m.tournamentName}
                        </Link>
                      ) : (
                        <span className="text-sm font-medium">1v1 duel</span>
                      )}
                      <Badge tone="gold">{m.roundLabel}</Badge>
                    </div>
                    <p className="mt-1 text-sm tabular-nums">
                      <span className={m.a.played ? "text-fg" : "text-faint"}>
                        {m.a.username ?? "—"} {m.a.score ?? 0}
                      </span>
                      <span className="mx-2 text-faint">vs</span>
                      <span className={m.b.played ? "text-fg" : "text-faint"}>
                        {m.b.username ?? "—"} {m.b.score ?? 0}
                      </span>
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {m.replayHref && (
                      <Link href={m.replayHref}>
                        <Button size="sm" variant="ghost">
                          Replay
                        </Button>
                      </Link>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === `finish-${m.id}`}
                      onClick={() =>
                        setConfirm({
                          title: "Force finish this match?",
                          danger: true,
                          confirmLabel: "Force finish",
                          body: (
                            <>
                              Resolves the match on current scores and advances the winner
                              immediately.
                            </>
                          ),
                          consequences: [
                            "A player who has not played yet loses their chance to.",
                            "Advancement is immediate and cannot be undone except by resetting the bracket.",
                          ],
                          onConfirm: async () => {
                            const res = await run(
                              `finish-${m.id}`,
                              `/api/admin/matches/${m.id}/force-finish`
                            );
                            if (res.ok) load();
                          },
                        })
                      }
                    >
                      Force finish
                    </Button>
                    {[m.a, m.b].map(
                      (side) =>
                        side.userId && (
                          <Button
                            key={side.userId}
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setConfirm({
                                title: `Declare ${side.username} the winner?`,
                                danger: true,
                                confirmLabel: `Declare ${side.username}`,
                                body: (
                                  <>
                                    Overrides the scores and advances{" "}
                                    <span className="text-fg">{side.username}</span> regardless of
                                    who is ahead.
                                  </>
                                ),
                                consequences: [
                                  "This overrides a server-verified result — use it only to correct a fault.",
                                  "The bracket and any prize settlement follow this decision.",
                                ],
                                onConfirm: async () => {
                                  const res = await run(
                                    `declare-${m.id}`,
                                    `/api/admin/matches/${m.id}/declare-winner`,
                                    { winnerUserId: side.userId }
                                  );
                                  if (res.ok) load();
                                },
                              })
                            }
                          >
                            Win: {side.username}
                          </Button>
                        )
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
