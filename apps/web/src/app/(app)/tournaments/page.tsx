import type { Metadata } from "next";
import Link from "next/link";
import { ensureOpenKnockout, prisma } from "@gamearena/db";
import { formatTetri, formatTetriCompact, isAwaitingPlayers, prizeTetriFor } from "@gamearena/shared";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list-row";
import { IconChevronRight } from "@/components/icons";

export const metadata: Metadata = { title: "Tournaments" };

export default async function TournamentsPage() {
  // There must always be something to enter. Neither of the two mechanisms
  // that used to guarantee this survives here: production has no scheduler,
  // and the build-time seed is deliberately non-fatal, so a failed seed ships
  // a green deploy with an empty page and nothing to show for it. Doing it at
  // read time means the page that needs an event is the page that makes one.
  await ensureOpenKnockout();

  const tournaments = await prisma.tournament.findMany({
    // Test events are bot-filled by an admin and settle out of treasury credit.
    // They are reachable by direct link for whoever made them, but they must
    // never sit in a real player's tournament list.
    where: { status: { in: ["SCHEDULED", "RUNNING", "FINISHED"] }, isTest: false },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 25, // history grows forever; the page only ever shows a recent slice
    include: { game: { select: { name: true } }, _count: { select: { entries: true } } },
  });

  // One event is featured at the top; the rest go in the list below. That list
  // is NOT necessarily history — a second open event can exist (an admin can
  // schedule one), and calling it "Finished" would send a player to a
  // registration page badged as over.
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
          <p className="mb-3 text-xs font-medium uppercase tracking-wider text-muted">
            {past.some((t) => t.status !== "FINISHED") ? "More events" : "Past events"}
          </p>
          <Card className="overflow-hidden">
            <List>
              {past.map((t) => (
                <Link key={t.id} href={`/tournaments/${t.id}`} className="block">
                  <ListRow interactive>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-medium tracking-tight">{t.name}</h3>
                        <Badge
                          tone={
                            t.status === "RUNNING" ? "gold" : t.status === "SCHEDULED" ? "neutral" : "muted"
                          }
                        >
                          {t.status === "RUNNING"
                            ? "Live"
                            : t.status === "SCHEDULED"
                              ? "Open"
                              : "Finished"}
                        </Badge>
                      </div>
                      <p className="tnum mt-1 text-xs text-muted">
                        {t._count.entries} {t.status === "FINISHED" ? "played" : "entered"} ·{" "}
                        {formatTetriCompact(t.entryTetri)} entry
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
