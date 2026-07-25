"use client";

import { useState } from "react";
import Link from "next/link";
import { STAKES_TETRI, formatTetriCompact } from "@gamearena/shared";
import { GameCover } from "@/components/game-cover";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StakeSelector } from "@/components/ui/stake-selector";

/*
 * The Play centerpiece: pick a stake, press the gold button. Blitz and
 * practice are quiet alternatives underneath — one primary action per screen.
 */
export function PlayPanel({
  gameKey,
  gameName,
  tagline,
  durationS,
  disabled,
}: {
  gameKey: string;
  gameName: string;
  tagline: string | null;
  durationS: number;
  disabled: boolean;
}) {
  const [stake, setStake] = useState<number>(STAKES_TETRI[1]!);

  return (
    <Card className="group overflow-hidden">
      <GameCover game={gameKey} live />
      <div className="p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-bold tracking-tight">{gameName}</h2>
            {tagline && <p className="mt-1 text-sm text-muted">{tagline}</p>}
          </div>
          <span className="tnum shrink-0 rounded-full border border-border bg-bg px-3 py-1 text-sm text-muted">
            {durationS}s
          </span>
        </div>

        <StakeSelector
          options={STAKES_TETRI}
          value={stake}
          onChange={setStake}
          disabled={disabled}
          className="mt-6 grid-cols-4"
        />

        <Link
          aria-disabled={disabled}
          href={disabled ? "/lobby" : `/match/${gameKey}?stake=${stake}`}
          className={buttonClasses({
            variant: "primary",
            size: "lg",
            className: `mt-4 h-14 w-full text-md ${disabled ? "pointer-events-none opacity-45" : ""}`,
          })}
        >
          Find {formatTetriCompact(stake)} match
        </Link>

        <div className="mt-3 flex items-center justify-center gap-6 text-sm">
          <Link
            href={disabled ? "/lobby" : `/blitz/${gameKey}`}
            className="text-muted transition-colors duration-150 hover:text-fg"
          >
            Blitz solo
          </Link>
          <span className="text-faint">·</span>
          <Link
            href={disabled ? "/lobby" : `/blitz/${gameKey}`}
            className="text-muted transition-colors duration-150 hover:text-fg"
          >
            Practice free
          </Link>
        </div>
      </div>
    </Card>
  );
}
