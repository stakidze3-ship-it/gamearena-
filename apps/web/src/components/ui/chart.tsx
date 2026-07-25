import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/card";

/** Minimal, theme-native charts — inline SVG, no runtime chart lib. */

export function BarChart({
  data,
  height = 140,
  color = "var(--color-gold)",
  format = (v) => String(v),
}: {
  data: { label: string; value: number }[];
  height?: number;
  color?: string;
  format?: (v: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div>
      <div className="flex items-end gap-1.5" style={{ height }}>
        {data.map((d, i) => (
          <div key={i} className="group relative flex flex-1 flex-col items-center justify-end">
            <div
              className="w-full rounded-t transition-[height] duration-300"
              style={{ height: `${(d.value / max) * 100}%`, backgroundColor: color, minHeight: d.value > 0 ? 3 : 0 }}
            />
            <span className="tnum pointer-events-none absolute -top-5 hidden rounded-md bg-overlay px-1.5 py-0.5 text-2xs text-fg shadow-elev-2 group-hover:block">
              {format(d.value)}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {data.map((d, i) => (
          <span key={i} className="flex-1 text-center text-2xs text-faint">
            {d.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "gold" | "gain" | "loss";
}) {
  return (
    <Card className="p-5">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p
        className={cn(
          "tnum mt-1.5 font-display text-xl font-bold tracking-tight",
          tone === "gold" && "text-gold",
          tone === "gain" && "text-gain",
          tone === "loss" && "text-loss"
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </Card>
  );
}
