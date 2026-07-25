"use client";

import Link from "next/link";
import { Logo } from "@/components/logo";
import { GameCover } from "@/components/game-cover";
import { IconChevronRight, IconShield } from "@/components/icons";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useI18n, LanguageSwitcher } from "@/lib/i18n";

/*
 * Landing v2 — one message, one action. A visitor should know within seconds:
 * skill games, real stakes, provably fair, press the gold button. Every
 * section earns its place or it's gone.
 */

export function LandingContent() {
  const { t } = useI18n();

  return (
    <div className="min-h-dvh">
      {/* ── Nav: logo, one link, log in, the CTA ── */}
      <header className="sticky top-0 z-40 border-b border-white/5 bg-bg/85 shadow-elev-2 backdrop-blur-md backdrop-saturate-150">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 md:px-6">
          <Logo />
          <div className="flex items-center gap-2">
            <Link
              href="/fairness"
              className="mr-2 hidden text-sm text-muted transition-colors duration-150 hover:text-fg sm:block"
            >
              {t("nav_fair")}
            </Link>
            <LanguageSwitcher />
            <span className="hidden sm:block">
              <Link href="/login" className={buttonClasses({ variant: "ghost", size: "sm" })}>
                {t("nav_login")}
              </Link>
            </span>
            <Link href="/register" className={buttonClasses({ variant: "primary", size: "sm" })}>
              {t("nav_signup")}
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero: the 5-second pitch ── */}
      <section className="relative flex min-h-[calc(100dvh-4rem)] flex-col items-center justify-center overflow-hidden px-4 text-center">
        {/* Barely-there gold ambience — the only decoration on this screen */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/3 h-[600px] w-[900px] -translate-x-1/2 -translate-y-1/2"
          style={{
            background:
              "radial-gradient(ellipse at center, rgb(212 175 55 / 0.07) 0%, transparent 60%)",
          }}
        />
        <p className="text-sm font-medium uppercase tracking-[0.18em] text-gold">
          {t("hero_eyebrow")}
        </p>
        <h1 className="mt-6 max-w-3xl font-display text-4xl font-extrabold tracking-tight md:text-6xl">
          {t("hero_title")}
        </h1>
        <p className="mt-6 max-w-xl text-md leading-relaxed text-muted">{t("hero_sub")}</p>
        <div className="mt-10 flex flex-col items-center gap-4">
          <Link
            href="/register"
            className={buttonClasses({ variant: "primary", size: "lg", className: "h-14 px-8 text-md" })}
          >
            {t("hero_cta")}
          </Link>
          <a href="#how" className="text-sm text-muted transition-colors duration-150 hover:text-fg">
            {t("nav_how")} ↓
          </a>
        </div>
        <p className="absolute bottom-8 left-1/2 w-full max-w-md -translate-x-1/2 px-4 text-sm text-faint">
          {t("hero_demo")}
        </p>
      </section>

      {/* ── How it works: three lines, no cards ── */}
      <section id="how" className="mx-auto max-w-2xl px-4 py-24 md:py-32">
        <h2 className="font-display text-xl font-bold tracking-tight md:text-2xl">
          {t("how_title")}
        </h2>
        <div className="mt-12 space-y-12">
          {[
            [1, t("how_1t"), t("how_1s")],
            [2, t("how_2t"), t("how_2s")],
            [3, t("how_3t"), t("how_3s")],
          ].map(([n, title, line]) => (
            <div key={String(n)} className="flex items-start gap-6">
              <span className="tnum font-display text-2xl font-bold text-gold">{n}</span>
              <div>
                <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
                <p className="mt-1 text-base text-muted">{line}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── The game ── */}
      <section className="mx-auto max-w-4xl px-4 pb-24 md:pb-32">
        <Card variant="interactive" className="group overflow-hidden">
          <Link href="/register" className="block">
            <GameCover game="block-blast" live />
            <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="font-display text-lg font-bold tracking-tight">Block Blast</h3>
                <p className="mt-1 text-sm text-muted">{t("desc_bb")}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="tnum rounded-full border border-border bg-bg px-3 py-1 text-sm text-muted">
                  60s · ₾1–₾25
                </span>
                <Button variant="primary">
                  {t("play")}
                  <IconChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </Link>
        </Card>
        <p className="mt-4 text-center text-sm text-faint">
          {t("soon")}: Bricks Breaker · Sudoku · Penalty Crash · Chicken Cross
        </p>
      </section>

      {/* ── Fairness, in one sentence ── */}
      <section className="border-y border-border bg-surface/40">
        <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 px-4 py-16 text-center">
          <IconShield className="h-6 w-6 text-gold" />
          <p className="text-base leading-relaxed text-fg-secondary">{t("fair_line")}</p>
          <Link
            href="/fairness"
            className="flex items-center gap-1 text-sm font-medium text-gold transition-colors duration-150 hover:text-gold-bright"
          >
            {t("hero_cta2")}
            <IconChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="mx-auto max-w-2xl px-4 py-24 text-center md:py-32">
        <h2 className="font-display text-2xl font-bold tracking-tight md:text-3xl">
          {t("cta_title")}
        </h2>
        <Link
          href="/register"
          className={buttonClasses({
            variant: "primary",
            size: "lg",
            className: "mt-8 h-14 px-8 text-md",
          })}
        >
          {t("nav_signup")}
        </Link>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-10 text-sm text-faint md:flex-row md:px-6">
          <div className="flex items-center gap-2">
            <Logo compact />
            <span>{t("foot_copy")}</span>
          </div>
          <p>{t("foot_legal")}</p>
        </div>
      </footer>
    </div>
  );
}
