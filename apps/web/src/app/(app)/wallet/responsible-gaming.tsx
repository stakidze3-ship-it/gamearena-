"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatTetriCompact } from "@gamearena/shared";
import { Button } from "@/components/ui/button";
import { Hint, Input, Label } from "@/components/ui/input";

export function ResponsibleGaming({
  dailyLimitTetri,
  selfExcludedUntil,
}: {
  dailyLimitTetri: number | null;
  selfExcludedUntil: string | null;
}) {
  const router = useRouter();
  const [limit, setLimit] = useState(dailyLimitTetri ? String(dailyLimitTetri / 100) : "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState<1 | 7 | 30 | null>(null);

  const excluded = selfExcludedUntil && new Date(selfExcludedUntil) > new Date();

  async function saveLimit() {
    setSaving(true);
    setSaved(false);
    await fetch("/api/wallet/limits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dailyDepositLimitLari: limit.trim() === "" ? null : Number(limit),
      }),
    });
    setSaving(false);
    setSaved(true);
    router.refresh();
  }

  async function selfExclude(days: 1 | 7 | 30) {
    await fetch("/api/wallet/self-exclude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days }),
    });
    setConfirming(null);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div>
        <Label htmlFor="daily-limit">Daily deposit limit</Label>
        <div className="flex gap-2">
          <Input
            id="daily-limit"
            type="number"
            min={0}
            placeholder="No limit set"
            value={limit}
            onChange={(e) => {
              setLimit(e.target.value);
              setSaved(false);
            }}
            className="tnum"
          />
          <Button variant="secondary" onClick={saveLimit} disabled={saving}>
            {saved ? "Saved" : "Save"}
          </Button>
        </div>
        <Hint>
          In ₾ per day. Applies the moment real deposits launch
          {dailyLimitTetri ? ` — currently ${formatTetriCompact(dailyLimitTetri)}/day.` : "."}
          {" "}Lowering takes effect immediately; raising takes 24h.
        </Hint>
      </div>

      <div className="border-t border-border pt-5">
        <p className="mb-1.5 text-sm font-medium text-fg-secondary">Self-exclusion</p>
        {excluded ? (
          <p className="text-sm text-muted">
            Active until{" "}
            <span className="text-fg">
              {new Date(selfExcludedUntil!).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "long",
              })}
            </span>
            . Play is disabled; your wallet stays accessible.
          </p>
        ) : confirming ? (
          <div className="rounded-lg border border-coral/40 bg-coral/5 p-4">
            <p className="text-sm">
              Block all play for <span className="font-semibold">{confirming} day{confirming > 1 ? "s" : ""}</span>?
              This cannot be undone early.
            </p>
            <div className="mt-3 flex gap-2">
              <Button variant="danger" size="sm" onClick={() => selfExclude(confirming)}>
                Yes, exclude me
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            {([1, 7, 30] as const).map((d) => (
              <Button key={d} variant="secondary" size="sm" onClick={() => setConfirming(d)}>
                {d} day{d > 1 ? "s" : ""}
              </Button>
            ))}
          </div>
        )}
        {!excluded && (
          <Hint>Locks matchmaking, Blitz and tournaments immediately. Not reversible early.</Hint>
        )}
      </div>
    </div>
  );
}
