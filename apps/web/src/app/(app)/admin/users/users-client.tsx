"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

async function act(body: unknown) {
  await fetch("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function UserSearch({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initialQuery);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        router.push(`/admin/users?q=${encodeURIComponent(q.trim())}`);
      }}
      className="mb-4 flex max-w-sm gap-2"
    >
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by username or email" />
      <Button type="submit" variant="secondary">Search</Button>
    </form>
  );
}

export function UserActions({
  userId,
  suspended,
  payoutHold,
  kyc,
}: {
  userId: string;
  suspended: boolean;
  payoutHold: boolean;
  kyc: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function run(body: Record<string, unknown>) {
    setBusy(true);
    await act({ userId, ...body });
    router.refresh();
    setBusy(false);
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <select
        value={kyc}
        disabled={busy}
        onChange={(e) => run({ action: "setKyc", kyc: e.target.value })}
        className="h-8 rounded-md border border-border bg-bg px-2 text-[12px] text-fg-secondary"
      >
        <option value="NONE">KYC none</option>
        <option value="PENDING">KYC pending</option>
        <option value="VERIFIED">KYC verified</option>
      </select>
      {payoutHold && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => run({ action: "releaseHold" })}>
          Release hold
        </Button>
      )}
      {suspended ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => run({ action: "unsuspend" })}>
          Unsuspend
        </Button>
      ) : (
        <Button size="sm" variant="danger" disabled={busy} onClick={() => run({ action: "suspend" })}>
          Suspend
        </Button>
      )}
    </div>
  );
}
