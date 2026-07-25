import type { Metadata } from "next";
import { prisma } from "@gamearena/db";
import { formatTetriCompact } from "@gamearena/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { requireUser } from "@/lib/auth";
import { PlayPanel } from "./play-panel";

export const metadata: Metadata = { title: "Play" };

function timeAgo(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default async function LobbyPage() {
  const user = await requireUser();

  const [games, announcement, recent] = await Promise.all([
    prisma.game.findMany({ orderBy: { name: "asc" } }),
    prisma.announcement.findFirst({
      where: { active: true, startsAt: { lte: new Date() } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.match.findMany({
      where: { status: "SETTLED" },
      orderBy: { settledAt: "desc" },
      take: 5,
      include: {
        players: { include: { user: { select: { username: true, isBot: true } } } },
        winner: { select: { username: true } },
        game: { select: { name: true } },
      },
    }),
  ]);

  const excluded = !!(user.selfExcludedUntil && user.selfExcludedUntil > new Date());
  const live = games.filter((g) => g.enabled);
  const soon = games.filter((g) => !g.enabled);

  return (
    <div className="mx-auto max-w-xl">
      {excluded && (
        <Card className="mb-6 border-loss/40">
          <CardBody className="text-sm">
            <span className="font-medium text-loss">Self-exclusion active</span>{" "}
            <span className="text-muted">
              until {user.selfExcludedUntil!.toLocaleDateString()} — play is disabled. Your wallet
              stays accessible.
            </span>
          </CardBody>
        </Card>
      )}

      {announcement && !excluded && (
        <div className="mb-6 flex items-start gap-3 rounded-lg bg-gold/6 px-4 py-3">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gold" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{announcement.title}</p>
            <p className="mt-0.5 text-sm text-muted">{announcement.body}</p>
          </div>
        </div>
      )}

      {/* ── The one thing this screen is for ── */}
      <div className="space-y-6">
        {live.map((game) => (
          <PlayPanel
            key={game.id}
            gameKey={game.key}
            gameName={game.name}
            tagline={game.tagline}
            durationS={game.durationS}
            disabled={excluded}
          />
        ))}
      </div>

      {soon.length > 0 && (
        <p className="mt-4 text-center text-sm text-faint">
          Coming soon: {soon.map((g) => g.name).join(" · ")}
        </p>
      )}

      {/* ── Quiet proof of life ── */}
      <div className="mb-3 mt-14 flex items-center gap-2.5">
        <h2 className="text-2xs font-medium uppercase tracking-wide text-muted">
          Recent settlements
        </h2>
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint opacity-50" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-mint" />
        </span>
      </div>
      <Card>
        <List>
          {recent.length === 0 && (
            <p className="px-5 py-8 text-center text-sm text-muted">
              No matches settled yet — be the first on the board.
            </p>
          )}
          {recent.map((m) => {
            const [p1, p2] = m.players;
            const winner = m.winner?.username;
            return (
              <ListRow key={m.id} className="gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    <span className={winner === p1?.user.username ? "text-fg" : "text-muted"}>
                      {p1?.user.username}
                      {p1?.user.isBot && <Badge tone="muted" className="ml-1.5">Bot</Badge>}
                    </span>
                    <span className="tnum mx-2 text-muted">
                      {p1?.serverScore} : {p2?.serverScore}
                    </span>
                    <span className={winner === p2?.user.username ? "text-fg" : "text-muted"}>
                      {p2?.user.username}
                      {p2?.user.isBot && <Badge tone="muted" className="ml-1.5">Bot</Badge>}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-faint">
                    {m.game.name} · stake {formatTetriCompact(m.stakeTetri)} ·{" "}
                    {m.settledAt ? timeAgo(m.settledAt) : ""}
                  </p>
                </div>
                <Money
                  tetri={Math.round((m.potTetri * (10000 - m.rakeBps)) / 10000)}
                  signed
                  className="shrink-0 text-sm font-medium"
                />
              </ListRow>
            );
          })}
        </List>
      </Card>
    </div>
  );
}
