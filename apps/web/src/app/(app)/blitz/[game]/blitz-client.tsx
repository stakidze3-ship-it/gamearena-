"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BLITZ_ENTRIES_TETRI,
  blitzPayoutTetri,
  formatTetri,
  formatTetriCompact,
  type CurvePoint,
} from "@gamearena/shared";
import { BlockBlastBoard, type BlockBlastResult } from "@/components/games/block-blast-board";
import { ConfettiBurst } from "@/components/confetti";
import { IconChevronDown, IconChevronLeft } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Money } from "@/components/ui/money";
import { StakeSelector } from "@/components/ui/stake-selector";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";

interface Config {
  breakEvenScore: number;
  zeroScore: number;
  maxMultBps: number;
  curve: CurvePoint[];
}

type Phase = "idle" | "starting" | "playing" | "submitting" | "result";

interface RunInfo {
  runId: string;
  seed: string;
  entryTetri: number;
  practice: boolean;
}

interface Settlement {
  serverScore: number;
  multBps: number;
  payoutTetri: number;
  entryTetri: number;
  seed: string;
  practice: boolean;
}

export function BlitzClient({
  gameKey,
  gameName,
  enabled,
  durationS,
  config,
  balanceTetri,
  excluded,
}: {
  gameKey: string;
  gameName: string;
  enabled: boolean;
  durationS: number;
  config: Config;
  balanceTetri: number;
  excluded: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [entry, setEntry] = useState<number>(BLITZ_ENTRIES_TETRI[1]!);
  const [run, setRun] = useState<RunInfo | null>(null);
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gameKeyRef = useRef(0); // remounts the board for each fresh run

  const canPlay = enabled && !excluded && gameKey === "block-blast";

  async function startPaid() {
    setError(null);
    setPhase("starting");
    const res = await fetch("/api/blitz/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameKey, entryTetri: entry }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Could not start run");
      setPhase("idle");
      return;
    }
    const data = await res.json();
    gameKeyRef.current++;
    setRun({ runId: data.runId, seed: data.seed, entryTetri: entry, practice: false });
    setPhase("playing");
  }

  function startPractice() {
    setError(null);
    const seed = String(100000 + Math.floor(Math.random() * 900000));
    gameKeyRef.current++;
    setRun({ runId: "practice", seed, entryTetri: 0, practice: true });
    setPhase("playing");
  }

  async function handleEnd(result: BlockBlastResult) {
    if (!run) return;

    if (run.practice) {
      const { multBps, payoutTetri } = blitzPayoutTetri(
        entry,
        config.curve,
        result.clientScore,
        config.maxMultBps
      );
      setSettlement({
        serverScore: result.clientScore,
        multBps,
        payoutTetri,
        entryTetri: entry,
        seed: run.seed,
        practice: true,
      });
      setPhase("result");
      return;
    }

    setPhase("submitting");
    const res = await fetch("/api/blitz/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: run.runId, inputs: result.inputs }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Could not score run");
      setPhase("idle");
      return;
    }
    const data = await res.json();
    setSettlement({
      serverScore: data.serverScore,
      multBps: data.multBps,
      payoutTetri: data.payoutTetri,
      entryTetri: data.entryTetri,
      seed: data.seed,
      practice: false,
    });
    setPhase("result");
    router.refresh(); // refresh the shell wallet balance
  }

  function reset() {
    setSettlement(null);
    setRun(null);
    setPhase("idle");
  }

  // ── Playing ──
  if (phase === "playing" && run) {
    return (
      <div className="mx-auto max-w-lg">
        <div className="mb-4 flex items-center justify-between">
          <Badge tone={run.practice ? "sky" : "gold"}>
            {run.practice ? "Practice · free" : `Blitz · ${formatTetriCompact(run.entryTetri)} entry`}
          </Badge>
          <span className="text-sm text-muted">{gameName}</span>
        </div>
        <BlockBlastBoard
          key={gameKeyRef.current}
          seed={run.seed}
          durationS={durationS}
          onEnd={handleEnd}
        />
      </div>
    );
  }

  // ── Submitting ──
  if (phase === "submitting") {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-gold" />
        <p className="text-sm text-muted">Server is replaying your inputs…</p>
      </div>
    );
  }

  // ── Result ──
  if (phase === "result" && settlement) {
    const net = settlement.payoutTetri - settlement.entryTetri;
    const won = settlement.payoutTetri > settlement.entryTetri;
    const mult = (settlement.multBps / 10000).toFixed(2);
    return (
      <div className="relative mx-auto max-w-lg overflow-hidden py-8 text-center">
        {won && !settlement.practice && <ConfettiBurst />}

        <p className="text-xs font-medium uppercase tracking-wider text-muted">
          {gameName} · {settlement.practice ? "Practice score" : "Server-verified score"}
        </p>
        <p className="tnum mt-3 font-display text-5xl font-bold tracking-tight">
          {settlement.serverScore}
        </p>
        <p className="tnum mt-2 text-sm text-muted">
          {mult}× multiplier · break-even {config.breakEvenScore}
        </p>

        {!settlement.practice && (
          <div className="mt-10">
            <p className="text-xs font-medium uppercase tracking-wider text-muted">Net</p>
            <p className="mt-1">
              <Money tetri={net} signed className="font-display text-2xl font-bold tracking-tight" />
            </p>
            <p className="tnum mt-2 text-sm text-muted">
              Entry <Money tetri={-settlement.entryTetri} signed /> · payout{" "}
              <Money tetri={settlement.payoutTetri} signed />
            </p>
          </div>
        )}

        {settlement.practice && (
          <p className="mx-auto mt-10 max-w-xs text-sm text-fg-secondary">
            Practice is free — no credits staked. At {formatTetriCompact(entry)} entry this run
            would have paid <Money tetri={settlement.payoutTetri} className="font-semibold" />.
          </p>
        )}

        <p className="tnum mt-10 font-mono text-xs text-faint">
          Seed #{settlement.seed} (revealed)
        </p>

        <div className="mx-auto mt-8 flex max-w-xs flex-col gap-2">
          {canPlay && (
            <Button variant="primary" size="lg" onClick={reset}>
              Play again
            </Button>
          )}
          <Link href="/blitz" className={buttonClasses({ variant: "ghost" })}>
            Back to Blitz
          </Link>
        </div>
      </div>
    );
  }

  // ── Idle: choose entry ──
  const rows = payoutRows(config, entry);
  return (
    <div className="mx-auto max-w-lg space-y-8">
      <Link
        href="/blitz"
        className="inline-flex items-center gap-1 text-sm text-muted transition-colors duration-150 hover:text-fg"
      >
        <IconChevronLeft className="h-4 w-4" />
        All Blitz
      </Link>

      <div className="text-center">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">
          {gameName} · Blitz
        </p>
        <h1 className="mt-2 font-display text-xl font-bold tracking-tight md:text-2xl">
          Choose your entry
        </h1>
        <p className="tnum mt-2 text-sm text-muted">
          {durationS}s solo run · beat {config.breakEvenScore} to profit
        </p>
      </div>

      {excluded && (
        <p className="rounded-lg border border-coral/40 bg-surface px-4 py-3 text-center text-sm text-muted">
          <span className="font-medium text-coral">Self-exclusion active</span> — play is disabled.
        </p>
      )}

      <div className="space-y-3">
        <StakeSelector
          options={BLITZ_ENTRIES_TETRI}
          value={entry}
          onChange={setEntry}
          className="grid-cols-3"
        />

        {error && <p className="text-center text-sm text-coral">{error}</p>}

        <Button
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!canPlay || balanceTetri < entry}
          loading={phase === "starting"}
          onClick={startPaid}
        >
          {balanceTetri < entry ? "Not enough credits" : `Play ${formatTetriCompact(entry)} run`}
        </Button>
        <Button variant="ghost" className="w-full" disabled={!canPlay} onClick={startPractice}>
          Practice free first
        </Button>
        <p className="text-center text-xs text-faint">
          Balance <Money tetri={balanceTetri} />
        </p>
      </div>

      <details className="group rounded-lg border border-border bg-surface">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-muted transition-colors duration-150 hover:text-fg [&::-webkit-details-marker]:hidden">
          See the exact payout curve
          <IconChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180" />
        </summary>
        <div className="border-t border-border px-4 py-3 text-sm text-muted">
          <Table>
            <THead>
              <tr className="border-b border-border">
                <Th>Score</Th>
                <Th>Multiplier</Th>
                <Th className="text-right">{formatTetriCompact(entry)} pays</Th>
              </tr>
            </THead>
            <TBody className="tnum">
              {rows.map((row, i) => (
                <Tr key={i} highlight={row.highlight}>
                  <Td className="text-fg">{row.label}</Td>
                  <Td>{row.mult}</Td>
                  <Td className="text-right font-medium text-fg">
                    {row.payoutTetri > 0 ? formatTetri(row.payoutTetri) : "—"}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <p className="mt-2 text-xs leading-relaxed text-faint">
            Payouts scale linearly between points, cap at {(config.maxMultBps / 10000).toFixed(1)}×
            and round down to the tetri. This is the live server config — the exact curve your run
            settles on. Runs last {durationS}s with one hand of three pieces at a time.
          </p>
        </div>
      </details>
    </div>
  );
}

function payoutRows(config: Config, entry: number) {
  const points = [
    { label: `< ${config.zeroScore}`, score: config.zeroScore - 1 },
    { score: config.zeroScore },
    { score: Math.round((config.zeroScore + config.breakEvenScore) / 2) },
    { score: config.breakEvenScore, highlight: true },
    { score: 1000 },
    { score: 1200 },
    { score: 1400 },
    { score: 1600 },
  ];
  return points.map((p) => {
    const { multBps, payoutTetri } = blitzPayoutTetri(entry, config.curve, p.score, config.maxMultBps);
    return {
      label: "label" in p && p.label ? p.label : String(p.score),
      mult: `${(multBps / 10000).toFixed(2)}×`,
      payoutTetri,
      highlight: "highlight" in p && p.highlight,
    };
  });
}
