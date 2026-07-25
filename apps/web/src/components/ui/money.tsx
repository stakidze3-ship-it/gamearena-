import { formatSignedTetri, formatTetri, formatTetriCompact } from "@gamearena/shared";
import { cn } from "@/lib/cn";

/**
 * Money is ALWAYS tabular. Signed variant colors: green in, red out, and
 * carries an explicit +/− sign. Unsigned variant is neutral (balances, stakes).
 */
export function Money({
  tetri,
  signed = false,
  compact = false,
  className,
}: {
  tetri: number;
  signed?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const text = signed
    ? formatSignedTetri(tetri)
    : compact
      ? formatTetriCompact(tetri)
      : formatTetri(tetri);
  return (
    <span
      className={cn(
        "tnum",
        signed && tetri > 0 && "text-gain",
        signed && tetri < 0 && "text-loss",
        signed && tetri === 0 && "text-muted",
        className
      )}
    >
      {text}
    </span>
  );
}
