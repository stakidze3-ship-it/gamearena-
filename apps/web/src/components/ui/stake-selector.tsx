"use client";

import { formatTetriCompact } from "@gamearena/shared";
import { cn } from "@/lib/cn";

/*
 * The one stake/entry picker — match and blitz share it. Selected = the
 * blessed gold tint (gold/6 + gold/60 border); everything else is a quiet
 * inset chip.
 */
export function StakeSelector({
  options,
  value,
  onChange,
  disabled = false,
  className,
}: {
  options: readonly number[];
  value: number;
  onChange: (tetri: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-2", className)}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o)}
          aria-pressed={value === o}
          className={cn(
            "tnum h-10 rounded-lg border text-sm font-semibold",
            "transition-[background-color,border-color,color,transform] duration-150 ease-out",
            "active:scale-[0.97] active:ease-spring disabled:pointer-events-none disabled:opacity-45",
            value === o
              ? "border-gold/60 bg-gold/6 text-gold"
              : "border-border bg-bg text-fg-secondary hover:border-border-strong"
          )}
        >
          {formatTetriCompact(o)}
        </button>
      ))}
    </div>
  );
}
