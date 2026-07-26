"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Logo } from "@/components/logo";
import {
  IconBolt,
  IconChart,
  IconLogout,
  IconPlay,
  IconShield,
  IconTrophy,
  IconUser,
  IconUsers,
  IconVault,
  IconWallet,
} from "@/components/icons";
import { Money } from "@/components/ui/money";
import { cn } from "@/lib/cn";

/*
 * Shell v2 — one slim top bar, four primary destinations, everything else in
 * the profile menu. No sidebar: the content is the interface.
 */

interface NavItem {
  href: string;
  label: string;
  icon: (p: React.SVGProps<SVGSVGElement>) => React.ReactNode;
}

const PRIMARY: NavItem[] = [
  { href: "/lobby", label: "Play", icon: IconPlay },
  { href: "/tournaments", label: "Tournaments", icon: IconTrophy },
  { href: "/rankings", label: "Rankings", icon: IconChart },
  { href: "/wallet", label: "Wallet", icon: IconWallet },
];

const MENU: NavItem[] = [
  { href: "/profile", label: "Profile", icon: IconUser },
  { href: "/friends", label: "Friends", icon: IconUsers },
  { href: "/vault", label: "Vault", icon: IconVault },
  { href: "/blitz", label: "Blitz", icon: IconBolt },
  { href: "/fairness", label: "Fairness", icon: IconShield },
];

export function AppShell({
  username,
  isAdmin,
  canClaimAdmin = false,
  balanceTetri,
  children,
}: {
  username: string;
  isAdmin: boolean;
  /** Not an admin yet, but allowed to enable the tools. */
  canClaimAdmin?: boolean;
  balanceTetri: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the menu on outside click and on navigation.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [menuOpen]);
  useEffect(() => setMenuOpen(false), [pathname]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const menuItems = isAdmin
    ? [...MENU, { href: "/admin", label: "Admin", icon: IconShield }]
    : MENU;

  // Tournament testing sits in the TOP BAR, not buried in the profile menu —
  // an operator should not have to go hunting for it. Shown to admins and to
  // anyone eligible to become one, since the first owner needs to find it
  // before they have the role. Ordinary players never see it.
  const primary = isAdmin || canClaimAdmin
    ? [...PRIMARY, { href: "/testing", label: "Testing", icon: IconShield }]
    : PRIMARY;

  return (
    <div className="min-h-dvh">
      {/* ── Top bar ── */}
      <header className="sticky top-0 z-40 border-b border-white/5 bg-bg/85 shadow-elev-2 backdrop-blur-md backdrop-saturate-150">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 md:px-6">
          <div className="flex items-center gap-8">
            <Logo href="/lobby" />
            <nav className="hidden items-center gap-1 md:flex">
              {primary.map((item) => {
                const active = pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "rounded-lg px-3 py-2 text-sm transition-colors duration-150",
                      active
                        ? "bg-surface font-medium text-fg"
                        : "text-muted hover:bg-surface/60 hover:text-fg"
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/wallet"
              className="tnum flex items-center rounded-full border border-border bg-surface px-4 py-1.5 text-sm font-semibold transition-colors duration-150 hover:border-border-strong"
            >
              <Money tetri={balanceTetri} />
            </Link>

            {/* Profile menu */}
            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setMenuOpen((o) => !o)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-full border transition-colors duration-150",
                  menuOpen
                    ? "border-gold/60 text-fg"
                    : "border-border bg-surface text-muted hover:border-border-strong hover:text-fg"
                )}
                title={username}
              >
                <IconUser className="h-5 w-5" />
              </button>

              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-50 mt-2 w-56 rounded-lg border border-border bg-overlay p-1 shadow-elev-2"
                >
                  <p className="truncate px-3 pb-2 pt-2 text-xs text-muted">{username}</p>
                  {menuItems.map((item) => {
                    const active = pathname.startsWith(item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        role="menuitem"
                        className={cn(
                          "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-150",
                          active ? "bg-raised text-fg" : "text-fg-secondary hover:bg-raised hover:text-fg"
                        )}
                      >
                        <item.icon className={cn("h-4 w-4", active ? "text-gold" : "text-muted")} />
                        {item.label}
                      </Link>
                    );
                  })}
                  <div className="my-1 border-t border-border" />
                  <button
                    onClick={logout}
                    role="menuitem"
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-fg-secondary transition-colors duration-150 hover:bg-raised hover:text-fg"
                  >
                    <IconLogout className="h-4 w-4 text-muted" />
                    Log out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ── Content ── */}
      <main className="pb-24 md:pb-16">
        <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-6 md:py-10">{children}</div>
      </main>

      {/* ── Mobile bottom tabs ── */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-white/5 bg-bg/85 backdrop-blur-md backdrop-saturate-150 md:hidden">
        {/* Column count follows the item count. Hardcoding four wrapped the bar
            to two rows the moment a fifth tab appeared for admins — and since
            the bar is fixed to the bottom, that silently covered page content. */}
        <div className="grid" style={{ gridTemplateColumns: `repeat(${primary.length}, minmax(0, 1fr))` }}>
          {primary.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex flex-col items-center gap-1 pb-[max(env(safe-area-inset-bottom),12px)] pt-2 text-2xs font-medium transition-[color,transform] duration-150 active:scale-[0.97] active:ease-spring",
                  active ? "text-gold" : "text-muted"
                )}
              >
                <item.icon className="h-5 w-5" />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-lg font-bold tracking-tight md:text-xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
