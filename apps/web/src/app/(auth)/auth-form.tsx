"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FieldError, Hint, Input, Label } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n";

/**
 * Only ever return to a path on this site. `next` arrives from a URL — an
 * absolute or protocol-relative value would hand a visitor to someone else's
 * page right after they typed their password.
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/lobby";
  // Resolve against our own origin and compare, rather than blacklisting
  // characters. The URL parser strips tabs and newlines and treats a backslash
  // as a separator, so "/\evil.com" and "/<tab>\evil.com" both resolve to a
  // foreign origin while looking like same-site paths to a string check.
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return "/lobby";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/lobby";
  }
}

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const payload =
      mode === "register"
        ? {
            email: String(form.get("email")),
            username: String(form.get("username")),
            password: String(form.get("password")),
            referralCode: String(form.get("referralCode") || "") || undefined,
          }
        : {
            identifier: String(form.get("identifier")),
            password: String(form.get("password")),
          };
    const res = await fetch(`/api/auth/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      router.push(safeNext(params.get("next")));
      router.refresh();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? t("err_generic"));
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="mb-2 font-display text-xl font-bold tracking-tight md:text-2xl">
        {t(mode === "register" ? "reg_title" : "login_title")}
      </h1>
      <p className="mb-8 text-sm text-muted">
        {t(mode === "register" ? "reg_sub" : "login_sub")}
      </p>

      <form onSubmit={onSubmit} className="space-y-5">
        {mode === "register" ? (
          <>
            <div>
              <Label htmlFor="email">{t("f_email")}</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required placeholder={t("f_email_ph")} />
            </div>
            <div>
              <Label htmlFor="username">{t("f_username")}</Label>
              <Input id="username" name="username" autoComplete="username" required minLength={3} maxLength={20} placeholder={t("f_username_ph")} />
              <Hint>{t("f_username_hint")}</Hint>
            </div>
            <div>
              <Label htmlFor="password">{t("f_password")}</Label>
              <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} placeholder={t("f_password_ph")} />
            </div>
            <div>
              <Label htmlFor="referralCode">
                {t("f_referral")} <span className="font-normal text-faint">{t("f_optional")}</span>
              </Label>
              <Input id="referralCode" name="referralCode" maxLength={16} placeholder={t("f_referral_ph")} className="uppercase" />
            </div>
          </>
        ) : (
          <>
            <div>
              <Label htmlFor="identifier">{t("f_identifier")}</Label>
              <Input id="identifier" name="identifier" autoComplete="username" required />
            </div>
            <div>
              <Label htmlFor="password">{t("f_password")}</Label>
              <Input id="password" name="password" type="password" autoComplete="current-password" required />
            </div>
          </>
        )}

        <FieldError>{error}</FieldError>

        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy}>
          {busy ? t("btn_busy") : t(mode === "register" ? "btn_register" : "btn_login")}
        </Button>

        <p className="pt-2 text-center text-sm text-muted">
          {mode === "register" ? (
            <>
              {t("have_account")}{" "}
              <Link href="/login" className="text-fg underline-offset-4 hover:underline">
                {t("link_login")}
              </Link>
            </>
          ) : (
            <>
              {t("new_here")}{" "}
              <Link href="/register" className="text-fg underline-offset-4 hover:underline">
                {t("link_register")}
              </Link>
            </>
          )}
        </p>
      </form>
    </>
  );
}

/** Translated footer note at the bottom of the auth screen (client — reads the language). */
export function AuthNote() {
  const { t } = useI18n();
  return (
    <p className="mt-10 max-w-sm text-center text-sm leading-relaxed text-faint">{t("auth_note")}</p>
  );
}
