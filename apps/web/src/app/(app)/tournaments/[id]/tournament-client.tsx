"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatTetri, formatTetriCompact } from "@gamearena/shared";
import { BlockBlastBoard, type BlockBlastResult } from "@/components/games/block-blast-board";
import { IconCheck, IconChevronDown, IconChevronLeft, IconMedal } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { useTournamentLive } from "@/lib/use-tournament-live";

interface Tournament {
  id: string;
  name: string;
  gameName: string;
  gameKey: string;
  durationS: number;
  entryTetri: number;
  guaranteeTetri: number;
  prizeStructure: { rank: number; shareBps: number }[];
  capacity: number;
  status: string;
  format: string;
  roundDurationS: number;
  readyWindowS: number;
  seed: string | null;
  startsAt: string;
  endsAt: string;
  poolTetri: number;
  entryCount: number;
  ended: boolean;
  /** True while the field is still filling (no draw time set yet). */
  awaitingPlayers: boolean;
  /** Public invite link, shared straight into WhatsApp. */
  shareUrl: string;
}

interface Entry {
  username: string;
  isBot: boolean;
  bestScore: number | null;
  rank: number | null;
  prizeTetri: number | null;
  isMe: boolean;
}

interface BracketMatchView {
  slot: number;
  a: string | null;
  b: string | null;
  aScore: number | null;
  bScore: number | null;
  winner: string | null;
  status: string;
}
interface Bracket {
  rounds: { round: number; label: string; matches: BracketMatchView[] }[];
  thirdPlace: BracketMatchView | null;
  myMatch: {
    round: number;
    label: string;
    seed: string | null;
    opponent: string | null;
    closesAt: string | null;
    isThirdPlace: boolean;
  } | null;
}

interface NameSide {
  username: string;
  isMe: boolean;
}
interface Registration {
  registrants: { seed: number; username: string; isBot: boolean; isMe: boolean }[];
  pairings: { a: NameSide | null; b: NameSide | null; bye: boolean }[];
}

