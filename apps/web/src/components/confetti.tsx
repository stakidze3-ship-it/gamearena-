"use client";

/**
 * Brief confetti burst for WIN moments (settlements, prizes). CSS-only,
 * ~700ms, no deps. Mount it when the win renders; it cleans itself up.
 */
import { useEffect, useState } from "react";

const COLORS = [
  "var(--color-violet)",
  "var(--color-amber)",
  "var(--color-mint)",
  "var(--color-coral)",
  "var(--color-sky)",
  "var(--color-gold)",
];

export function ConfettiBurst({ count = 18 }: { count?: number }) {
  const [pieces, setPieces] = useState<
    { left: number; cx: number; cy: number; cr: number; color: string; delay: number; size: number }[]
  >([]);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setPieces(
      Array.from({ length: count }, (_, i) => ({
        left: 8 + Math.random() * 84,
        cx: (Math.random() - 0.5) * 90,
        cy: 60 + Math.random() * 80,
        cr: (Math.random() - 0.5) * 720,
        color: COLORS[i % COLORS.length]!,
        delay: Math.random() * 120,
        size: 5 + Math.random() * 5,
      }))
    );
    const t = setTimeout(() => setDone(true), 1000);
    return () => clearTimeout(t);
  }, [count]);

  if (done) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {pieces.map((p, i) => (
        <span
          key={i}
          className="ga-confetti absolute top-0 rounded-[2px]"
          style={{
            left: `${p.left}%`,
            width: p.size,
            height: p.size * 0.6,
            backgroundColor: p.color,
            animationDelay: `${p.delay}ms`,
            ["--cx" as string]: `${p.cx}px`,
            ["--cy" as string]: `${p.cy}px`,
            ["--cr" as string]: `${p.cr}deg`,
          }}
        />
      ))}
    </div>
  );
}
