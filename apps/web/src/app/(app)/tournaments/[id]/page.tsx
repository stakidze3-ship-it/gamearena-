import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountKeys, firstRoundPlan, getBalanceTetri, knockoutView, prisma } from "@gamearena/db";
import { isAwaitingPlayers } from "@gamearena/shared";
import { requireUser } from "@/lib/auth";
import { tournamentInviteUrl } from "@/lib/origin";
import { finalizeTournament, tournamentEndsAt } from "@/lib/tournaments";
import { CrashBoundary } from "@/components/crash-boundary";
import { TournamentClient } from "./tournament-client";

export const metadata: Metadata = { title: "Tournament" };

export default async function TournamentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();

  let t = await prisma.tournament.findUnique({ where: { id } });
  if (!t) notFound();

  const isKnockout = t.format === "KNOCKOUT";
  if (isKnockout) {
    // The bracket is driven by /api/tournaments/[id]/state, which throttles to
    // one advance per event per window. It used to be driven from here too, on
    // every render and with no throttle — and since the live hook calls
    // router.refresh() whenever the state key moves, a full 60-player lobby
    // turned every result into 60 simultaneous unthrottled advances, each
    // scanning the bracket and taking row locks. The poll fires immediately on
    // mount, so nothing is lost by leaving the driving to it.
  } else if (t.status !== "FINISHED" && new Date() > tournamentEndsAt(t.startsAt, t.durationS)) {
    // Opportunistically settle a leaderboard whose window has closed.
    await finalizeTournament(id);
  }
  t = await prisma.tournament.findUnique({ where: { id } });
  if (!t) notFound();

  const bracket = isKnockout
    ? await knockoutView(id, user.id, t.roundDurationS, t.readyWindowS)
    : null;

  const [game, entries, myEntry, balanceTetri] = await Promise.all([
    prisma.game.findUniqueOrThrow({ where: { id: t.gameId } }),
    prisma.tournamentEntry.findMany({
      where: { tournamentId: id },
      include: { user: { select: { username: true, isBot: true } } },
    }),
    prisma.tournamentEntry.findUnique({
      where: { tournamentId_userId: { tournamentId: id, userId: user.id } },
    }),
    getBalanceTetri(prisma, AccountKeys.userCash(user.id)),
  ]);

  // Registration-phase preview: everyone who's in, and the provisional first-
  // round pairings in registration order (#1 vs #2, …) so players see exactly
  // who they'll face before the draw locks.
  let registration: {
    registrants: { seed: number; username: string; isBot: boolean; isMe: boolean }[];
    pairings: { a: { username: string; isMe: boolean } | null; b: { username: string; isMe: boolean } | null; bye: boolean }[];
  } | null = null;
  if (isKnockout && t.status === "SCHEDULED") {
    const ordered = [...entries].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
    const registrants = ordered.map((e, i) => ({
      seed: i + 1,
      username: e.user.username,
      isBot: e.user.isBot,
      isMe: e.userId === user.id,
    }));
    const side = (idx: number | null) =>
      idx != null && ordered[idx]
        ? { username: ordered[idx]!.user.username, isMe: ordered[idx]!.userId === user.id }
        : null;
    const pairings = firstRoundPlan(ordered.length).map((m) => ({
      a: side(m.a),
      b: side(m.b),
      bye: m.bye,
    }));
    registration = { registrants, pairings };
  }

  const [escrow, shareUrl] = await Promise.all([
    getBalanceTetri(prisma, AccountKeys.tournamentEscrow(id)),
    tournamentInviteUrl(id),
  ]);
  const ended = isKnockout
    ? t.status === "FINISHED" || t.status === "CANCELLED"
    : new Date() > tournamentEndsAt(t.startsAt, t.durationS) || t.status === "FINISHED";

  return (
    <CrashBoundary
      scope="tournament"
      // Passed as props rather than read by a hook inside the client: this
      // screen died once from a hook added in the wrong place, and telemetry
      // must not be able to cause the failure it exists to report.
      context={{
        tournamentId: t.id,
        matchId: bracket?.myMatch?.id,
        playerId: user.id,
      }}
    >
    <TournamentClient
      isAdmin={user.role === "ADMIN"}
      username={user.username}
      balanceTetri={balanceTetri}
      bracket={bracket}
      registration={registration}
      tournament={{
        id: t.id,
        name: t.name,
        gameName: game.name,
        gameKey: game.key,
        durationS: game.durationS,
        entryTetri: t.entryTetri,
        guaranteeTetri: t.guaranteeTetri,
        prizeStructure: t.prizeStructure as { rank: number; shareBps: number }[],
        capacity: t.capacity,
        status: t.status,
        format: t.format,
        roundDurationS: t.roundDurationS,
        readyWindowS: t.readyWindowS,
        seed: t.seed,
        startsAt: t.startsAt.toISOString(),
        endsAt: tournamentEndsAt(t.startsAt, t.durationS).toISOString(),
        // While seats are still open the escrow is partial, so advertise what a
        // full field pays — that is what the published prizes are sized from.
        // Once it is under way the real escrow is the truth.
        poolTetri:
          t.status === "SCHEDULED"
            ? Math.max(t.entryTetri * t.capacity, t.guaranteeTetri)
            : Math.max(escrow, t.guaranteeTetri),
        entryCount: entries.length,
        ended,
        awaitingPlayers: isAwaitingPlayers(t.startsAt),
        shareUrl,
      }}
      entries={entries
        .map((e) => ({
          username: e.user.username,
          isBot: e.user.isBot,
          bestScore: e.bestScore,
          rank: e.rank,
          prizeTetri: e.prizeTetri,
          isMe: e.userId === user.id,
        }))
        .sort((a, b) => (b.bestScore ?? -1) - (a.bestScore ?? -1))}
      myEntry={myEntry ? { registered: true, bestScore: myEntry.bestScore } : { registered: false, bestScore: null }}
    />
    </CrashBoundary>
  );
}