export function TournamentClient({
  tournament: t,
  entries,
  myEntry,
  balanceTetri,
  isAdmin,
  bracket,
  registration,
}: {
  tournament: Tournament;
  entries: Entry[];
  myEntry: { registered: boolean; bestScore: number | null };
  balanceTetri: number;
  isAdmin: boolean;
  bracket: Bracket | null;
  registration: Registration | null;
}) {
  const router = useRouter();
  const isKnockout = t.format === "KNOCKOUT";
  const [phase, setPhase] = useState<"idle" | "playing" | "submitting">("idle");
  const [seed, setSeed] = useState<string | null>(t.seed);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<number | null>(null);
  const boardKey = useState(() => ({ n: 0 }))[0];

  // Live state: seats filling, the draw landing, a round opening, a result
  // arriving. Paused while playing so the board is never yanked mid-run.
  const live = useTournamentLive(t.id, {
    enabled: isKnockout && !t.ended && phase === "idle" && (t.status === "SCHEDULED" || t.status === "RUNNING"),
  });
  const entryCount = live?.entryCount ?? t.entryCount;
  const seatsLeft = Math.max(0, t.capacity - entryCount);
  const awaitingPlayers = live?.awaitingPlayers ?? t.awaitingPlayers;
  const drawAt = live?.startsAt ?? t.startsAt;

  // The seed to play: the knockout's open-match seed, else the shared seed.
  const activeSeed = isKnockout ? bracket?.myMatch?.seed ?? null : seed;

  async function register() {
    setError(null);
    const res = await fetch(`/api/tournaments/${t.id}/register`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(data.error ?? "Could not register");
    setSeed(data.seed);
    router.refresh();
  }

  function play() {
    boardKey.n++;
    setLastRun(null);
    setPhase("playing");
  }

  async function onEnd(result: BlockBlastResult) {
    setPhase("submitting");
    const res = await fetch(`/api/tournaments/${t.id}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: result.inputs }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.error ?? "Could not submit run");
      setPhase("idle");
      return;
    }
    setLastRun(data.score);
    setPhase("idle");
    router.refresh();
  }

  async function finalize() {
    await fetch(`/api/tournaments/${t.id}/finalize`, { method: "POST" });
    router.refresh();
  }

  /** Operator controls: draw a stalled lobby early, or refund and close it. */
  async function adminAction(action: "start" | "cancel" | "finalize") {
    setError(null);
    const res = await fetch("/api/admin/tournaments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tournamentId: t.id, action }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "That action did not go through");
      return;
    }
    router.refresh();
  }

  const prizeFor = (rank: number) => {
    const s = t.prizeStructure.find((p) => p.rank === rank);
    return s ? Math.floor((t.poolTetri * s.shareBps) / 10_000) : 0;
  };

  // ── Playing ──
  if (phase === "playing" && activeSeed) {
    return (
      <div className="mx-auto max-w-lg">
        <div className="mb-4 flex items-center justify-between">
          <Badge tone="gold">{t.name}</Badge>
          <span className="text-sm text-muted">
            {isKnockout && bracket?.myMatch
              ? `${bracket.myMatch.label} · seed #${activeSeed}`
              : `Shared seed · everyone plays #${activeSeed}`}
          </span>
        </div>
        <BlockBlastBoard key={boardKey.n} seed={activeSeed} durationS={t.durationS} onEnd={onEnd} />
      </div>
    );
  }
  if (phase === "submitting") {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-gold" />
        <p className="text-sm text-muted">Scoring your run…</p>
      </div>
    );
  }

  const canPlay =
    myEntry.registered &&
    !t.ended &&
    t.gameKey === "block-blast" &&
    (isKnockout ? !!activeSeed : !!seed);

  const myRoundLabel = isKnockout && bracket?.myMatch ? bracket.myMatch.label : null;

  return (
    <div className="mx-auto max-w-xl space-y-10">
      <Link
        href="/tournaments"
        className="inline-flex items-center gap-1 text-sm text-muted transition-colors duration-150 hover:text-fg"
      >
        <IconChevronLeft className="h-4 w-4" />
        All tournaments
      </Link>

      {/* Compact header: name + one meta line */}
      <div className="text-center">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">
          {t.gameName} · {isKnockout ? "Single-elimination knockout" : "Shared-seed leaderboard"}
        </p>
        <h1 className="mt-2 font-display text-xl font-bold tracking-tight md:text-2xl">{t.name}</h1>
        <p className="tnum mt-2 text-sm text-muted">
          Entry {formatTetriCompact(t.entryTetri)} · pool {formatTetri(t.poolTetri)} ·{" "}
          {t.durationS}s {isKnockout ? "per match" : "run"}
        </p>
      </div>

      {/* Where the event stands: seats filling, then the countdown to the draw */}
      {isKnockout && t.status === "SCHEDULED" && (
        <SeatMeter
          entryCount={entryCount}
          capacity={t.capacity}
          seatsLeft={seatsLeft}
          awaitingPlayers={awaitingPlayers}
          drawAt={drawAt}
          readyWindowS={t.readyWindowS}
        />
      )}

      {/* THE next action */}
      <section className="space-y-3">
        {error && <p className="text-center text-sm text-coral">{error}</p>}

        {!myEntry.registered && !t.ended && t.status !== "RUNNING" && (
          <>
            <Button
              variant="primary"
              size="lg"
              className="h-14 w-full"
              disabled={balanceTetri < t.entryTetri}
              onClick={register}
            >
              {balanceTetri < t.entryTetri
                ? "Not enough credits"
                : `Register · ${formatTetriCompact(t.entryTetri)}`}
            </Button>
            <p className="text-center text-xs text-faint">
              Balance <Money tetri={balanceTetri} />
            </p>
          </>
        )}
        {!myEntry.registered && !t.ended && isKnockout && t.status === "RUNNING" && (
          <p className="text-center text-sm text-muted">
            The bracket has already started — registration is closed.
          </p>
        )}

        {/* Registered and waiting: the useful action is bringing friends. */}
        {myEntry.registered && isKnockout && t.status === "SCHEDULED" && (
          <ShareInvite url={t.shareUrl} seatsLeft={seatsLeft} />
        )}

        {/* Knockout play prompt */}
        {isKnockout && myEntry.registered && !t.ended && (
          canPlay ? (
            <>
              <p className="text-center text-sm text-muted">
                {bracket?.myMatch?.round === 1 ? "Ready up! " : ""}Your {myRoundLabel} match
                {bracket?.myMatch?.opponent ? ` vs ${bracket.myMatch.opponent}` : ""} is live —
                play before the clock runs out or you forfeit.
              </p>
              <Button variant="primary" size="lg" className="h-14 w-full" onClick={play}>
                {bracket?.myMatch?.round === 1 ? "Ready up & play" : "Play your match"}
              </Button>
              {bracket?.myMatch?.closesAt && <Countdown closesAt={bracket.myMatch.closesAt} />}
            </>
          ) : (
            t.status === "RUNNING" && (
              <p className="text-center text-sm text-muted">
                Waiting for your next match — sit tight while this round finishes.
              </p>
            )
          )
        )}

        {/* Leaderboard play */}
        {!isKnockout && canPlay && (
          <Button variant="primary" size="lg" className="h-14 w-full" onClick={play}>
            {myEntry.bestScore != null ? "Play again (improve best)" : "Play your run"}
          </Button>
        )}
        {!isKnockout && myEntry.registered && myEntry.bestScore != null && (
          <p className="text-center text-sm text-muted">
            Your best: <span className="tnum font-semibold text-fg">{myEntry.bestScore}</span>
          </p>
        )}

        {t.ended && !isAdmin && (
          <p className="text-center text-sm text-muted">
            {t.status === "CANCELLED" ? "Cancelled — entries refunded." : "This tournament has ended."}
          </p>
        )}
      </section>

      {/* Registration preview → live bracket (knockout) or leaderboard */}
      {isKnockout ? (
        t.status === "SCHEDULED" ? (
          <RegistrationBoard registration={registration} />
        ) : (
          <BracketBoard bracket={bracket} status={t.status} ended={t.ended} lastRun={lastRun} />
        )
      ) : (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">
              {t.ended ? "Final standings" : "Live leaderboard"}
            </p>
            <Badge tone={t.status === "FINISHED" ? "muted" : "gold"}>
              {t.status === "FINISHED" ? "Finished" : t.ended ? "Ended" : "Running"}
            </Badge>
          </div>
          {lastRun != null && (
            <p className="mb-3 rounded-lg border border-gold/30 bg-gold/6 px-3 py-2 text-sm">
              Your run scored <span className="tnum font-semibold">{lastRun}</span> — best kept.
            </p>
          )}
          <Table>
            <THead>
              <tr className="border-b border-border">
                <Th>#</Th>
                <Th>Player</Th>
                <Th className="text-right">Best</Th>
                <Th className="text-right">Prize</Th>
              </tr>
            </THead>
            <TBody>
              {entries.length === 0 && (
                <tr>
                  <Td colSpan={4} className="py-6 text-center text-muted">
                    No entrants yet — be the first.
                  </Td>
                </tr>
              )}
              {entries.map((e, i) => {
                const rank = i + 1;
                const prize = t.ended ? e.prizeTetri ?? 0 : e.bestScore != null ? prizeFor(rank) : 0;
                return (
                  <Tr key={i} highlight={e.isMe}>
                    <Td className="tnum text-muted">{rank}</Td>
                    <Td className="text-fg">
                      <span className={e.isMe ? "font-semibold" : ""}>{e.username}</span>
                      {e.isBot && <Badge tone="muted" className="ml-1.5">Bot</Badge>}
                      {e.isMe && <span className="ml-1.5 text-xs text-gold">you</span>}
                    </Td>
                    <Td className="tnum text-right text-fg">{e.bestScore ?? "—"}</Td>
                    <Td className="text-right">
                      {prize > 0 ? (
                        <Money tetri={prize} className="text-gain" />
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
        </section>
      )}

      {/* Prize structure + rules, collapsed */}
      <div className="space-y-3">
        <details className="group rounded-lg border border-border bg-surface">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-muted transition-colors duration-150 hover:text-fg [&::-webkit-details-marker]:hidden">
            Prizes · top {t.prizeStructure.length} paid
            <IconChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180" />
          </summary>
          <div className="border-t border-border px-4 py-3 text-sm text-muted">
            {t.guaranteeTetri > 0 && (
              <p className="mb-2">
                Pool guaranteed at{" "}
                <span className="tnum text-gold">{formatTetri(t.guaranteeTetri)}</span>.
              </p>
            )}
            <div className="space-y-1.5">
              {t.prizeStructure.map((p) => (
                <div key={p.rank} className="flex items-center justify-between">
                  <RankLabel rank={p.rank} />
                  <Money tetri={prizeFor(p.rank)} className="tnum" />
                </div>
              ))}
            </div>
          </div>
        </details>

        {isKnockout && <RulesCard t={t} />}
      </div>

      {isAdmin && !t.ended && (
        <details className="group rounded-lg border border-border bg-surface">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-muted transition-colors duration-150 hover:text-fg [&::-webkit-details-marker]:hidden">
            Operator controls
            <IconChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180" />
          </summary>
          <div className="space-y-2 border-t border-border px-4 py-3">
            {isKnockout ? (
              <>
                {t.status === "SCHEDULED" && (
                  <>
                    <Button variant="secondary" className="w-full" onClick={() => adminAction("start")}>
                      Draw the bracket now ({t.entryCount} in)
                    </Button>
                    <p className="text-xs text-faint">
                      Starts the event early with whoever is seated. Needs at least 2 players.
                    </p>
                  </>
                )}
                <Button variant="danger" className="w-full" onClick={() => adminAction("cancel")}>
                  Cancel &amp; refund every entry
                </Button>
              </>
            ) : (
              t.status !== "FINISHED" && (
                <Button variant="secondary" className="w-full" onClick={finalize}>
                  Finalize now
                </Button>
              )
            )}
          </div>
        </details>
      )}
    </div>
  );
}

function RankLabel({ rank }: { rank: number }) {
  const top: Record<number, { label: string; tone: string }> = {
    1: { label: "Champion", tone: "text-gold" },
    2: { label: "Runner-up", tone: "text-fg-secondary" },
    3: { label: "3rd", tone: "text-amber" },
  };
  const entry = top[rank];
  if (!entry) return <span className="tnum text-muted">#{rank}</span>;
  return (
    <span className="flex items-center gap-1.5 text-muted">
      <IconMedal className={cn("h-4 w-4", entry.tone)} />
      {entry.label}
    </span>
  );
}

function Countdown({ closesAt }: { closesAt: string }) {
  const [left, setLeft] = useState(() => Math.max(0, new Date(closesAt).getTime() - Date.now()));
  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, new Date(closesAt).getTime() - Date.now())), 1000);
    return () => clearInterval(id);
  }, [closesAt]);
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  const low = left <= 60000;
  return (
    <p className="text-center text-xs text-muted">
      Play within <span className={cn("tnum", low ? "text-coral" : "text-fg-secondary")}>{m}:{String(s).padStart(2, "0")}</span> or you forfeit
    </p>
  );
}

