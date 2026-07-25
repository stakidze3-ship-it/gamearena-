import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountKeys, getBalanceTetri, prisma } from "@gamearena/db";
import { getGameDefinition } from "@gamearena/games";
import type { CurvePoint } from "@gamearena/shared";
import { requireUser } from "@/lib/auth";
import { BlitzClient } from "./blitz-client";

export const metadata: Metadata = { title: "Blitz run" };

export default async function BlitzGamePage({
  params,
}: {
  params: Promise<{ game: string }>;
}) {
  const { game: gameKey } = await params;
  const user = await requireUser();

  const game = await prisma.game.findUnique({ where: { key: gameKey } });
  if (!game || !getGameDefinition(gameKey)) notFound();

  const config = await prisma.blitzConfig.findFirst({
    where: { gameId: game.id, active: true },
  });
  if (!config) notFound();

  const balanceTetri = await getBalanceTetri(prisma, AccountKeys.userCash(user.id));
  const excluded = !!(user.selfExcludedUntil && user.selfExcludedUntil > new Date());

  return (
    <BlitzClient
      gameKey={game.key}
      gameName={game.name}
      enabled={game.enabled}
      durationS={game.durationS}
      config={{
        breakEvenScore: config.breakEvenScore,
        zeroScore: config.zeroScore,
        maxMultBps: config.maxMultBps,
        curve: config.curve as unknown as CurvePoint[],
      }}
      balanceTetri={balanceTetri}
      excluded={excluded}
    />
  );
}
