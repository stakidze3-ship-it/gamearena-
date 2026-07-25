"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const SECTIONS = [
  { href: "/admin/metrics", label: "Metrics", ready: true },
  { href: "/admin/review", label: "Review queue", ready: true },
  { href: "/admin/calibration", label: "Blitz calibration", ready: true },
  { href: "/admin/liveops", label: "Liveops", ready: true },
  { href: "/admin/users", label: "Users", ready: true },
  { href: "/admin/flags", label: "Feature flags", ready: true },
];

export function AdminNav() {
  const pathname = usePathname();

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