/**
 * The state of the lobby: seats filling, then the countdown to the draw. This
 * is the one thing a registered player watches before their first match.
 */
function SeatMeter({
  entryCount,
  capacity,
  seatsLeft,
  awaitingPlayers,
  drawAt,
  readyWindowS,
}: {
  entryCount: number;
  capacity: number;
  seatsLeft: number;
  awaitingPlayers: boolean;
  drawAt: string;
  readyWindowS: number;
}) {
  const pct = Math.min(100, Math.round((entryCount / Math.max(1, capacity)) * 100));
  const readyMin = Math.round(readyWindowS / 60);

  if (!awaitingPlayers) {
    return <DrawCountdown drawAt={drawAt} readyMin={readyMin} />;
  }

  return (
    <section className="text-center">
      <p className="text-xs uppercase tracking-wider text-muted">Seats filled</p>
      <p className="tnum mt-2 font-display text-4xl font-bold tracking-tight">
        {entryCount}
        <span className="text-muted">/{capacity}</span>
      </p>
      <div
        className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-raised"
        role="progressbar"
        aria-valuenow={entryCount}
        aria-valuemin={0}
        aria-valuemax={capacity}
      >
        <div
          className="h-full rounded-full bg-gold transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-3 text-sm text-muted">
        {seatsLeft === 0
          ? "Field complete — drawing the bracket…"
          : `${seatsLeft} ${seatsLeft === 1 ? "seat" : "seats"} to go. The bracket draws the moment the last one goes.`}
      </p>
    </section>
  );
}

