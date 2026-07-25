import * as React from "react";
import { cn } from "@/lib/cn";

type CardVariant = "default" | "inset" | "interactive" | "highlight";

const variants: Record<CardVariant, string> = {
  /* surface card — the standard panel */
  default: "border-border bg-surface shadow-elev-1",
  /* sunken panel inside a card (score panes, previews) */
  inset: "border-border/60 bg-bg",
  /* hover-lifted card (lobby games, vault tiers) */
  interactive:
    "border-border bg-surface shadow-elev-1 transition-[border-color,transform,box-shadow] duration-150 ease-out " +
    "hover:-translate-y-0.5 hover:border-border-strong hover:shadow-elev-2",
  /* "this is you" / selected — the single blessed gold tint */
  highlight: "border-gold/30 bg-gold/6",
};

export function Card({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { variant?: CardVariant }) {
  return (
    <div className={cn("rounded-xl border", variants[variant], className)} {...props} />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center justify-between gap-4 px-5 pt-5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-base font-semibold tracking-tight", className)} {...props} />;
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-5", className)} {...props} />;
}
