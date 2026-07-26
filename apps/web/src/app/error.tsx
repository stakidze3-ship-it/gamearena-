"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button, buttonClasses } from "@/components/ui/button";

/**
 * Render-error boundary.
 *
 * Without this, an unhandled error anywhere in the tree shows Next's default
 * screen — in production a bare "Application error: a client-side exception has
 * occurred". On a platform holding someone's balance, that wording invites the
 * worst possible assumption. This says what is and is not affected, and offers
 * a retry, because most of these are transient.
 *
 * The digest is surfaced deliberately: it is the only handle support has to
 * find the matching server log, and it contains no user data.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side errors are already logged; this catches the client ones.
    console.error("[app] unhandled render error", error);
  }, [error]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <h1 className="font-display text-2xl font-bold tracking-tight">Something went wrong</h1>
      <p className="mt-3 max-w-sm text-sm text-muted">
        This screen failed to load. Your account and balance are untouched — nothing was charged.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Link href="/lobby" className={buttonClasses({ variant: "ghost" })}>
          Back to Play
        </Link>
      </div>
      {error.digest && (
        <p className="mt-8 font-mono text-2xs text-faint">Reference {error.digest}</p>
      )}
    </div>
  );
}
