import Link from "next/link";
import { cn } from "@/lib/cn";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("h-5 w-5", className)} aria-hidden>
      {/* Minimal arena mark: gold diamond within a thin ring */}
      <circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
      <rect x="7.75" y="7.75" width="8.5" height="8.5" rx="1.5" transform="rotate(45 12 12)" fill="currentColor" />
    </svg>
  );
}

export function Logo({ href = "/", compact = false }: { href?: string; compact?: boolean }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2.5 text-fg">
      <LogoMark className="text-gold" />
      {!compact && (
        <span className="text-[17px] font-semibold tracking-tight">
          Game<span className="text-gold">Arena</span>
        </span>
      )}
    </Link>
  );
}
