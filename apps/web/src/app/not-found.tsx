import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";

/**
 * 404.
 *
 * Reached more often than it looks: tournament invites are shared into WhatsApp
 * and outlive the event, replays are pruned, and people mistype URLs. Next's
 * default is a bare black-on-white line, which on a money product reads as
 * "this site is broken" rather than "that page is gone".
 */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <p className="font-display text-6xl font-bold tracking-tight text-gold">404</p>
      <h1 className="mt-4 font-display text-2xl font-bold tracking-tight">
        That page isn&apos;t here
      </h1>
      <p className="mt-3 max-w-sm text-sm text-muted">
        The link may be old — tournaments finish and their pages retire. Everything live is one tap
        away.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Link href="/lobby" className={buttonClasses({ variant: "primary" })}>
          Go to Play
        </Link>
        <Link href="/tournaments" className={buttonClasses({ variant: "ghost" })}>
          Tournaments
        </Link>
      </div>
    </div>
  );
}
