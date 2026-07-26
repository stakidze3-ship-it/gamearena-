/**
 * Live spectating for tournaments.
 *
 * Two jobs: report every match currently in progress with enough detail to
 * watch it, and count who is watching what.
 *
 * The shape here is deliberate. A spectator screen shows a LIST of live
 * matches, so it asks for the whole tournament in ONE query rather than one
 * query per match — the cost of a spectator is O(1) in the number of matches,
 * which is what makes a 60-seat bracket with a thousand viewers affordable.
 * Everything is poll-driven, because production has no WebSocket host; the
 * payload carries a `liveKey` so a client can skip re-rendering when nothing
 * moved.
 */

import { prisma } from "./client";

/**
 * A viewer counts as present for this long after their last heartbeat.
 * Comfortably longer than the heartbeat interval so a dropped poll does not
 * make the count flicker.
 */
export const SPECTATOR_TTL_MS = 25_000;

/** Rows older than this are dead weight and get swept opportunistically. */
const SWEEP_AGE_MS = 5 * 60_000;

export interface LiveMatchView {
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
  /** Seconds left in this match's window, floored at 0. */
  secondsLeft: number;
  spectators: number;
}

export interface LiveTournamentView {
  tournamentId: string;
  status: string;
  matches: LiveMatchView[];
  totalSpectators: number;
  /** Changes whenever anything a spectator can see has changed. */
  liveKey: string;
}

function roundLabel(round: number, rounds: number): string {
  const fromTop = rounds - round;
  if (fromTop === 0) return "Final";
  if (fromTop === 1) return "Semifinals";
  if (fromTop === 2) return "Quarterfinals";
  return `Round of ${2 ** (fromTop + 1)}`;
}

/**
 * Record that `viewerId` is watching `matchId`.
 *
 * One upsert on a composite primary key: a single index write, no row growth,
 * and no read first. Callers should heartbeat far less often than they poll
 * scores — see SPECTATOR_TTL_MS.
 */
export async function recordSpectator(
  tournamentId: string,
  matchId: string,
  viewerId: string
): Promise<void> {
  const now = new Date();
  // Keyed by viewer: switching matches UPDATES this row rather than adding a
  // second one, so a viewer is never counted in two matches at once.
  await prisma.spectatorHeartbeat.upsert({
    where: { tournamentId_viewerId: { tournamentId, viewerId } },
    create: { tournamentId, matchId, viewerId, lastSeenAt: now },
    update: { matchId, lastSeenAt: now },
  });
}

/** Drop long-dead heartbeats. Cheap, indexed, and safe to call from anywhere. */
export async function sweepSpectators(): Promise<number> {
  const cutoff = new Date(Date.now() - SWEEP_AGE_MS);
  const { count } = await prisma.spectatorHeartbeat.deleteMany({
    where: { lastSeenAt: { lt: cutoff } },
  });
  return count;
}

/**
 * Live spectator counts for every match in a tournament, in one query.
 *
 * Returns a map of matchId → viewers. Matches nobody is watching are absent.
 */
export async function spectatorCounts(tournamentId: string): Promise<Map<string, number>> {
  const since = new Date(Date.now() - SPECTATOR_TTL_MS);
  const rows = await prisma.spectatorHeartbeat.groupBy({
    by: ["matchId"],
    where: { tournamentId, lastSeenAt: { gte: since } },
    _count: { viewerId: true },
  });
  return new Map(rows.map((r) => [r.matchId, r._count.viewerId]));
}

/**
 * Everything a spectator screen needs for one tournament, in two queries plus
 * one for names.
 */
export async function liveTournamentView(tournamentId: string): Promise<LiveTournamentView | null> {
  const t = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { id: true, status: true, roundDurationS: true, readyWindowS: true },
  });
  if (!t) return null;

  const [allMatches, counts] = await Promise.all([
    prisma.bracketMatch.findMany({
      where: { tournamentId },
      select: {
        id: true, round: true, slot: true, status: true, openedAt: true,
        aUserId: true, bUserId: true, aScore: true, bScore: true,
        aPlayed: true, bPlayed: true,
      },
      orderBy: [{ round: "asc" }, { slot: "asc" }],
    }),
    spectatorCounts(tournamentId),
  ]);
  if (allMatches.length === 0) {
    return { tournamentId, status: t.status, matches: [], totalSpectators: 0, liveKey: `${t.status}:0` };
  }

  const rounds = Math.max(...allMatches.map((m) => m.round));
  const live = allMatches.filter((m) => m.status === "OPEN");

  const ids = new Set<string>();
  for (const m of live) {
    if (m.aUserId) ids.add(m.aUserId);
    if (m.bUserId) ids.add(m.bUserId);
  }
  const users = await prisma.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, username: true },
  });
  const name = new Map(users.map((u) => [u.id, u.username]));

  const now = Date.now();
  const matches: LiveMatchView[] = live.map((m) => {
    // Round 1 uses the longer ready window; later rounds use the round window.
    const windowS = m.round === 1 ? t.readyWindowS : t.roundDurationS;
    const closesAt = m.openedAt ? m.openedAt.getTime() + windowS * 1000 : now;
    const isThirdPlace = m.round === rounds && m.slot === 1;
    return {
      matchId: m.id,
      round: m.round,
      roundLabel: isThirdPlace ? "Third place" : roundLabel(m.round, rounds),
      slot: m.slot,
      isFinal: m.round === rounds && m.slot === 0,
      isThirdPlace,
      a: m.aUserId ? name.get(m.aUserId) ?? null : null,
      b: m.bUserId ? name.get(m.bUserId) ?? null : null,
      aScore: m.aScore,
      bScore: m.bScore,
      aPlayed: m.aPlayed,
      bPlayed: m.bPlayed,
      secondsLeft: Math.max(0, Math.round((closesAt - now) / 1000)),
      spectators: counts.get(m.id) ?? 0,
    };
  });

  // The final first, then the bronze match, then by round descending so the
  // deepest action leads. Ties break on slot for stability.
  matches.sort((a, b) => {
    if (a.isFinal !== b.isFinal) return a.isFinal ? -1 : 1;
    if (a.isThirdPlace !== b.isThirdPlace) return a.isThirdPlace ? -1 : 1;
    if (a.round !== b.round) return b.round - a.round;
    return a.slot - b.slot;
  });

  // Scores and played-flags are in the key so a spectator screen repaints the
  // moment a number moves, but spectator counts are NOT — they churn constantly
  // and would defeat the purpose of having a key at all.
  const liveKey = [
    t.status,
    allMatches.filter((m) => m.status === "DONE").length,
    live.length,
    ...matches.map((m) => `${m.matchId}:${m.aScore ?? ""}:${m.bScore ?? ""}:${m.aPlayed ? 1 : 0}${m.bPlayed ? 1 : 0}`),
  ].join("|");

  return {
    tournamentId,
    status: t.status,
    matches,
    totalSpectators: [...counts.values()].reduce((n, v) => n + v, 0),
    liveKey,
  };
}
