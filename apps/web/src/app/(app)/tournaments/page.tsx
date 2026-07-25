import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@gamearena/db";
import { formatTetri, formatTetriCompact, isAwaitingPlayers, prizeTetriFor } from "@gamearena/shared";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list-row";
import { IconChevronRight } from "@/components/icons";

export const metadata: Metadata = { title: "Tournaments" };

export default async function TournamentsPage() {
  const tournaments = await prisma.tournament.findMany({
    where: { status: { in: ["SCHEDULED", "RUNNING", "FINISHED"] } },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: { game: { select: { name: true } }, _count: { select: { entries: true } } },
  });

  // One event is live at a time; everything else is history.
  const active = tournaments.find((t) => t.status === "SCHEDULED" || t.status === "RUNNING");
  const past = tournaments.filter((t) => t.id !== active?.id);

  return (
    <div className="mx-auto max-w-xl">
      {active ? (
        <section className="text-center">
          <p className="text-xs font-medium uppercase tracking-wider text-muted">
            {active.game.name} · Knockout
          </p>
          <h1 className="mt-2 font-display text-xl font-bold tracking-tight md:text-2xl">
            {active.name}
          </h1>

          <p className="tnum mt-8 font-display text-4xl font-bold tracking-tight">
            {active._count.entries}
            <span className="text-muted">/{active.capacity}</span>
          </p>
          <p className="mt-2 text-sm text-muted">
            {active.status === "RUNNING"
              ? "Bracket in progress"
              : isAwaitingPlayers(active.startsAt)
                ? "seats taken — it starts the moment the field is full"
                : "field complete — the draw is moments away"}
          </p>

          <Link
            href={`/tournaments/${active.id}`}
            className={buttonClasses({
              variant: "primary",
              size: "lg",
              className: "mt-8 h-14 w-full text-md",
            })}
          >
            {active.status === "RUNNING"
              ? "Open the bracket"
              : `Take a seat · ${formatTetriCompact(active.entryTetri)}`}
          </Link>

          <p className="tnum mt-4 text-sm text-muted">
            {formatTetri(prizeTetriFor(1, active.entryTetri * active.capacity))} to the winner ·{" "}
            {formatTetri(active.entryTetri * active.capacity)} in prizes
          </p>
        </section>
      ) : (
        <p className="py-16 text-center text-sm text-muted">
          No tournament is open right now — the next one appears here.
        </p>
      )}

      {past.length > 0 && (
        <section className="mt-16">
          <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">Past events</p>
          <Card className="overflow-hidden">
            <List>
              {past.map((t) => (
                <Link key={t.id} href={`/tournaments/${t.id}`} className="block">
                  <ListRow interactive>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-medium tracking-tight">{t.name}</h3>
                        <Badge tone="muted">Finished</Badge>
                      </div>
                      <p className="tnum mt-1 text-xs text-muted">
                        {t._count.entries} played · {formatTetriCompact(t.entryTetri)} entry
                        {t.finishedAt
                          ? ` · ${t.finishedAt.toLocaleDateString("en-GB", {
                              day: "numeric",
                              month: "short",
                            })}`
                          : ""}
                      </p>
                    </div>
                    <IconChevronRight className="h-4 w-4 shrink-0 text-faint" />
                  </ListRow>
                </Link>
              ))}
            </List>
          </Card>
        </section>
      )}
    </div>
  );
}
