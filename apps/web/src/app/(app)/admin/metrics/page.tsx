import type { Metadata } from "next";
import { AccountKeys, getBalanceTetri, prisma } from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";
import { PageHeader } from "@/components/app-shell";
import { BarChart, Stat } from "@/components/ui/chart";
import { Card, CardBody } from "@/components/ui/card";

export const metadata: Metadata = { title: "Metrics" };

const DAY = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export default async function MetricsPage() {
  const now = new Date();
  const since14 = new Date(now.getTime() - 14 * DAY);
  const todayStart = startOfDay(now);

  const [matches14, blitzAgg, rake, disputes, todayMatchPlayers, todayBlitz, users] = await Promise.all([
    prisma.match.findMany({
      where: { status: "SETTLED", settledAt: { gte: since14 } },
      select: { settledAt: true, players: { select: { user: { select: { isBot: true } } } } },
    }),
    prisma.blitzRun.aggregate({
      where: { status: "SETTLED" },
      _sum: { entryTetri: true, payoutTetri: true },
      _count: true,
    }),
    getBalanceTetri(prisma, AccountKeys.rake()),
    prisma.reviewCase.count({ where: { status: "OPEN" } }),
    prisma.matchPlayer.findMany({
      where: { match: { settledAt: { gte: todayStart } } },
      select: { userId: true, user: { select: { isBot: true } } },
    }),
    prisma.blitzRun.findMany({
      where: { settledAt: { gte: todayStart } },
      select: { userId: true },
    }),
    prisma.user.findMany({
      where: { isBot: false },
      select: { createdAt: true, lastSeenAt: true },
    }),
  ]);

  // Matches per day (14 buckets)
  const buckets = Array.from({ length: 14 }, (_, i) => {
    const day = startOfDay(new Date(now.getTime() - (13 - i) * DAY));
    return { day, label: day.toLocaleDateString("en-GB", { day: "numeric" }), value: 0 };
  });
  for (const m of matches14) {
    if (!m.settledAt) continue;
    const key = startOfDay(m.settledAt).getTime();
    const b = buckets.find((x) => x.day.getTime() === key);
    if (b) b.value++;
  }

  // DAU (distinct non-bot users active today via a match or blitz run)
  const activeToday = new Set<string>();
  for (const p of todayMatchPlayers) if (!p.user.isBot) activeToday.add(p.userId);
  for (const r of todayBlitz) activeToday.add(r.userId);

  // Human-paired fill proxy: matches with no bot player
  const humanPaired = matches14.filter((m) => m.players.every((p) => !p.user.isBot)).length;
  const fillRate = matches14.length ? Math.round((humanPaired / matches14.length) * 100) : 0;

  // Blitz realized margin vs ~5% target (curve is designed for a small house edge)
  const entries = blitzAgg._sum.entryTetri ?? 0;
  const payouts = blitzAgg._sum.payoutTetri ?? 0;
  const marginPct = entries ? Math.round(((entries - payouts) / entries) * 100) : 0;

  // Retention (login-based, best-effort on demo data)
  const d1 = retention(users, 1, now);
  const d7 = retention(users, 7, now);

  return (
    <>
      <PageHeader title="Metrics" subtitle="Demo analytics · last 14 days. Real money-flow, engagement and integrity signals." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Matches (14d)" value={matches14.length} sub={`${buckets[13]?.value ?? 0} today`} />
        <Stat label="DAU" value={activeToday.size} sub="active today" />
        <Stat label="Fill rate (human-paired)" value={`${fillRate}%`} sub={`${humanPaired} of ${matches14.length}`} tone={fillRate >= 50 ? "gain" : undefined} />
        <Stat label="Rake collected" value={formatTetri(rake)} sub="all-time platform revenue" tone="gold" />
        <Stat
          label="Blitz margin (realized)"
          value={`${marginPct}%`}
          sub={`target ~5% · ${blitzAgg._count} runs`}
          tone={marginPct >= 0 ? "gain" : "loss"}
        />
        <Stat label="Open disputes" value={disputes} sub="anti-cheat review queue" tone={disputes > 0 ? "loss" : "gain"} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardBody>
            <h3 className="mb-4 text-2xs font-semibold uppercase tracking-wide text-muted">Matches per day</h3>
            <BarChart data={buckets.map((b) => ({ label: b.label, value: b.value }))} />
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <h3 className="mb-4 text-2xs font-semibold uppercase tracking-wide text-muted">Retention cohorts</h3>
            <div className="space-y-4">
              <RetentionRow label="D1 retention" pct={d1.pct} n={d1.eligible} />
              <RetentionRow label="D7 retention" pct={d7.pct} n={d7.eligible} />
            </div>
            <p className="mt-4 text-xs leading-relaxed text-faint">
              Share of a signup cohort seen again after N days (login-based). Sparse on demo data —
              wires straight to real activity in production.
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function retention(
  users: { createdAt: Date; lastSeenAt: Date | null }[],
  days: number,
  now: Date
): { pct: number; eligible: number } {
  const eligible = users.filter((u) => now.getTime() - u.createdAt.getTime() >= days * DAY);
  if (eligible.length === 0) return { pct: 0, eligible: 0 };
  const retained = eligible.filter(
    (u) => u.lastSeenAt && u.lastSeenAt.getTime() - u.createdAt.getTime() >= days * DAY
  ).length;
  return { pct: Math.round((retained / eligible.length) * 100), eligible: eligible.length };
}

function RetentionRow({ label, pct, n }: { label: string; pct: number; n: number }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-sm">
        <span className="text-muted">{label}</span>
        <span className="tnum font-semibold">
          {pct}% <span className="text-faint">· {n} cohort</span>
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-bg">
        <div className="h-full rounded-full bg-gold" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
