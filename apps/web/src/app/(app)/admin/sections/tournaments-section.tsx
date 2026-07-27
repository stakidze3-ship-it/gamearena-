"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatTetri } from "@gamearena/shared";
import {
  ConfirmDialog,
  Note,
  Panel,
  useAdminAction,
  type ConfirmSpec,
} from "../admin-primitives";

export interface AdminTournamentRow {
  id: string;
  name: string;
  status: string;
  format: string;
  capacity: number;
  entryCount: number;
  botCount: number;
  entryTetri: number;
  poolTetri: number;
  isTest: boolean;
  botFilledAt: string | null;
  botsSeated: number;
  players: { userId: string; username: string; isBot: boolean }[];
}

/**
 * Tournament operations.
 *
 * The ordering is the operator's actual workflow — create, then fill, then run,
 * then intervene — rather than an alphabetical list of endpoints. Destructive
 * actions are visually separated and gated behind confirmation, because on this
 * page a misclick moves real money.
 */
export function TournamentsSection({ rows }: { rows: AdminTournamentRow[] }) {
  const router = useRouter();
  const { busy, note, run } = useAdminAction();
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [capacity, setCapacity] = useState(8);
  const [roundS, setRoundS] = useState(60);

  const refresh = () => router.refresh();

  /**
   * Seat bots.
   *
   * Two genuinely different situations behind one button. A test event fills
   * silently. A live one is a real bracket with paying humans in it, so the API
   * refuses the first attempt with LIVE_OVERRIDE_REQUIRED and we put the
   * consequences in front of the operator before retrying with the override.
   */
  async function fillBots(t: AdminTournamentRow) {
    const seatsLeft = Math.max(0, t.capacity - t.entryCount);
    const res = await run(`fill-${t.id}`, `/api/admin/tournaments/${t.id}/fill-bots`, {});
    if (res.ok) {
      refresh();
      return;
    }
    if (res.code !== "LIVE_OVERRIDE_REQUIRED") return;

    setConfirm({
      title: "Seat bots in a LIVE tournament?",
      danger: true,
      body: (
        <>
          <span className="font-medium text-fg">{t.name}</span> is visible to players and open
          for entry. This seats <span className="font-medium text-fg">{seatsLeft}</span> bots
          into a real bracket.
        </>
      ),
      consequences: [
        `Bots pay the ${formatTetri(t.entryTetri)} entry from treasury, so part of the ${formatTetri(t.poolTetri)} pool becomes treasury credit rather than player money.`,
        "Bots compete against paying humans and can win prizes. Their winnings are swept back to treasury after settlement, but the human who lost to a bot still lost.",
        "The tournament stays VISIBLE and is NOT converted to a test event — but it is permanently stamped as bot-filled for audit.",
        "Filling the last seat starts the countdown and draws the bracket immediately.",
      ],
      typeToConfirm: t.name,
      confirmLabel: `Seat ${seatsLeft} bots`,
      onConfirm: async () => {
        const ok = await run(`fill-${t.id}`, `/api/admin/tournaments/${t.id}/fill-bots`, {
          acknowledgeLive: true,
        });
        if (ok.ok) refresh();
      },
    });
  }

  function danger(
    t: AdminTournamentRow,
    action: string,
    spec: Omit<ConfirmSpec, "onConfirm" | "confirmLabel"> & { confirmLabel: string },
    body?: unknown
  ) {
    setConfirm({
      ...spec,
      onConfirm: async () => {
        const res = await run(`${action}-${t.id}`, `/api/admin/tournaments/${t.id}/${action}`, body ?? {});
        if (res.ok) refresh();
      },
    });
  }

  return (
    <div className="space-y-4">
      <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} />

      {/* ── Create ── */}
      <Panel
        title="Create a tournament"
        hint="A live event is visible to players immediately. A test event is hidden and disposable."
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted">
            Seats
            <select
              value={capacity}
              onChange={(e) => setCapacity(Number(e.target.value))}
              className="mt-1 block rounded-lg border border-border bg-bg px-2.5 py-2 text-sm text-fg"
            >
              {[4, 8, 16, 32, 64].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
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
                <option key={n} value={n}>
                  {n}s
                </option>
              ))}
            </select>
          </label>

          <Button
            variant="primary"
            loading={busy === "create-live"}
            onClick={() =>
              setConfirm({
                title: "Create a LIVE tournament?",
                body: (
                  <>
                    This event will appear on the public Tournaments page immediately and players
                    can pay to enter it.
                  </>
                ),
                consequences: [
                  "Real players can spend real balance on entry as soon as it exists.",
                  "Cancelling later refunds every entrant, but the event will have been publicly visible.",
                ],
                confirmLabel: "Create live tournament",
                onConfirm: async () => {
                  const res = await run("create-live", "/api/admin/tournaments/create-live", {
                    capacity,
                    roundDurationS: roundS,
                  });
                  if (res.ok) refresh();
                },
              })
            }
          >
            Create live tournament
          </Button>

          <Button
            variant="secondary"
            loading={busy === "create-test"}
            onClick={async () => {
              const res = await run("create-test", "/api/admin/tournaments/create-test", {
                capacity,
                roundDurationS: roundS,
              });
              if (res.ok) refresh();
            }}
          >
            Create test tournament
          </Button>
        </div>
        <Note note={note} />
      </Panel>

      {/* ── Operate ── */}
      <div className="space-y-2">
        <h3 className="font-medium">Tournaments</h3>
        {rows.length === 0 ? (
          <p className="rounded-2xl border border-border bg-surface px-5 py-8 text-center text-sm text-muted">
            No tournaments yet.
          </p>
        ) : (
          rows.map((t) => {
            const seatsLeft = Math.max(0, t.capacity - t.entryCount);
            const scheduled = t.status === "SCHEDULED";
            const running = t.status === "RUNNING";
            return (
              <div key={t.id} className="rounded-xl border border-border bg-surface px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/tournaments/${t.id}`}
                        className="truncate font-medium hover:text-gold"
                      >
                        {t.name}
                      </Link>
                      <Badge tone={running ? "gold" : "neutral"}>{t.status}</Badge>
                      {t.isTest ? (
                        <Badge tone="neutral">TEST · hidden</Badge>
                      ) : (
                        <Badge tone="gold">LIVE · visible</Badge>
                      )}
                      {t.botsSeated > 0 && (
                        <Badge tone="neutral">{t.botsSeated} bots seated</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-muted">
                      {t.entryCount}/{t.capacity} seats · {t.botCount} bots · entry{" "}
                      {formatTetri(t.entryTetri)} · pool {formatTetri(t.poolTetri)}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {scheduled && seatsLeft > 0 && (
                      <Button
                        size="sm"
                        variant={t.isTest ? "secondary" : "primary"}
                        loading={busy === `fill-${t.id}`}
                        onClick={() => fillBots(t)}
                      >
                        Fill {seatsLeft} with bots
                      </Button>
                    )}
                    {scheduled && t.botCount > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === `remove-bots-${t.id}`}
                        onClick={async () => {
                          const res = await run(
                            `remove-bots-${t.id}`,
                            `/api/admin/tournaments/${t.id}/remove-bots`
                          );
                          if (res.ok) refresh();
                        }}
                      >
                        Remove bots
                      </Button>
                    )}
                    {scheduled && t.entryCount >= 2 && (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busy === `start-${t.id}`}
                        onClick={async () => {
                          const res = await run(
                            `start-${t.id}`,
                            `/api/admin/tournaments/${t.id}/start`
                          );
                          if (res.ok) refresh();
                        }}
                      >
                        Start now
                      </Button>
                    )}
                    {running && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            danger(t, "reset", {
                              title: "Reset the bracket?",
                              danger: true,
                              confirmLabel: "Reset bracket",
                              body: (
                                <>
                                  Deletes every match in <span className="text-fg">{t.name}</span>{" "}
                                  and returns it to SCHEDULED so the bracket can be redrawn.
                                </>
                              ),
                              consequences: [
                                "All played scores and stored replays for this tournament are destroyed.",
                                "Entries and escrow are preserved — nobody is refunded and nobody is removed.",
                              ],
                              typeToConfirm: t.name,
                            })
                          }
                        >
                          Reset
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            danger(t, "end", {
                              title: "End and settle now?",
                              danger: true,
                              confirmLabel: "End & pay out",
                              body: (
                                <>
                                  Finalises <span className="text-fg">{t.name}</span> on current
                                  standings and pays the prize pool immediately.
                                </>
                              ),
                              consequences: [
                                "Prizes are paid from escrow and cannot be reversed.",
                                "Players with unplayed matches are ranked where they currently stand.",
                              ],
                              typeToConfirm: t.name,
                            })
                          }
                        >
                          End & settle
                        </Button>
                      </>
                    )}
                    {(scheduled || running) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          danger(t, "cancel", {
                            title: "Cancel and refund everyone?",
                            danger: true,
                            confirmLabel: "Cancel & refund",
                            body: (
                              <>
                                Cancels <span className="text-fg">{t.name}</span> and returns every
                                entry fee.
                              </>
                            ),
                            consequences: [
                              `${t.entryCount} entrants are refunded ${formatTetri(t.entryTetri)} each from escrow.`,
                              "The event disappears from the Tournaments page.",
                            ],
                            typeToConfirm: t.name,
                          })
                        }
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>

                {/* Per-player intervention */}
                {t.players.length > 0 && (scheduled || running) && (
                  <details className="mt-3 border-t border-border pt-3">
                    <summary className="cursor-pointer text-xs text-muted hover:text-fg">
                      Players ({t.players.length}) — remove or force advance
                    </summary>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {t.players.map((p) => (
                        <span
                          key={p.userId}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg px-2 py-1 text-xs"
                        >
                          <span className={p.isBot ? "text-faint" : "text-fg"}>{p.username}</span>
                          {scheduled && (
                            <button
                              type="button"
                              title="Remove and refund"
                              className="text-faint hover:text-red-300"
                              onClick={async () => {
                                const res = await run(
                                  `remove-${p.userId}`,
                                  `/api/admin/tournaments/${t.id}/remove-player`,
                                  { userId: p.userId }
                                );
                                if (res.ok) refresh();
                              }}
                            >
                              remove
                            </button>
                          )}
                          {running && (
                            <button
                              type="button"
                              title="Force this player through their current match"
                              className="text-faint hover:text-gold"
                              onClick={async () => {
                                const res = await run(
                                  `adv-${p.userId}`,
                                  `/api/admin/tournaments/${t.id}/force-advance`,
                                  { userId: p.userId }
                                );
                                if (res.ok) refresh();
                              }}
                            >
                              advance
                            </button>
                          )}
                        </span>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
