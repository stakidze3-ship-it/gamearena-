import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@gamearena/db";
import { PageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list-row";
import { ReviewActions } from "./review-actions";

export const metadata: Metadata = { title: "Review queue" };

const REASON_LABEL: Record<string, string> = {
  WINRATE_ANOMALY: "Win-rate anomaly",
  INPUT_SPEED: "Inhuman input speed",
  INPUT_REGULARITY: "Metronome input timing",
  DEVICE_SHARED: "Shared device",
};

function summarize(reason: string, detail: Record<string, unknown> | null): string {
  if (!detail) return "";
  switch (reason) {
    case "WINRATE_ANOMALY":
      return `${detail.wins}/${detail.matches} wins (${Math.round(
        (Number(detail.wins) / Number(detail.matches)) * 100
      )}%)`;
    case "INPUT_SPEED":
      return `median ${detail.medianIntervalMs}ms · ${Math.round(
        Number(detail.fastFraction) * 100
      )}% under floor · ${detail.inputs} inputs`;
    case "INPUT_REGULARITY":
      return `interval CV ${detail.cv} · median ${detail.medianIntervalMs}ms`;
    case "DEVICE_SHARED":
      return `device ${detail.hash}… backs ${detail.accountCount} accounts`;
    default:
      return "";
  }
}

export default async function ReviewQueuePage() {
  const [open, resolved] = await Promise.all([
    prisma.reviewCase.findMany({
      where: { status: "OPEN" },
      orderBy: { createdAt: "desc" },
      include: { user: { select: { username: true, payoutHold: true, suspendedAt: true } } },
    }),
    prisma.reviewCase.findMany({
      where: { status: { not: "OPEN" } },
      orderBy: { resolvedAt: "desc" },
      take: 8,
      include: { user: { select: { username: true } } },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Review queue"
        subtitle="Anti-cheat signals awaiting a human decision. Payouts are held while a case is open."
        action={<Badge tone={open.length ? "coral" : "mint"}>{open.length} open</Badge>}
      />

      <div className="space-y-3">
        {open.length === 0 && (
          <p className="py-10 text-center text-sm text-muted">Nothing to review — all clear.</p>
        )}

        {open.map((c) => {
          const detail = c.detail as Record<string, unknown> | null;
          const matchId = detail?.matchId as string | undefined;
          return (
            <Card key={c.id}>
              <CardBody className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{c.user.username}</span>
                    <Badge tone={c.reason === "WINRATE_ANOMALY" ? "coral" : "amber"}>
                      {REASON_LABEL[c.reason] ?? c.reason}
                    </Badge>
                    {c.user.payoutHold && <Badge tone="coral">Payout held</Badge>}
                    {c.user.suspendedAt && <Badge tone="muted">Suspended</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-muted">{summarize(c.reason, detail)}</p>
                  <p className="mt-0.5 text-xs text-faint">
                    Opened {c.createdAt.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    {matchId && (
                      <>
                        {" · "}
                        <Link href={`/replay/${matchId}`} className="text-gold underline-offset-2 transition-colors duration-150 hover:underline">
                          watch replay →
                        </Link>
                      </>
                    )}
                  </p>
                </div>
                <ReviewActions caseId={c.id} />
              </CardBody>
            </Card>
          );
        })}
      </div>

      {resolved.length > 0 && (
        <>
          <h2 className="mb-3 mt-10 text-2xs font-semibold uppercase tracking-wide text-muted">
            Recently resolved
          </h2>
          <Card>
            <List>
              {resolved.map((c) => (
                <ListRow key={c.id} className="text-sm">
                  <span>
                    <span className="font-medium">{c.user.username}</span>{" "}
                    <span className="text-muted">· {REASON_LABEL[c.reason] ?? c.reason}</span>
                  </span>
                  <Badge tone={c.status === "CLEARED" ? "mint" : "coral"}>
                    {c.status === "CLEARED" ? "Cleared" : "Action taken"}
                  </Badge>
                </ListRow>
              ))}
            </List>
          </Card>
        </>
      )}
    </>
  );
}
