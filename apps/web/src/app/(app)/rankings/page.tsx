import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@gamearena/db";
import { PageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list-row";
import { requireUser } from "@/lib/auth";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Rankings" };

type Tab = "global" | "season" | "friends";
const TABS: { key: Tab; label: string }[] = [
  { key: "global", label: "Global" },
  { key: "season", label: "This week" },
  { key: "friends", label: "Friends" },
];

function mondayUTC(): Date {
  const now = new Date();
  const diff = (now.getUTCDay() + 6) % 7; // days since Monday
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
}

export default async function RankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const me = await requireUser();
  const tab = ((await searchParams).tab as Tab) ?? "global";

  const game = await prisma.game.findUnique({ where: { key: "block-blast" } });
  const rows = await buildRows(tab, me.id, game?.id ?? "");

  return (
    <div className="mx-auto w-full max-w-xl">
      <PageHeader title="Rankings" subtitle="Block Blast · Glicko-2" />

      <div className="mb-8 flex gap-6 border-b border-border">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/rankings?tab=${t.key}`}
            className={cn(
              "-mb-px border-b-2 pb-2.5 text-sm transition-colors duration-150",
              tab === t.key
                ? "border-gold font-medium text-fg"
                : "border-transparent text-muted hover:text-fg"
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "season" && (
        <p className="mb-4 text-xs text-muted">Wins since Monday · resets weekly.</p>
      )}

      <Card>
        <List>
          {rows.length === 0 && (
            <p className="px-5 py-10 text-center text-sm text-muted">
              {tab === "friends"
                ? "No ranked friends yet — add some on the Friends page."
                : "No ranked players yet."}
            </p>
          )}
          {rows.map((r, i) => (
            <ListRow key={r.id} highlight={r.isMe}>
              <span
                className={cn(
                  "tnum w-7 shrink-0 text-right font-display text-sm",
                  i < 3 ? "font-bold text-gold" : "text-muted"
                )}
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {r.username}
                  {r.isBot && <Badge tone="muted" className="ml-2">Bot</Badge>}
                  {r.isMe && <span className="ml-2 text-xs text-gold">you</span>}
                </p>
                {r.sub && <p className="text-xs text-faint">{r.sub}</p>}
              </div>
              <span className="tnum shrink-0 font-display text-base font-semibold">{r.metric}</span>
            </ListRow>
          ))}
        </List>
      </Card>
    </div>
  );
}

interface Row {
  id: string;
  username: string;
  isBot: boolean;
  isMe: boolean;
  metric: string;
  sub?: string;
}

async function buildRows(tab: Tab, meId: string, gameId: string): Promise<Row[]> {
  if (tab === "season") {
    const grouped = await prisma.match.groupBy({
      by: ["winnerUserId"],
      where: { status: "SETTLED", settledAt: { gte: mondayUTC() }, winnerUserId: { not: null } },
      _count: { winnerUserId: true },
    });
    const ids = grouped.map((g) => g.winnerUserId!).filter(Boolean);
    const users = await prisma.user.findMany({
      where: { id: { in: ids }, isBot: false },
      select: { id: true, username: true, isBot: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return grouped
      .filter((g) => byId.has(g.winnerUserId!))
      .map((g) => ({
        id: g.winnerUserId!,
        username: byId.get(g.winnerUserId!)!.username,
        isBot: false,
        isMe: g.winnerUserId === meId,
        metric: `${g._count.winnerUserId} W`,
      }))
      .sort((a, b) => Number(b.metric.split(" ")[0]) - Number(a.metric.split(" ")[0]))
      .slice(0, 20);
  }

  if (tab === "friends") {
    const [out, inc] = await Promise.all([
      prisma.friendship.findMany({ where: { userId: meId, status: "ACCEPTED" }, select: { friendId: true } }),
      prisma.friendship.findMany({ where: { friendId: meId, status: "ACCEPTED" }, select: { userId: true } }),
    ]);
    const ids = [meId, ...out.map((f) => f.friendId), ...inc.map((f) => f.userId)];
    const ratings = await prisma.ratingState.findMany({
      where: { gameId, userId: { in: ids } },
      orderBy: { rating: "desc" },
      include: { user: { select: { username: true, isBot: true } } },
    });
    return ratings.map((r) => ({
      id: r.userId,
      username: r.user.username,
      isBot: r.user.isBot,
      isMe: r.userId === meId,
      metric: String(Math.round(r.rating)),
      sub: `${r.matchesPlayed} ${r.matchesPlayed === 1 ? "match" : "matches"} · ${r.wins} ${r.wins === 1 ? "win" : "wins"}`,
    }));
  }

  // global
  const ratings = await prisma.ratingState.findMany({
    where: { gameId },
    orderBy: { rating: "desc" },
    take: 20,
    include: { user: { select: { username: true, isBot: true } } },
  });
  return ratings.map((r) => ({
    id: r.userId,
    username: r.user.username,
    isBot: r.user.isBot,
    isMe: r.userId === meId,
    metric: String(Math.round(r.rating)),
    sub: `${r.matchesPlayed} ${r.matchesPlayed === 1 ? "match" : "matches"} · ${r.wins} ${r.wins === 1 ? "win" : "wins"}`,
  }));
}
