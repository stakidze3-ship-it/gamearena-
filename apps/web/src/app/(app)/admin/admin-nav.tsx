"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

/**
 * The specialist screens.
 *
 * Tournament and user tools are gone from this list — they live in the console
 * at /admin now. What remains is the work that genuinely needs its own
 * workspace: a score histogram with an editable payout curve does not belong in
 * a tab, and neither does a review queue you page through.
 */
const SECTIONS = [
  { href: "/admin", label: "← Console", ready: true },
  { href: "/admin/metrics", label: "Metrics", ready: true },
  { href: "/admin/review", label: "Review queue", ready: true },
  { href: "/admin/calibration", label: "Blitz calibration", ready: true },
  { href: "/admin/liveops", label: "Liveops", ready: true },
  { href: "/admin/flags", label: "Feature flags", ready: true },
];

export function AdminNav() {
  const pathname = usePathname();

  // The console renders its own section tabs. Showing this row above them too
  // gave the page two competing navigations.
  if (pathname === "/admin") return null;

  return (
    <nav className="mb-8 overflow-x-auto">
      <div className="flex gap-1 whitespace-nowrap border-b border-border">
        {SECTIONS.map((s) => {
          if (!s.ready) {
            return (
              <span
                key={s.href}
                className="cursor-not-allowed border-b-2 border-transparent px-3 py-2 text-sm text-faint"
                title="Ships in Phase 6"
              >
                {s.label}
              </span>
            );
          }
          const active = pathname === s.href || pathname.startsWith(`${s.href}/`);
          return (
            <Link
              key={s.href}
              href={s.href}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm transition-colors duration-150",
                active
                  ? "border-gold font-medium text-fg"
                  : "border-transparent text-muted hover:text-fg"
              )}
            >
              {s.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
