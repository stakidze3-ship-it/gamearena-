import { prisma } from "@gamearena/db";
import { adminClaimEligibility } from "@/lib/admin-claim";
import { requireUser } from "@/lib/auth";
import { TestingConsole, type TestTournamentRow } from "./testing-console";

/**
 * Tournament testing.
 *
 * Deliberately NOT under /admin. The admin tree redirects anyone without the
 * role, which is exactly what made this unreachable on a deployment that has
 * no admin yet — you could not get in to grant yourself the thing that lets
 * you in. This page is reachable by any signed-in user and decides what to
 * show once it knows who you are: the one-click claim if you qualify, the full
 * console if you already have the tools, and an explanation if neither.
 */
export const dynamic = "force-dynamic";

export default async function TestingPage() {
  const user = await requireUser();
  const eligibility = await adminClaimEligibility(user);
  const isAdmin = user.role === "ADMIN";

  const rows = isAdmin
    ? await prisma.tournament.findMany({
        where: { format: "KNOCKOUT" },
        orderBy: { createdAt: "desc" },
        take: 15,
        select: {
          id: true, name: true, status: true, capacity: true, isTest: true,
          _count: { select: { entries: true } },
        },
      })
    : [];

  const tournaments: TestTournamentRow[] = rows.map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status,
    capacity: t.capacity,
    entryCount: t._count.entries,
    isTest: t.isTest,
  }));

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-2">
      <div>
        <h1 className="text-2xl font-semibold">Tournaments &amp; testing</h1>
        <p className="mt-1.5 text-sm text-muted">
          Run a full knockout end to end without waiting for real players. Everything here happens
          through the same registration, draw, bracket and settlement paths a real event uses.
        </p>
      </div>

      <TestingConsole
        isAdmin={isAdmin}
        eligible={eligibility.eligible}
        reason={eligibility.reason}
        tournaments={tournaments}
      />
    </div>
  );
}
