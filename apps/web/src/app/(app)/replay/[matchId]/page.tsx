import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@gamearena/db";
import type { BlockBlastInput } from "@gamearena/games";
import { requireUser } from "@/lib/auth";
import { ReplayViewer } from "./replay-viewer";

export const metadata: Metadata = { title: "Match replay" };

export default async function ReplayPage({
  params,
}: {
  params: Promise<{ matchId: string }>;
}) {
  const { matchId } = await params;
  await requireUser();

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      game: { select: { name: true, key: true, durationS: true } },
      players: { include: { user: { select: { username: true, isBot: true } } } },
    },
  });
  if (!match || match.status !== "SETTLED" || match.game.key !== "block-blast") notFound();

  const players = match.players.map((p) => ({
    username: p.user.username,
    isBot: p.user.isBot,
    serverScore: p.serverScore ?? 0,
    inputs: (p.inputLog as unknown as BlockBlastInput[]) ?? [],
    won: match.winnerUserId === p.userId,
    ratingBefore: p.ratingBefore,
    ratingAfter: p.ratingAfter,
  }));

  return (
    <ReplayViewer
      matchId={match.id}
      gameName={match.game.name}
      durationS={match.game.durationS}
      seed={match.seed}
      seedHash={match.seedHash}
      rulesVersion={match.rulesVersion}
      isDraw={match.isDraw}
      stakeTetri={match.stakeTetri}
      players={players}
    />
  );
}
