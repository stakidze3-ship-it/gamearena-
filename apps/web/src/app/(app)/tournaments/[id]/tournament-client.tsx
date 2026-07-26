"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatTetri, formatTetriCompact } from "@gamearena/shared";
import { BlockBlastBoard, type BlockBlastResult } from "@/components/games/block-blast-board";
import { IconCheck, IconChevronDown, IconChevronLeft, IconChevronRight, IconMedal } from "@/components/icons";
import { ConfettiBurst } from "@/components/confetti";
import { ChampionBanner, SpectatorPanel } from "@/components/tournament/spectator-panel";
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
  matchId?: string | null;
  hasReplay?: boolean;
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
  username,
  bracket,
  registration,
}: {
  tournament: Tournament;
  entries: Entry[];
  myEntry: { registered: boolean; bestScore: number | null };
  balanceTetri: number;
  isAdmin: boolean;
  username: string;
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

  // EVERY hook must run before the early returns below.
  //
  // This lived under them, so the moment `phase` flipped to "playing" the
  // component returned before reaching it and React saw fewer hooks than the
  // previous render — "Rendered fewer hooks than expected". That threw on the
  // exact click that starts a match, which made every tournament unplayable.
  // Where the viewer stands in the bracket, derived rather than stored: the
  // last DONE match containing them tells the whole story. A semifinal loss is
  // NOT elimination — the bronze match is still coming — which is exactly the
  // kind of state a player panics about if the page gets it wrong.
  const standing = useMemo(() => {
    if (!isKnockout || !bracket || !myEntry.registered) return null;
    const bronze = bracket.thirdPlace;
    if (bronze && bronze.status === "DONE" && (bronze.a === username || bronze.b === username)) {
      return bronze.winner === username
        ? { kind: "placed" as const, label: "Third place" }
        : { kind: "placed" as const, label: "Fourth place" };
    }
    for (const r of [...bracket.rounds].reverse()) {
      for (const m of r.matches) {
        if (m.status !== "DONE" || !m.winner) continue;
        if (m.a !== username && m.b !== username) continue;
        if (m.winner === username) return { kind: "alive" as const, label: r.label };
        const isSemi = r.label === "Semifinals";
        // A semifinal loss is never elimination. The bronze shell is only
        // seated once BOTH semis resolve, so for a moment there is no bronze
        // row at all — a null here still means "your third-place match is
        // coming", not "you're out".
        if (isSemi && (!bronze || bronze.status !== "DONE")) {
          return { kind: "bronze-coming" as const, label: r.label };
        }
        if (r.label === "Final") return { kind: "placed" as const, label: "Runner-up" };
        return { kind: "out" as const, label: r.label };
      }
    }
    return { kind: "alive" as const, label: null };
  }, [isKnockout, bracket, myEntry.registered, username]);

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


  // The settled final, for the champion moment and its replay.
  const finalMatch =
    isKnockout && bracket && bracket.rounds.length > 0
      ? bracket.rounds[bracket.rounds.length - 1]!.matches[0] ?? null
      : null;
  const championName = t.status === "FINISHED" ? finalMatch?.winner ?? null : null;
  const firstPrizeTetri = (() => {
    const top = t.prizeStructure.find((x) => x.rank === 1);
    if (!top) return 0;
    // From entries, not the live escrow: by the time a champion exists the
    // escrow has been paid out and reads zero.
    const pool = Math.max(t.poolTetri, t.entryCount * t.entryTetri);
    return Math.floor((pool * top.shareBps) / 10_000);
  })();

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
        <h1 className="mt-2 font-display text-2xl font-bold tracking-tight md:text-3xl">{t.name}</h1>
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

        {/* The live match. Not a status line — a matchup. Who you play, what
            round, how long you have, and one unmissable action. */}
        {isKnockout && myEntry.registered && !t.ended && (
          canPlay && bracket?.myMatch ? (
            <MatchHero
              username={username}
              label={myRoundLabel ?? "Your match"}
              opponent={bracket.myMatch.opponent}
              closesAt={bracket.myMatch.closesAt}
              windowS={bracket.myMatch.round === 1 ? t.readyWindowS : t.roundDurationS}
              readyUp={bracket.myMatch.round === 1}
              onPlay={play}
            />
          ) : (
            t.status === "RUNNING" && standing && <StandbyCard standing={standing} />
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
          <>
            {/* Spectating: shown whenever the bracket is live and the viewer is
                not mid-match. A player with a match to run should be running
                it, not watching — but the moment they are out (or waiting on an
                opponent) this is what keeps them here. */}
            {t.status === "RUNNING" && phase === "idle" && (
              <SpectatorPanel tournamentId={t.id} />
            )}
            {championName && (
              championName === username ? (
                <div className="relative overflow-hidden rounded-2xl border border-gold/60 bg-gradient-to-b from-gold/15 to-transparent px-6 py-10 text-center shadow-glow-gold">
                  <ConfettiBurst />
                  <p className="text-xs font-bold uppercase tracking-[0.2em] text-gold">Champion</p>
                  <p className="mt-3 font-display text-4xl font-bold tracking-tight">You did it.</p>
                  {firstPrizeTetri > 0 && (
                    <p className="tnum mt-3 text-lg font-semibold text-gold">
                      {formatTetri(firstPrizeTetri)} is yours
                    </p>
                  )}
                </div>
              ) : (
                <ChampionBanner
                  champion={championName}
                  prizeLabel={firstPrizeTetri > 0 ? `Takes ${formatTetri(firstPrizeTetri)}` : null}
                  replayHref={
                    finalMatch?.hasReplay && finalMatch.matchId
                      ? `/replay/bracket/${finalMatch.matchId}`
                      : null
                  }
                />
              )
            )}
            <BracketBoard bracket={bracket} status={t.status} ended={t.ended} lastRun={lastRun} />
          </>
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

/**
 * The live match, staged as a matchup rather than reported as a status.
 *
 * Everything a player needs is in one card, in reading order: the round, the
 * two names, the clock, the action. The countdown is the second-largest thing
 * on screen because the deadline is the one fact with a consequence (forfeit),
 * and the button is full-width and glowing because on this screen there is
 * exactly one thing to do.
 */
function MatchHero({
  username,
  label,
  opponent,
  closesAt,
  windowS,
  readyUp,
  onPlay,
}: {
  username: string;
  label: string;
  opponent: string | null;
  closesAt: string | null;
  windowS: number;
  readyUp: boolean;
  onPlay: () => void;
}) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-gold/40 bg-gradient-to-b from-gold/10 via-surface to-surface px-5 py-7 shadow-glow-gold sm:px-8">
      <div className="flex items-center justify-center gap-2">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-gold opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-gold" />
        </span>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-gold">{label} · Live</p>
      </div>

      {/* Faceoff */}
      <div className="mt-7 flex items-center gap-3">
        <div className="min-w-0 flex-1 text-center">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted">You</p>
          <p className="mt-1 truncate font-display text-2xl font-bold tracking-tight">{username}</p>
        </div>
        <p className="shrink-0 font-display text-sm font-bold text-faint">VS</p>
        <div className="min-w-0 flex-1 text-center">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Opponent</p>
          <p className={cn("mt-1 truncate font-display text-2xl font-bold tracking-tight", !opponent && "text-muted")}>
            {opponent ?? "TBD"}
          </p>
        </div>
      </div>

      {closesAt && <HeroCountdown closesAt={closesAt} windowS={windowS} />}

      <Button
        variant="primary"
        size="lg"
        className="mt-7 h-16 w-full text-md font-semibold shadow-glow-gold"
        onClick={onPlay}
      >
        {readyUp ? "Ready up & play" : "Play your match"}
      </Button>
    </section>
  );
}

/**
 * Big drain clock: the number is the urgency, the bar is the proportion.
 *
 * Everything renders from WHOLE seconds, and the two time-derived nodes carry
 * suppressHydrationWarning — the server paints this a beat before the client
 * hydrates it, so millisecond-precision widths can never match and even the
 * seconds can straddle a boundary. The first tick reconciles within a second.
 */
function HeroCountdown({ closesAt, windowS }: { closesAt: string; windowS: number }) {
  const target = new Date(closesAt).getTime();
  const [leftS, setLeftS] = useState(() => Math.max(0, Math.floor((target - Date.now()) / 1000)));
  useEffect(() => {
    const tick = () => setLeftS(Math.max(0, Math.floor((target - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target]);
  const low = leftS <= 60;
  const frac = Math.max(0, Math.min(1, leftS / windowS));
  return (
    <div className="mt-7 text-center">
      <p
        suppressHydrationWarning
        className={cn(
          "tnum font-display text-5xl font-bold leading-none tracking-tight",
          low ? "animate-pulse text-coral" : "text-fg"
        )}
      >
        {Math.floor(leftS / 60)}:{String(leftS % 60).padStart(2, "0")}
      </p>
      <div className="mx-auto mt-3 h-1 w-40 overflow-hidden rounded-full bg-raised">
        <div
          suppressHydrationWarning
          className={cn("h-full rounded-full transition-[width] duration-1000 ease-linear", low ? "bg-coral" : "bg-gold")}
          style={{ width: `${Math.round(frac * 1000) / 10}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-muted">to play — miss it and you forfeit</p>
    </div>
  );
}

/**
 * Between matches: still in, bronze coming, or out. Each state says what
 * happens next, because "waiting" with no explanation is what makes a live
 * event feel like a stalled dashboard.
 */
function StandbyCard({
  standing,
}: {
  standing:
    | { kind: "alive"; label: string | null }
    | { kind: "bronze-coming"; label: string | null }
    | { kind: "out"; label: string | null }
    | { kind: "placed"; label: string };
}) {
  if (standing.kind === "alive") {
    return (
      <div className="rounded-2xl border border-gold/30 bg-surface px-5 py-6 text-center">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-gold">
          {standing.label ? `${standing.label} — won` : "You're in"}
        </p>
        <p className="mt-2 font-display text-xl font-bold tracking-tight">You're through.</p>
        <p className="mt-2 text-sm text-muted">
          Your next match opens the moment the round finishes — watch the rest live below.
        </p>
      </div>
    );
  }
  if (standing.kind === "bronze-coming") {
    return (
      <div className="rounded-2xl border border-amber/40 bg-surface px-5 py-6 text-center">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber">Third-place match</p>
        <p className="mt-2 font-display text-xl font-bold tracking-tight">One more to play for.</p>
        <p className="mt-2 text-sm text-muted">
          The semifinal didn't go your way, but bronze is still on the table — your match opens
          alongside the final.
        </p>
      </div>
    );
  }
  if (standing.kind === "placed") {
    return (
      <div className="rounded-2xl border border-border bg-surface px-5 py-6 text-center">
        <p className="flex items-center justify-center gap-1.5 text-sm font-semibold">
          <IconMedal className="h-4 w-4 text-amber" />
          {standing.label}
        </p>
        <p className="mt-2 text-sm text-muted">Great run. The rest of the bracket plays out below.</p>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border border-border bg-surface px-5 py-6 text-center">
      <p className="text-sm font-semibold">
        Knocked out{standing.label ? ` in the ${standing.label}` : ""}.
      </p>
      <p className="mt-2 text-sm text-muted">
        Stay for the finish — every live match is right below, and the bracket updates as it
        happens.
      </p>
    </div>
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
  // A future match whose players are not both known yet. Shown, but visibly
  // not-yet-playable, so the shape of the bracket reads at a glance.
  const locked = m.status === "PENDING";
  const row = (name: string | null, score: number | null, isWinner: boolean) => (
    <div
      className={cn(
        "flex items-center justify-between gap-2 px-3 py-1.5 text-sm",
        isWinner ? "font-semibold text-fg" : "text-muted"
      )}
    >
      <span className={cn("truncate", locked && "text-faint")}>
        {name ?? <span className="text-faint">{emptyLabel}</span>}
      </span>
      <span className="tnum shrink-0 text-xs">{score ?? ""}</span>
    </div>
  );
  const live = m.status === "OPEN";
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border transition-colors duration-150",
        live && "border-gold/60 bg-surface",
        m.status === "DONE" && "border-border bg-surface",
        locked && "border-border/50 bg-bg/40"
      )}
    >
      {live && (
        <div className="flex items-center gap-1.5 border-b border-gold/25 px-3 py-1">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-gold opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-gold" />
          </span>
          <span className="text-[10px] font-bold uppercase tracking-wider text-gold">Live</span>
        </div>
      )}
      {row(m.a, m.aScore, m.winner != null && m.winner === m.a)}
      <div className={cn("h-px", locked ? "bg-border/50" : "bg-border")} />
      {row(m.b, m.bScore, m.winner != null && m.winner === m.b)}
      {m.hasReplay && m.matchId && (
        <Link
          href={`/replay/bracket/${m.matchId}`}
          className="flex items-center justify-center gap-1 border-t border-border px-3 py-1.5 text-[11px] text-muted transition-colors duration-150 hover:text-fg"
        >
          Watch replay
          <IconChevronRight className="h-3 w-3" />
        </Link>
      )}
    </div>
  );
}
