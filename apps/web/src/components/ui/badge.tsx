import * as React from "react";
import { cn } from "@/lib/cn";

type Tone =
  | "neutral"
  | "gold"
  | "gain"
  | "loss"
  | "muted"
  | "violet"
  | "mint"
  | "amber"
  | "sky"
  | "coral";

const tones: Record<Tone, string> = {
  neutral: "border-border text-fg-secondary",
  gold: "border-gold/35 text-gold",
  gain: "border-gain/35 text-gain",
  loss: "border-loss/35 text-loss",
  muted: "border-border text-muted",
  violet: "border-violet/35 text-violet",
  mint: "border-mint/35 text-mint",
  amber: "border-amber/35 text-amber",
  sky: "border-sky/35 text-sky",
  coral: "border-coral/35 text-coral",
};

export function Badge({
  tone = "neutral",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-2xs font-medium uppercase tracking-wide",
        tones[tone],
        className
      )}
      {...props}
    />
  );
}
