import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountKeys, getBalanceTetri, prisma } from "@gamearena/db";
import { getGameDefinition } from "@gamearena/games";
import { requireUser } from "@/lib/auth";
import { MatchClient } from "./match-client";

export const metadata: Metadata = { title: "Quick match" };

export default async function MatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ game: string }>;
  searchParams: Promise<{ challenge?: string; stake?: string }>;
}) {
  const { game: gameKey } = await params;
  const { challenge, stake } = await searchParams;
  const user = await requireUser();

  const game = await prisma.game.findUnique({ where: { key: gameKey } });
  if (!game || !getGameDefinition(gameKey)) notFound();

  const balanceTetri = await getBalanceTetri(prisma, AccountKeys.userCash(user.id));
  const excluded = !!(user.selfExcludedUntil && user.selfExcludedUntil > new Date());

  return (
    <MatchClient
      gameKey={game.key}
      gameName={game.name}
      enabled={game.enabled}
      durationS={game.durationS}
      username={user.username}
      balanceTetri={balanceTetri}
      excluded={excluded}
      challengeId={challenge}
      presetStake={stake ? Number(stake) : undefined}
    />
  );
}
