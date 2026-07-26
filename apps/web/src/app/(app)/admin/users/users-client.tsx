"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

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
  username,
  suspended,
  payoutHold,
  kyc,
}: {
  userId: string;
  username: string;
  suspended: boolean;
  payoutHold: boolean;
  kyc: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [amount, setAmount] = useState("5");
  const [reason, setReason] = useState("Blitz entry reimbursement");
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);

  async function refund() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/admin/wallet-credit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          identifier: username,
          amountLari: Number(amount),
          reason,
          // Same person + same reason + same day = the same refund. Retrying
          // is safe; a genuinely separate refund needs a different reason.
          reference: `${reason}|${new Date().toISOString().slice(0, 10)}`,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNote({ text: (data.error as string) ?? "Refund failed", ok: false });
        return;
      }
      const money = (t: number) => `₾${(t / 100).toFixed(2)}`;
      setNote({
        text: data.alreadyRefunded
          ? `Already refunded — balance unchanged at ${money(data.balanceAfterTetri as number)}.`
          : `Credited ${money(data.amountTetri as number)} · ${money(data.balanceBeforeTetri as number)} → ${money(data.balanceAfterTetri as number)}`,
        ok: true,
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function run(body: Record<string, unknown>) {
    setBusy(true);
    await act({ userId, ...body });
    router.refresh();
    setBusy(false);
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-1.5">
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRefundOpen((o) => !o)}>
        Refund
      </Button>
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

      {refundOpen && (
        <div className="flex flex-wrap items-end justify-end gap-2 rounded-lg border border-border bg-bg px-3 py-2">
          <label className="text-2xs text-muted">
            Amount ₾
            <Input
              value={amount}
              inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 h-8 w-20 text-sm"
            />
          </label>
          <label className="text-2xs text-muted">
            Reason
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 h-8 w-56 text-sm"
            />
          </label>
          <Button size="sm" variant="primary" disabled={busy || !amount || !reason} onClick={refund}>
            {busy ? "Crediting…" : `Credit ₾${amount || "0"}`}
          </Button>
        </div>
      )}
      {note && (
        <p className={cn("text-2xs", note.ok ? "text-gain" : "text-loss")}>{note.text}</p>
      )}
    </div>
  );
}
