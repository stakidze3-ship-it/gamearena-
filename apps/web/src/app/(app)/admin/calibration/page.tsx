import type { Metadata } from "next";
import { prisma } from "@gamearena/db";
import type { CurvePoint } from "@gamearena/shared";
import { PageHeader } from "@/components/app-shell";
import { CalibrationClient } from "./calibration-client";

export const metadata: Metadata = { title: "Blitz calibration" };

export default async function CalibrationPage() {
  const game = await prisma.game.findUniqueOrThrow({ where: { key: "block-blast" } });
  const config = await prisma.blitzConfig.findFirstOrThrow({
    where: { gameId: game.id, active: true },
  });
  const runs = await prisma.blitzRun.findMany({
    where: { gameId: game.id, status: "SETTLED", serverScore: { not: null } },
    select: { serverScore: true },
    take: 2000,
  });

  return (
    <>
      <PageHeader
        title="Blitz calibration"
        subtitle={`${game.name} · curve v${config.version}. Edit the payout curve against the real score distribution.`}
      />
      <CalibrationClient
        gameKey={game.key}
        version={config.version}
        breakEvenScore={config.breakEvenScore}
        zeroScore={config.zeroScore}
        maxMultBps={config.maxMultBps}
        curve={config.curve as unknown as CurvePoint[]}
        scores={runs.map((r) => r.serverScore!).filter((s) => Number.isFinite(s))}
      />
    </>
  );
}
