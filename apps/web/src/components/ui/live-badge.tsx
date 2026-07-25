import { cn } from "@/lib/cn";

/*
 * The one Live/Soon pill — sits on cover art, so it's the app's only
 * white-background element. Dot carries the game accent; text never goes
 * green (green is money-only).
 */
export function LiveBadge({
  live,
  accent = "var(--color-mint)",
  label,
  className,
}: {
  live: boolean;
  accent?: string;
  /** Override the default Live/Soon text (e.g. translated copy). */
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full bg-white/95 px-2 py-1 text-2xs font-bold uppercase tracking-wider text-bg shadow-elev-1",
        className
      )}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: live ? accent : "var(--color-muted)" }}
      />
      {label ?? (live ? "Live" : "Soon")}
    </span>
  );
}
