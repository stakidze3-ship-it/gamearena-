import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@gamearena/db";
import {
  blitzPayoutTetri,
  formatTetri,
  formatTetriCompact,
  type CurvePoint,
} from "@gamearena/shared";
import { PageHeader } from "@/components/app-shell";
import { IconChevronDown, IconChevronRight } from "@/components/icons";
import { buttonClasses } from "@/components/ui/button";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";

export const metadata: Metadata = { title: "Blitz" };

export default async function BlitzPage() {
  const configs = await prisma.blitzConfig.findMany({
    where: { active: true, game: { enabled: true } },
    include: { game: true },
    orderBy: { game: { name: "asc" } },
  });

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Blitz" subtitle="Solo runs. No opponent, no waiting — beat the bar." />

      {configs.length === 0 && (
        <p className="text-sm text-muted">No Blitz games are live right now.</p>
      )}

      <div className="space-y-12">
        {configs.map((cfg) => {
          const curve = cfg.curve as unknown as CurvePoint[];
          // Illustrative rows for the payout table (₾2 entry)
          const sampleEntry = 200;
          const rows = [
            { label: "below", score: cfg.zeroScore - 1 },
            { score: cfg.zeroScore },
            { score: Math.round((cfg.zeroScore + cfg.breakEvenScore) / 2) },
            { score: cfg.breakEvenScore, highlight: true },
            { score: 1000 },
            { score: 1200 },
            { score: 1400 },
            { score: 1600 },
          ];
          return (
            <section key={cfg.id} className="space-y-4">
              <div>
                <h2 className="font-display text-lg font-bold tracking-tight">{cfg.game.name}</h2>
                <p className="tnum mt-1 text-sm text-muted">
                  {cfg.game.durationS}s solo run · break-even {cfg.breakEvenScore}
                </p>
              </div>

              <Link
                href={`/blitz/${cfg.game.key}`}
                className={buttonClasses({ variant: "primary", size: "lg", className: "w-full" })}
              >
                Play Blitz
                <IconChevronRight className="h-4 w-4" />
              </Link>

              <p className="text-center">
                <Link
                  href={`/blitz/${cfg.game.key}`}
                  className="text-sm text-muted transition-colors duration-150 hover:text-fg"
                >
                  Practice free
                </Link>
              </p>

              <details className="group rounded-lg border border-border bg-surface">
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-muted transition-colors duration-150 hover:text-fg [&::-webkit-details-marker]:hidden">
                  See the exact payout curve
                  <IconChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180" />
                </summary>
                <div className="border-t border-border px-4 py-3 text-sm text-muted">
                  <Table>
                    <THead>
                      <tr className="border-b border-border">
                        <Th>Score</Th>
                        <Th>Multiplier</Th>
                        <Th className="text-right">{formatTetriCompact(sampleEntry)} entry pays</Th>
                      </tr>
                    </THead>
                    <TBody className="tnum">
                      {rows.map((row, i) => {
                        const { multBps, payoutTetri } = blitzPayoutTetri(
                          sampleEntry,
                          curve,
                          row.score,
                          cfg.maxMultBps
                        );
                        return (
                          <Tr key={i} highlight={row.highlight}>
                            <Td className="text-fg">
                              {"label" in row && row.label ? `< ${cfg.zeroScore}` : row.score}
                            </Td>
                            <Td>{(multBps / 10000).toFixed(2)}×</Td>
                            <Td className="text-right font-medium text-fg">
                              {payoutTetri > 0 ? formatTetri(payoutTetri) : "—"}
                            </Td>
                          </Tr>
                        );
                      })}
                    </TBody>
                  </Table>
                  <p className="mt-2 text-xs leading-relaxed text-faint">
                    Payouts scale linearly between the points shown, are capped at{" "}
                    {(cfg.maxMultBps / 10000).toFixed(1)}× and round down to the tetri. This table is
                    the live server configuration (curve v{cfg.version}) — the exact curve your run
                    settles on.
                  </p>
                </div>
              </details>
            </section>
          );
        })}
      </div>
    </div>
  );
}
