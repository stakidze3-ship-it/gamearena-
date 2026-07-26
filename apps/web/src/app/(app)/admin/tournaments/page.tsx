import { prisma } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";
import { BotFillClient, type AdminTournamentRow } from "./bot-fill-client";

/**
 * Admin tournament testing.
 *
 * The whole /admin tree is gated by its layout, and requireAdmin() here plus
 * on the mutation route means this is unreachable — not merely unlisted — for
 * a normal user.
 */
export const dynamic = "force-dynamic";

export default async function AdminTournamentsPage() {
  await requireAdmin();

  const rows = await prisma.tournament.findMany({
    where: { format: "KNOCKOUT" },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true, name: true, status: true, capacity: true, isTest: true, format: true,
      _count: { select: { entries: true } },
    },
  });

  const tournaments: AdminTournamentRow[] = rows.map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    capacity: t.capacity,
    entryCount: t._count.entries,
    isTest: t.isTest,
    format: t.format,
  }));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Tournament testing</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Seat every empty chair with a bot to run a knockout end to end. Bots join through the
          normal registration path, so the escrow, the draw, the bracket and prize settlement are
          all exercised exactly as they are for real players. A filled event is marked{" "}
          <span className="text-amber">Test</span> permanently, and every bot&apos;s balance is
          returned to the treasury once it settles.
        </p>
      </div>
      <BotFillClient tournaments={tournaments} />
    </div>
  );
}
