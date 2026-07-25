import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountKeys, getBalanceTetri, prisma } from "@gamearena/db";
import { formatTetri, formatTetriCompact, prizeTetriFor } from "@gamearena/shared";
import { Logo } from "@/components/logo";
import { IconMedal, IconShield } from "@/components/icons";
import { buttonClasses } from "@/components/ui/button";
import { getSession } from "@/lib/session";
import { siteOrigin } from "@/lib/origin";
import { SeatCounter } from "./seat-counter";

/**
 * The public invite page — the link people paste into WhatsApp.
 *
 * No session required: a first-time visitor sees what the event is, what it
 * pays and how many seats are left, and has exactly one thing to do. Signing up
 * returns them straight to the tournament so the journey is unbroken.
 */

async function loadTournament(id: string) {
  const t = await prisma.tournament.findUnique({
    where: { id },
    include: {
      game: { select: { name: true } },
      _count: { select: { entries: true } },
    },
  });
  return t;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const t = await loadTournament(id);
  if (!t) return { title: "Tournament" };

  const seats = t.capacity - t._count.entries;
  const pool = t.entryTetri * t.capacity;
  const title = `${t.name} — win ${formatTetri(prizeTetriFor(1, pool))}`;
  const description =
    `${formatTetriCompact(t.entryTetri)} entry · ${t.capacity} players · ` +
    `${formatTetri(pool)} in prizes. ` +
    (seats > 0 ? `${seats} seats left.` : "Field complete.");

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: `${await siteOrigin()}/t/${id}`,
      siteName: "GameArena",
      images: [{ url: "/games/block-blast-cover.png", width: 1460, height: 556 }],
      type: "website",
    },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function PublicTournamentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [t, session] = await Promise.all([loadTournament(id), getSession()]);
  if (!t) notFound();

  const escrow = await getBalanceTetri(prisma, AccountKeys.tournamentEscrow(id));
  // Before the field fills the escrow is partial, so advertise the full pool a
  // complete field pays — that is what the published prizes are sized from.
  const pool = Math.max(escrow, t.entryTetri * t.capacity, t.guaranteeTetri);
  const structure = t.prizeStructure as { rank: number; shareBps: number }[];
  const podium = ["Champion", "Runner-up", "Third"];
  const joinHref = session ? `/tournaments/${id}` : `/register?next=/tournaments/${id}`;
  const open = t.status === "SCHEDULED";

  return (
    <div className="min-h-dvh">
      <header className="flex h-16 items-center justify-between px-4 md:px-6">
        <Logo href="/" />
        {!session && (
          <Link
            href={`/login?next=/tournaments/${id}`}
            className={buttonClasses({ variant: "ghost", size: "sm" })}
          >
            Log in
          </Link>
        )}
      </header>

      <main className="mx-auto max-w-lg px-4 pb-24 pt-8 text-center md:pt-16">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-gold">
          {t.game.name} · Knockout
        </p>
        <h1 className="mt-4 font-display text-3xl font-extrabold tracking-tight md:text-4xl">
          {t.name}
        </h1>
        <p className="mt-4 text-md text-muted">
          {formatTetriCompact(t.entryTetri)} to enter · {t.capacity} players · one winner
        </p>

        <div className="mt-12">
          <SeatCounter
            tournamentId={id}
            entryCount={t._count.entries}
            capacity={t.capacity}
            status={t.status}
          />
        </div>

        <div className="mt-12">
          <Link
            href={joinHref}
            className={buttonClasses({
              variant: "primary",
              size: "lg",
              className: "h-14 w-full text-md",
            })}
          >
            {open ? `Take a seat · ${formatTetriCompact(t.entryTetri)}` : "View the bracket"}
          </Link>
          {!session && (
            <p className="mt-3 text-sm text-faint">
              New here? Signing up takes a moment and comes with ₾5 in demo credits.
            </p>
          )}
        </div>

        {/* What you're playing for */}
        <div className="mt-16 space-y-3 text-left">
          <p className="text-center text-xs font-medium uppercase tracking-wider text-muted">
            Prizes
          </p>
          {structure.map((s, i) => (
            <div
              key={s.rank}
              className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-3"
            >
              <span className="flex items-center gap-2 text-sm text-fg-secondary">
                <IconMedal
                  className={
                    i === 0 ? "h-4 w-4 text-gold" : i === 1 ? "h-4 w-4 text-fg-secondary" : "h-4 w-4 text-amber"
                  }
                />
                {podium[i] ?? `#${s.rank}`}
              </span>
              <span className="tnum font-display text-md font-bold">
                {formatTetri(prizeTetriFor(s.rank, pool, structure))}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-10 flex items-start gap-3 text-left text-sm text-muted">
          <IconShield className="mt-0.5 h-4 w-4 shrink-0 text-gold" />
          <p>
            Every match is the same 60-second Block Blast board for both players, scored on the
            server. The seed is hash-committed before you play and revealed after —{" "}
            <Link href="/fairness" className="text-fg underline-offset-4 hover:underline">
              check any match yourself
            </Link>
            .
          </p>
        </div>
      </main>
    </div>
  );
}
