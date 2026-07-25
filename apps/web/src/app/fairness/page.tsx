import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { buttonClasses } from "@/components/ui/button";
import { getSession } from "@/lib/session";
import { SeedVerifier } from "./seed-verifier";

export const metadata: Metadata = {
  title: "Fairness",
  description: "How GameArena's provably-fair seed system works — verify it yourself.",
};

const STEPS = [
  {
    n: "01",
    title: "Commit before",
    body: "Before a match starts, the server generates a secret seed and sends both players its SHA-256 hash — a fingerprint it can't change afterward.",
  },
  {
    n: "02",
    title: "Identical boards",
    body: "Both players derive the exact same piece sequence from that seed. Same pieces, same board — the only variable is skill.",
  },
  {
    n: "03",
    title: "Server scores",
    body: "Your device streams raw inputs, never a score. The server replays them through the same deterministic engine and computes both scores itself.",
  },
  {
    n: "04",
    title: "Reveal after",
    body: "The seed is revealed on your result screen. Hash it yourself — if it matches the pre-match commit, nothing was altered. Every match is re-playable from its log.",
  },
];

export default async function FairnessPage() {
  const session = await getSession();

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-2xl items-center justify-between px-4 md:px-6">
          <Logo href="/" />
          <Link
            href={session ? "/lobby" : "/login"}
            className={buttonClasses({ variant: "secondary", size: "sm" })}
          >
            {session ? "Back to app" : "Log in"}
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-2xl space-y-10 px-4 py-14 md:px-6 md:py-20">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-gold">
            Provably fair
          </p>
          <h1 className="mt-3 font-display text-2xl font-bold tracking-tight md:text-3xl">
            Don’t trust us. Verify us.
          </h1>
          <p className="mt-4 text-base leading-relaxed text-muted">
            Every GameArena match is fair by construction — and you can check it yourself in
            seconds, right here in your browser.
          </p>
        </div>

        <section className="space-y-6">
          <h2 className="font-display text-lg font-bold tracking-tight">How it works</h2>
          <ol className="space-y-6">
            {STEPS.map((s) => (
              <li key={s.n} className="flex gap-4">
                <span className="tnum pt-0.5 font-display text-sm font-medium text-gold">
                  {s.n}
                </span>
                <div>
                  <h3 className="text-base font-semibold">{s.title}</h3>
                  <p className="mt-1 text-base leading-relaxed text-muted">{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="space-y-4">
          <div>
            <h2 className="font-display text-lg font-bold tracking-tight">Verify a seed</h2>
            <p className="mt-1 text-base leading-relaxed text-muted">
              Paste the seed from any result screen. Its SHA-256 hash is computed live —
              compare it to the commit shown before that match.
            </p>
          </div>
          <SeedVerifier />
        </section>
      </main>
    </div>
  );
}
