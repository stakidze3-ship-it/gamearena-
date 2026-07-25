import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@gamearena/db";
import { formatTetriCompact, settlePot } from "@gamearena/shared";
import { IconChevronRight } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Stat } from "@/components/ui/chart";
import { List } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Profile" };

export default async function ProfilePage() {
  const user = await requireUser();

  const [ratings, matches, referralCount] = await Promise.all([
    prisma.ratingState.findMany({
      where: { userId: user.id },
      include: { game: { select: { name: true } } },
    }),
    prisma.match.findMany({
      where: { status: "SETTLED", players: { some: { userId: user.id } } },
      orderBy: { settledAt: "desc" },
      take: 15,
      include: {
        players: { include: { user: { select: { username: true } } } },
        game: { select: { name: true } },
      },
    }),
    prisma.user.count({ where: { referredById: user.id } }),
  ]);

  const played = matches.length;
  const won = matches.filter((m) => m.winnerUserId === user.id).length;

  return (
    <div className="mx-auto w-full max-w-xl space-y-10">
      {/* ── Identity ── */}
      <header>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-xl font-bold tracking-tight md:text-2xl">
            {user.username}
          </h1>
          <Badge tone={user.kycStatus === "VERIFIED" ? "mint" : "muted"}>
            KYC {user.kycStatus.toLowerCase()}
          </Badge>
        </div>
        <p className="tnum mt-2 text-sm text-muted">
          {ratings.map((r) => `${r.game.name} ${Math.round(r.rating)} · ${r.wins}W/${r.matchesPlayed}`).join(" · ")}
          {ratings.length > 0 && " · "}
          Member since {user.createdAt.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
        </p>
      </header>

      {/* ── Stats ── */}
      <div className="grid grid-cols-3 gap-4">
        <Stat label="Matches" value={played} sub="recent" />
        <Stat
          label="Wins"
          value={won}
          sub={played > 0 ? `${Math.round((won / played) * 100)}% win rate` : undefined}
        />
        <Stat
          label="Referral code"
          value={user.referralCode}
          tone="gold"
          sub={
            referralCount > 0
              ? `${referralCount} referred · ₾25 vault credits each`
              : "Share it — ₾25 vault credits per signup"
          }
        />
      </div>

      {/* ── Match history ── */}
      <section>
        <h2 className="mb-3 text-base font-semibold tracking-tight">Match history</h2>
        <Card className="overflow-hidden">
          <List>
            {matches.length === 0 && (
              <p className="px-5 py-10 text-center text-sm text-muted">
                No matches yet — your history and replays will live here.
              </p>
            )}
            {matches.map((m) => {
              const me = m.players.find((p) => p.userId === user.id);
              const opp = m.players.find((p) => p.userId !== user.id);
              const iWon = m.winnerUserId === user.id;
              const { payoutTetri } = settlePot(m.potTetri, m.rakeBps);
              const delta = m.isDraw ? 0 : iWon ? payoutTetri - m.stakeTetri : -m.stakeTetri;
              const outcome = m.isDraw ? "Draw" : iWon ? "Won" : "Lost";
              return (
                <Link
                  key={m.id}
                  href={`/replay/${m.id}`}
                  className="flex items-center justify-between gap-4 px-5 py-3 transition-colors duration-150 hover:bg-raised/60"
                >
                  <div className="min-w-0">
                    <p className="text-sm">
                      <span className={iWon ? "font-medium text-fg" : "text-muted"}>{outcome}</span>{" "}
                      <span className="text-muted">vs</span> {opp?.user.username ?? "—"}
                      <span className="tnum ml-2 text-muted">
                        {me?.serverScore} : {opp?.serverScore}
                      </span>
                    </p>
                    <p className="tnum mt-0.5 text-xs text-faint">
                      {m.game.name} · stake {formatTetriCompact(m.stakeTetri)} ·{" "}
                      {m.settledAt?.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                    </p>
                  </div>
                  <span className="flex shrink-0 items-center gap-2">
                    <Money tetri={delta} signed className="text-sm font-semibold" />
                    <IconChevronRight className="h-4 w-4 text-faint" />
                  </span>
                </Link>
              );
            })}
          </List>
        </Card>
      </section>
    </div>
  );
}
