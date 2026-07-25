"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatTetri, formatTetriCompact } from "@gamearena/shared";
import { ConfettiBurst } from "@/components/confetti";
import { IconChevronDown, IconX } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";

export interface VaultTierView {
  id: string;
  key: string;
  name: string;
  priceTetri: number;
  prizeTable: { prizeTetri: number; weightBps: number; label: string }[];
}

interface OpenResult {
  prizeIndex: number;
  prizeTetri: number;
  label: string;
  seed: string;
  newVaultTetri: number;
  newCashTetri: number;
}

const ITEM_W = 96; // px per reel card

export function VaultClient({
  tiers,
  vaultTetri,
  cashTetri,
}: {
  tiers: VaultTierView[];
  vaultTetri: number;
  cashTetri: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<VaultTierView | null>(null);
  const [vault, setVault] = useState(vaultTetri);

  return (
    <div className="space-y-10">
      <div>
        <p className="text-sm text-muted">Vault credits</p>
        <p className="mt-1">
          <Money tetri={vault} className="font-display text-3xl font-bold text-gold" />
        </p>
        <p className="mt-2 text-sm text-muted">
          Cash <Money tetri={cashTetri} className="font-semibold text-fg-secondary" /> — prizes pay
          out here
        </p>
      </div>

      {tiers.length === 0 ? (
        <p className="text-sm text-muted">No vaults available right now.</p>
      ) : (
        <div className="space-y-4">
          {tiers.map((tier) => {
            const total = tier.prizeTable.reduce((s, p) => s + p.weightBps, 0);
            const ev = tier.prizeTable.reduce((s, p) => s + (p.prizeTetri * p.weightBps) / total, 0);
            const top = Math.max(...tier.prizeTable.map((p) => p.prizeTetri));
            const affordable = vault >= tier.priceTetri;
            return (
              <Card key={tier.id}>
                <CardBody className="space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <h3 className="font-display text-md font-bold tracking-tight">{tier.name}</h3>
                      <p className="mt-0.5 text-sm text-muted">
                        <span className="tnum">{formatTetriCompact(tier.priceTetri)}</span> credits ·
                        top prize <span className="tnum">{formatTetriCompact(top)}</span>
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      disabled={!affordable}
                      onClick={() => setOpen(tier)}
                    >
                      {affordable ? "Open" : "Not enough credits"}
                    </Button>
                  </div>

                  <details className="group rounded-lg border border-border bg-surface">
                    <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-muted transition-colors duration-150 hover:text-fg [&::-webkit-details-marker]:hidden">
                      Prizes &amp; odds
                      <IconChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180" />
                    </summary>
                    <div className="border-t border-border px-4 py-3 text-sm text-muted">
                      <div className="space-y-1.5">
                        {tier.prizeTable.map((p, i) => (
                          <div key={i} className="flex items-center justify-between">
                            <span className="tnum text-fg-secondary">{p.label}</span>
                            <span className="tnum">
                              {formatTetri(p.prizeTetri)} ·{" "}
                              {((p.weightBps / total) * 100).toFixed(p.weightBps / total < 0.01 ? 2 : 1)}%
                            </span>
                          </div>
                        ))}
                      </div>
                      <p className="tnum mt-3 text-xs text-faint">
                        Expected value {formatTetri(Math.round(ev))} (
                        {Math.round((ev / tier.priceTetri) * 100)}% of price)
                      </p>
                    </div>
                  </details>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      {open && (
        <OpenModal
          tier={open}
          onClose={() => setOpen(null)}
          onSettled={(r) => {
            setVault(r.newVaultTetri);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function OpenModal({
  tier,
  onClose,
  onSettled,
}: {
  tier: VaultTierView;
  onClose: () => void;
  onSettled: (r: OpenResult) => void;
}) {
  const [phase, setPhase] = useState<"ready" | "spinning" | "done" | "error">("ready");
  const [result, setResult] = useState<OpenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reel, setReel] = useState<{ label: string; prizeTetri: number }[]>([]);
  const [offset, setOffset] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);

  async function spin() {
    setPhase("spinning");
    setError(null);
    const res = await fetch("/api/vault/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tierId: tier.id }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Could not open");
      setPhase("error");
      return;
    }
    const r: OpenResult = await res.json();

    // Build a weighted reel that lands on the won prize near the end.
    const pool = tier.prizeTable.flatMap((p) =>
      Array.from({ length: Math.max(1, Math.round(p.weightBps / 300)) }, () => p)
    );
    const filler = Array.from({ length: 44 }, () => pool[Math.floor(Math.random() * pool.length)]!);
    const landing = tier.prizeTable[r.prizeIndex]!;
    const items = [...filler, landing, ...tier.prizeTable.slice(0, 3)];
    const landIndex = filler.length;
    setReel(items.map((p) => ({ label: p.label, prizeTetri: p.prizeTetri })));

    // Kick off the animation on the next frame.
    requestAnimationFrame(() => {
      const center = (trackRef.current?.parentElement?.clientWidth ?? ITEM_W * 3) / 2 - ITEM_W / 2;
      setOffset(-(landIndex * ITEM_W) + center);
    });

    setResult(r);
    window.setTimeout(() => {
      setPhase("done");
      onSettled(r);
    }, 3000);
  }

  const won = result && result.prizeTetri > tier.priceTetri;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-elev-3">
        {phase === "done" && won && <ConfettiBurst count={26} />}

        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-md font-bold tracking-tight">{tier.name}</h3>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
            <IconX className="h-4 w-4" />
          </Button>
        </div>

        {/* Reel window */}
        <div className="relative h-24 overflow-hidden rounded-xl border border-border bg-bg">
          <div className="pointer-events-none absolute left-1/2 top-0 z-10 h-full w-[2px] -translate-x-1/2 bg-gold/70" />
          <div
            ref={trackRef}
            className="absolute top-0 flex h-full items-center motion-safe:transition-transform motion-safe:duration-[3000ms] motion-safe:ease-[cubic-bezier(0.12,0.8,0.2,1)]"
            style={{ transform: `translateX(${offset}px)` }}
          >
            {(reel.length ? reel : tier.prizeTable).map((p, i) => (
              <div
                key={i}
                className="flex shrink-0 flex-col items-center justify-center"
                style={{ width: ITEM_W }}
              >
                <span className="tnum text-lg font-bold text-fg-secondary">{p.label}</span>
                <span className="tnum text-2xs text-muted">{formatTetri(p.prizeTetri)}</span>
              </div>
            ))}
          </div>
        </div>

        {phase === "done" && result && (
          <div className="mt-5 text-center">
            <p className="text-sm text-muted">You won</p>
            <p className={cn("tnum font-display text-3xl font-bold", won ? "text-gain" : "text-fg")}>
              {formatTetri(result.prizeTetri)}
            </p>
            <p className="mt-1 text-xs text-faint">
              {result.label} · seed <span className="font-mono">#{result.seed}</span> · paid to cash
            </p>
          </div>
        )}

        {error && <p className="mt-4 text-center text-sm text-loss">{error}</p>}

        <div className="mt-6 flex gap-2">
          {phase === "ready" && (
            <Button variant="primary" className="flex-1" onClick={spin}>
              Open for {formatTetriCompact(tier.priceTetri)}
            </Button>
          )}
          {phase === "spinning" && (
            <Button variant="primary" className="flex-1" disabled>
              Opening…
            </Button>
          )}
          {(phase === "done" || phase === "error") && (
            <Button variant="secondary" className="flex-1" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
