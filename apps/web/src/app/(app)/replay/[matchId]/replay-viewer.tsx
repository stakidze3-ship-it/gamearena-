"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { BlockBlastInput } from "@gamearena/games";
import { formatTetriCompact } from "@gamearena/shared";
import { PageHeader } from "@/components/app-shell";
import { ReplayBoard, replayTo } from "@/components/games/block-blast-replay";
import { IconChevronDown, IconPlay } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Slider } from "@/components/ui/input";
import { cn } from "@/lib/cn";

interface Player {
  username: string;
  isBot: boolean;
  serverScore: number;
  inputs: BlockBlastInput[];
  won: boolean;
  ratingBefore: number | null;
  ratingAfter: number | null;
}

const SPEEDS = [1, 2, 4] as const;

export function ReplayViewer({
  matchId,
  gameName,
  durationS,
  seed,
  seedHash,
  isDraw,
  stakeTetri,
  players,
}: {
  matchId: string;
  gameName: string;
  durationS: number;
  seed: string;
  seedHash: string;
  isDraw: boolean;
  stakeTetri: number;
  players: Player[];
}) {
  const durationMs = durationS * 1000;
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(2);
  const raf = useRef<number>(0);
  const last = useRef<number>(0);

  useEffect(() => {
    if (!playing) return;
    last.current = performance.now();
    const tick = (now: number) => {
      const dt = (now - last.current) * speed;
      last.current = now;
      setT((prev) => {
        const next = prev + dt;
        if (next >= durationMs) {
          setPlaying(false);
          return durationMs;
        }
        return next;
      });
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, durationMs]);

  function togglePlay() {
    if (t >= durationMs) setT(0);
    setPlaying((p) => !p);
  }

  const secs = Math.floor(t / 1000);

  return (
    <div className="mx-auto max-w-lg space-y-8">
      <PageHeader
        title="Match replay"
        subtitle={`${gameName} · stake ${formatTetriCompact(stakeTetri)}`}
        action={
          <Link href="/profile" className={buttonClasses({ variant: "ghost", size: "sm" })}>
            ← Back
          </Link>
        }
      />

      {/* Boards — the two players side by side, re-simulated at time t */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        {players.map((p, i) => {
          const frame = replayTo(seed, p.inputs, t);
          return (
            <div key={i} className="min-w-0 space-y-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">{p.username}</span>
                {p.isBot && <Badge tone="muted">Bot</Badge>}
                {p.won && !isDraw && <Badge tone="gold">Winner</Badge>}
              </div>
              <p className="tnum font-display text-2xl font-bold">{frame.score}</p>
              <ReplayBoard
                frame={frame}
                className={cn(p.won && !isDraw && "border-gold/30")}
              />
              <div className="flex items-center justify-between text-xs text-muted">
                <span className="tnum">{frame.placed} placed</span>
                {p.ratingBefore != null && p.ratingAfter != null && (
                  <span className="tnum">
                    {Math.round(p.ratingBefore)} →{" "}
                    <span
                      className={
                        p.ratingAfter >= p.ratingBefore ? "text-mint" : "text-coral"
                      }
                    >
                      {Math.round(p.ratingAfter)}
                    </span>
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Transport — one slim control row */}
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          size="icon"
          onClick={togglePlay}
          aria-label={playing ? "Pause" : "Play"}
        >
          {playing ? (
            <span className="text-xs leading-none">▮▮</span>
          ) : (
            <IconPlay className="h-4 w-4" />
          )}
        </Button>
        <Slider
          min={0}
          max={durationMs}
          value={t}
          onChange={(e) => {
            setPlaying(false);
            setT(Number(e.target.value));
          }}
          className="flex-1"
        />
        <span className="tnum w-10 text-right font-mono text-sm text-muted">
          0:{String(secs).padStart(2, "0")}
        </span>
        <div className="flex gap-1">
          {SPEEDS.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={speed === s ? "secondary" : "ghost"}
              onClick={() => setSpeed(s)}
              className="tnum px-2.5"
            >
              {s}×
            </Button>
          ))}
        </div>
      </div>

      {/* Fairness */}
      <details className="group rounded-lg border border-border bg-surface">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-muted transition-colors duration-150 hover:text-fg [&::-webkit-details-marker]:hidden">
          Provably fair
          <IconChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180" />
        </summary>
        <div className="border-t border-border px-4 py-3 text-sm text-muted">
          <p className="leading-relaxed">
            Both boards are re-simulated from the revealed seed{" "}
            <span className="tnum font-mono text-fg-secondary">#{seed}</span> through the same
            engine that scored the match. Its commit, published before play, was{" "}
            <span className="font-mono text-fg-secondary">{seedHash.slice(0, 16)}…</span> —
            recompute <span className="font-mono">sha256(&quot;{seed}&quot;)</span> to verify
            nothing changed.
          </p>
        </div>
      </details>
    </div>
  );
}
