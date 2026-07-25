import type { Metadata } from "next";
import { prisma } from "@gamearena/db";
import { formatTetriCompact } from "@gamearena/shared";
import { PageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { List } from "@/components/ui/list-row";
import {
  AnnouncementToggle,
  CreateTournament,
  PostAnnouncement,
  ScheduleHappyHour,
} from "./liveops-client";

export const metadata: Metadata = { title: "Liveops" };

export default async function LiveopsPage() {
  const [announcements, happyHours, upcoming] = await Promise.all([
    prisma.announcement.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.happyHour.findMany({ where: { endsAt: { gt: new Date() } }, orderBy: { startsAt: "asc" }, take: 5 }),
    prisma.tournament.findMany({
      where: { status: { in: ["SCHEDULED", "RUNNING"] } },
      orderBy: { startsAt: "asc" },
      take: 6,
      include: { game: { select: { name: true } }, _count: { select: { entries: true } } },
    }),
  ]);

  return (
    <>
      <PageHeader title="Liveops" subtitle="Create tournaments, post home-screen announcements, and schedule rake-free happy hours." />

      <div className="grid gap-4 lg:grid-cols-3">
        <CreateTournament />
        <PostAnnouncement />
        <ScheduleHappyHour />
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        <Card>
          <div className="border-b border-border px-5 py-3 text-2xs font-semibold uppercase tracking-wide text-muted">
            Upcoming tournaments
          </div>
          <List>
            {upcoming.length === 0 && <p className="px-5 py-6 text-center text-sm text-muted">None scheduled.</p>}
            {upcoming.map((t) => (
              <div key={t.id} className="px-5 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{t.name}</span>
                  <Badge tone={t.status === "RUNNING" ? "gold" : "neutral"}>{t.status.toLowerCase()}</Badge>
                </div>
                <p className="tnum mt-0.5 text-xs text-muted">
                  {t.game.name} · entry {formatTetriCompact(t.entryTetri)} · {t._count.entries}/{t.capacity}
                </p>
              </div>
            ))}
          </List>
        </Card>

        <Card>
          <div className="border-b border-border px-5 py-3 text-2xs font-semibold uppercase tracking-wide text-muted">
            Announcements
          </div>
          <List>
            {announcements.length === 0 && <p className="px-5 py-6 text-center text-sm text-muted">None yet.</p>}
            {announcements.map((a) => (
              <div key={a.id} className="px-5 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium">{a.title}</p>
                  <AnnouncementToggle id={a.id} active={a.active} />
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted">{a.body}</p>
              </div>
            ))}
          </List>
        </Card>

        <Card>
          <div className="border-b border-border px-5 py-3 text-2xs font-semibold uppercase tracking-wide text-muted">
            Happy hours
          </div>
          <List>
            {happyHours.length === 0 && <p className="px-5 py-6 text-center text-sm text-muted">None scheduled.</p>}
            {happyHours.map((h) => (
              <div key={h.id} className="px-5 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{h.name}</span>
                  <Badge tone="mint">−{(h.rakeDiscountBps / 100).toFixed(0)}% rake</Badge>
                </div>
                <p className="tnum mt-0.5 text-xs text-muted">
                  {h.startsAt.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  {" → "}
                  {h.endsAt.toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
            ))}
          </List>
        </Card>
      </div>
    </>
  );
}
