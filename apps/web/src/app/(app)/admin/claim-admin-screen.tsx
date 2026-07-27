"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/**
 * What an owner sees at /admin before they hold the role.
 *
 * The top bar offers Admin to anyone eligible to become one, not just to
 * existing admins — deliberately, because the first owner has to find it before
 * they have the role. The route then refused them and redirected to /lobby,
 * so the tab looked broken rather than gated.
 *
 * This is the missing half. The click now lands somewhere that explains the
 * situation and offers the single action that resolves it, so the navigation
 * item is never dead.
 */
export function ClaimAdminScreen({
  username,
  adminCount,
}: {
  username: string;
  adminCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/claim", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Could not grant the admin tools.");
        return;
      }
      // The role is on the session's user record, so the whole shell has to
      // re-render for the console — and the top bar — to reflect it.
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-border bg-surface px-6 py-8 text-center">
      <h1 className="font-display text-2xl font-bold tracking-tight">Admin console</h1>
      <p className="mt-3 text-sm text-muted">
        <span className="text-fg">{username}</span> is on the owner list for this deployment but
        does not hold the admin role yet, so the console is not open.
        {adminCount > 0 && (
          <>
            {" "}
            There {adminCount === 1 ? "is" : "are"} already {adminCount} admin
            {adminCount === 1 ? "" : "s"} — granting yourself the tools does not remove theirs.
          </>
        )}
      </p>

      <Button variant="primary" size="lg" className="mt-6" loading={busy} onClick={claim}>
        Grant me the admin tools
      </Button>

      {error && (
        <p className="mt-4 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      <p className="mt-6 text-xs text-faint">
        Eligibility is decided server-side by the owner list, not by this screen — hiding or
        showing a button is never the permission model.
      </p>
    </div>
  );
}
