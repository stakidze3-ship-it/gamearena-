"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { DICT, LANGS, type Lang } from "@/lib/dictionaries";
import { cn } from "@/lib/cn";
import { IconCheck, IconChevronDown } from "@/components/icons";

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);
const STORAGE_KEY = "ga.lang";

/**
 * App-wide language provider. The choice lives in localStorage so it sticks
 * across visits. Initial render is English on both server and client to avoid a
 * hydration mismatch; a saved preference is applied on mount.
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY) as Lang | null;
    if (saved && DICT[saved]) {
      setLangState(saved);
      document.documentElement.lang = saved;
    }
  }, []);

  const setLang = (l: Lang) => {
    setLangState(l);
    window.localStorage.setItem(STORAGE_KEY, l);
    document.documentElement.lang = l;
  };

  const t = (key: string) => DICT[lang][key] ?? DICT.en[key] ?? key;

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

/** Language dropdown — flag + short label, opens a menu of all languages. */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = LANGS.find((l) => l.code === lang)!;

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Language"
        className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-fg-secondary transition-colors duration-150 hover:border-border-strong hover:bg-raised"
      >
        <span aria-hidden>{current.flag}</span>
        <span className="hidden sm:inline">{current.label}</span>
        <IconChevronDown
          className={cn("h-3.5 w-3.5 text-muted transition-transform duration-150", open && "rotate-180")}
        />
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute right-0 top-full z-50 mt-1.5 w-44 rounded-lg border border-border bg-overlay p-1 shadow-elev-2"
        >
          {LANGS.map((l) => (
            <li key={l.code}>
              <button
                type="button"
                role="option"
                aria-selected={l.code === lang}
                onClick={() => {
                  setLang(l.code);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors duration-150",
                  l.code === lang ? "bg-gold/6 text-gold" : "text-fg-secondary hover:bg-raised"
                )}
              >
                <span aria-hidden className="text-base">{l.flag}</span>
                {l.name}
                {l.code === lang && <IconCheck className="ml-auto h-4 w-4" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
