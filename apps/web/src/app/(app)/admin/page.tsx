import type { Metadata } from "next";
import { prisma } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";
import { AdminConsole } from "./admin-console";
import type { AdminTournamentRow } from "./sections/tournaments-section";

export const metadata: Metadata = { title: "Admin console" };
export const dynamic = "force-dynamic";

/**
 * The console's entry point.
 *
 * This used to redirect to the review queue, which made the review queue the de
 * facto admin home and left the tournament tools somewhere else entirely. The
 * console is the home now.
 *
 * The tournament list is loaded here rather than fetched by the client, because
 * it is the first thing an operator looks at and a spinner on arrival is a bad
 * trade for one round trip. The other three sections load on demand — their
 * data is either large (users) or short-lived (matches, health), and fetching
 * it up front would be stale by the time anyone switched tabs.
 */
export default async function AdminPage() {
  const admin = await requireAdmin();

  const tournaments = await prisma.tournament.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 25,
    select: {
      id: true,
      name: true,
      status: true,
      format: true,
      capacity: true,
      entryTetri: true,
      guaranteeTetri: true,
      isTest: true,
      botFilledAt: true,
      botsSeated: true,
      entries: {
        select: { userId: true, user: { select: { username: true, isBot: true } } },
      },
    },
  });

  const rows: AdminTournamentRow[] = tournaments.map((t) => {
    const players = t.entries.map((e) => ({
      userId: e.userId,
      username: e.user.username,
      isBot: e.user.isBot,
    }));
    return {
      id: t.id,
      name: t.name,
      status: t.status,
      format: t.format,
      capacity: t.capacity,
      entryCount: players.length,
      botCount: players.filter((p) => p.isBot).length,
      entryTetri: t.entryTetri,
      // What a full field pays, which is what the event advertises.
      poolTetri: Math.max(t.entryTetri * t.capacity, t.guaranteeTetri),
      isTest: t.isTest,
      botFilledAt: t.botFilledAt ? t.botFilledAt.toISOString() : null,
      botsSeated: t.botsSeated,
      players,
    };
  });

  return <AdminConsole tournaments={rows} operator={admin.username} />;
}