/** 60-second lobby countdown between the field filling and the draw. */
function DrawCountdown({ drawAt, readyMin }: { drawAt: string; readyMin: number }) {
  const target = new Date(drawAt).getTime();
  const [left, setLeft] = useState(() => target - Date.now());
  useEffect(() => {
    const id = setInterval(() => setLeft(target - Date.now()), 250);
    return () => clearInterval(id);
  }, [target]);

  const started = left <= 0;
  const total = Math.max(0, Math.floor(left / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;

  return (
    <section className="rounded-xl border border-gold/30 bg-gold/6 px-4 py-6 text-center">
      {started ? (
        <>
          <p className="text-sm font-medium text-gold">Drawing the bracket…</p>
          <p className="mt-1 text-xs text-muted">Your first opponent appears here in a moment.</p>
        </>
      ) : (
        <>
          <p className="text-xs uppercase tracking-wider text-muted">Field complete · draw in</p>
          <p className="tnum mt-2 font-display text-4xl font-bold tracking-tight text-gold">
            {m}:{String(s).padStart(2, "0")}
          </p>
          <p className="mt-3 text-sm text-muted">
            You then have <span className="font-semibold text-fg-secondary">{readyMin} minutes</span>{" "}
            to play each match or you forfeit it.
          </p>
        </>
      )}
    </section>
  );
}

/** Copy the public invite link — this is how the field actually fills. */
function ShareInvite({ url, seatsLeft }: { url: string; seatsLeft: number }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="text-center">
      <Button variant="secondary" size="lg" className="w-full" onClick={copy}>
        {copied ? (
          <>
            <IconCheck className="h-4 w-4 text-gold" />
            Invite link copied
          </>
        ) : (
          "Copy invite link"
        )}
      </Button>
      <p className="mt-2 text-xs text-faint">
        {seatsLeft > 0
          ? `Share it — the tournament starts as soon as ${seatsLeft} more ${seatsLeft === 1 ? "player joins" : "players join"}.`
          : "The field is full."}
      </p>
    </div>
  );
}

function RegistrationBoard({ registration }: { registration: Registration | null }) {
  const regs = registration?.registrants ?? [];
  const pairings = registration?.pairings ?? [];
  return (
    <section>
      <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">
        Registered players
      </p>

      {regs.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">
          No one has registered yet — be the first and your name shows up here.
        </p>
      ) : (
        <>
          {/* Everyone who's in, in the order they registered */}
          <div className="mb-6 flex flex-wrap gap-1.5">
            {regs.map((r) => (
              <span
                key={r.seed}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs",
                  r.isMe ? "border-gold/60 bg-gold/6 text-gold" : "border-border bg-bg text-fg-secondary"
                )}
              >
                <span className="tnum text-faint">{r.seed}</span>
                {r.username}
                {r.isBot && <span className="text-faint">bot</span>}
                {r.isMe && <span className="text-2xs">you</span>}
              </span>
            ))}
          </div>

          {/* Provisional first-round pairings (registration order) */}
          <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">
            Provisional first-round pairings
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {pairings.map((p, i) => (
              <div key={i} className="overflow-hidden rounded-lg border border-border bg-surface">
                <PairRow side={p.a} />
                <div className="flex items-center">
                  <div className="h-px flex-1 bg-border" />
                  <span className="px-2 text-2xs uppercase tracking-wide text-faint">
                    {p.bye ? "bye" : "vs"}
                  </span>
                  <div className="h-px flex-1 bg-border" />
                </div>
                <PairRow side={p.b} bye={p.bye} />
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-faint">
            Pairs follow registration order — the first two to register meet, then the next two, and
            so on. New sign-ups slot in live until the last seat goes.
          </p>
        </>
      )}
    </section>
  );
}

function PairRow({ side, bye }: { side: NameSide | null; bye?: boolean }) {
  return (
    <div
      className={cn(
        "px-3 py-1.5 text-sm",
        side?.isMe ? "font-semibold text-gold" : "text-fg-secondary"
      )}
    >
      {side ? (
        <>
          {side.username}
          {side.isMe && <span className="ml-1.5 text-2xs text-gold">you</span>}
        </>
      ) : (
        <span className="text-faint">{bye ? "auto-advances (bye)" : "awaiting player"}</span>
      )}
    </div>
  );
}

function RulesCard({ t }: { t: Tournament }) {
  const roundMin = Math.round(t.roundDurationS / 60);
  const readyMin = Math.round(t.readyWindowS / 60);
  const rules = [
    `Entry ${formatTetriCompact(t.entryTetri)}. Prize pool ${formatTetri(t.poolTetri)}${t.guaranteeTetri > 0 ? " guaranteed" : ""}.`,
    "Single-elimination: win your match and advance, lose once and you're out.",
    `Each match is a ${t.durationS}s Block Blast run on the identical seed — higher score wins.`,
    `When it starts you have ${readyMin} minutes to ready up and play your first match — miss it and your opponent advances automatically.`,
    `Later rounds run on a ${roundMin}-minute clock; play in time or you forfeit.`,
    "Every round's seed hash is published before play and revealed after — provably fair.",
    `Top ${t.prizeStructure.length} finishers are paid.`,
  ];
  return (
    <details className="group rounded-lg border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-muted transition-colors duration-150 hover:text-fg [&::-webkit-details-marker]:hidden">
        How it works
        <IconChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180" />
      </summary>
      <div className="border-t border-border px-4 py-3 text-sm text-muted">
        <ol className="space-y-2">
          {rules.map((r, i) => (
            <li key={i} className="flex gap-2">
              <span className="tnum text-gold">{i + 1}</span>
              <span>{r}</span>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}

function BracketBoard({
  bracket,
  status,
  ended,
  lastRun,
}: {
  bracket: Bracket | null;
  status: string;
  ended: boolean;
  lastRun: number | null;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">Bracket</p>
        <Badge tone={status === "FINISHED" ? "muted" : status === "RUNNING" ? "gold" : "neutral"}>
          {status === "FINISHED" ? "Complete" : status === "CANCELLED" ? "Cancelled" : status === "RUNNING" ? "Live" : "Registering"}
        </Badge>
      </div>
      {lastRun != null && (
        <p className="mb-3 rounded-lg border border-gold/30 bg-gold/6 px-3 py-2 text-sm">
          Your match run scored <span className="tnum font-semibold">{lastRun}</span> — waiting on your opponent.
        </p>
      )}
      {!bracket ? (
        <p className="py-8 text-center text-sm text-muted">
          {status === "SCHEDULED"
            ? "Registration is open. The bracket is drawn when the tournament starts."
            : ended
              ? "This bracket did not run."
              : "Seeding the bracket…"}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto pb-2">
            <div className="flex gap-4">
              {bracket.rounds.map((r) => (
                <div key={r.round} className="min-w-[190px] shrink-0">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{r.label}</p>
                  <div className="flex flex-col justify-around gap-2" style={{ minHeight: 40 }}>
                    {r.matches.map((m) => (
                      <BracketCell key={m.slot} m={m} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* The bronze match runs alongside the final, on the same seed. */}
          {bracket.thirdPlace && (
            <div className="mt-6 max-w-[220px]">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted">
                <IconMedal className="h-4 w-4 text-amber" />
                Third place
              </p>
              <BracketCell m={bracket.thirdPlace} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

function BracketCell({ m }: { m: BracketMatchView }) {
  // A null side in a resolved match is a genuine bye; before the feeders land
  // it's simply a slot still to be decided.
  const emptyLabel = m.status === "DONE" ? "— bye —" : "TBD";
  const row = (name: string | null, score: number | null, isWinner: boolean) => (
    <div
      className={cn(
        "flex items-center justify-between gap-2 px-3 py-1.5 text-sm",
        isWinner ? "font-semibold text-fg" : "text-muted"
      )}
    >
      <span className="truncate">{name ?? <span className="text-faint">{emptyLabel}</span>}</span>
      <span className="tnum shrink-0 text-xs">{score ?? ""}</span>
    </div>
  );
  const live = m.status === "OPEN";
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-surface",
        live ? "border-gold/60" : "border-border"
      )}
    >
      {row(m.a, m.aScore, m.winner != null && m.winner === m.a)}
      <div className="h-px bg-border" />
      {row(m.b, m.bScore, m.winner != null && m.winner === m.b)}
    </div>
  );
}
