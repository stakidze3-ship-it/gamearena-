import { notFound } from "next/navigation";
import { prisma, type BlockBlastInput } from "@gamearena/db";
import { requireUser } from "@/lib/auth";
import { ReplayViewer } from "../../[matchId]/replay-viewer";

/**
 * Replay of a finished tournament match.
 *
 * Reuses the 1v1 replay viewer wholesale — a bracket match is the same thing
 * (two players, one shared seed, two input logs), so giving it a second viewer
 * would mean two code paths drifting apart. This page only adapts the row shape.
 *
 * The input logs are explicitly selected: the bulk bracket queries omit them
 * because they are large and read on every poll, so anything that genuinely
 * wants a replay has to ask.
 */
export default async function BracketReplayPage({
  params,
}: {
  params: Promise<{ matchId: string }>;
}) {
  await requireUser();
  const { matchId } = await params;

  const m = await prisma.bracketMatch.findUnique({
    where: { id: matchId },
    select: {
      id: true, round: true, slot: true, status: true, seed: true, seedHash: true,
      aUserId: true, bUserId: true, aScore: true, bScore: true,
      aInputLog: true, bInputLog: true, winnerUserId: true, rulesVersion: true,
      tournament: { select: { id: true, name: true, durationS: true, game: { select: { name: true, durationS: true } } } },
    },
  });
  if (!m || m.status !== "DONE" || !m.seed || !m.aInputLog || !m.bInputLog) notFound();

  const rounds = await prisma.bracketMatch.aggregate({
    where: { tournamentId: m.tournament.id },
    _max: { round: true },
  });
  const top = rounds._max.round ?? m.round;
  const isThirdPlace = m.round === top && m.slot === 1;
  const label = isThirdPlace
    ? "Third place"
    : top - m.round === 0
      ? "Final"
      : top - m.round === 1
        ? "Semifinal"
        : top - m.round === 2
          ? "Quarterfinal"
          : `Round of ${2 ** (top - m.round + 1)}`;

  const users = await prisma.user.findMany({
    where: { id: { in: [m.aUserId, m.bUserId].filter((x): x is string => !!x) } },
    select: { id: true, username: true, isBot: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  const side = (userId: string | null, score: number | null, log: unknown) => {
    const u = userId ? byId.get(userId) : null;
    return {
      username: u?.username ?? "—",
      isBot: u?.isBot ?? false,
      serverScore: score ?? 0,
      inputs: (log as unknown as BlockBlastInput[]) ?? [],
      won: !!userId && m.winnerUserId === userId,
      ratingBefore: null,
      ratingAfter: null,
    };
  };

  return (
    <ReplayViewer
      matchId={m.id}
      gameName={`${m.tournament.name} · ${label}`}
      durationS={m.tournament.game.durationS}
      seed={m.seed}
      seedHash={m.seedHash ?? ""}
      rulesVersion={m.rulesVersion}
      isDraw={false}
      stakeTetri={0}
      players={[side(m.aUserId, m.aScore, m.aInputLog), side(m.bUserId, m.bScore, m.bInputLog)]}
    />
  );
}
