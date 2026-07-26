import { redirect } from "next/navigation";
import { Logo } from "@/components/logo";
import { getCurrentUser } from "@/lib/auth";
import { LanguageSwitcher } from "@/lib/i18n";
import { AuthNote } from "./auth-form";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  // Resolve the actual USER, not just the token.
  //
  // getSession() only verifies the JWT, so an account that has since been
  // suspended or deleted still looked signed in here and got bounced to
  // /lobby — where requireUser() found no usable user and bounced it back.
  // That is an infinite redirect between two pages, and admin suspension
  // triggers it on a real player's browser. A DB-backed check ends the loop:
  // no usable account means they simply see the login form.
  const user = await getCurrentUser();
  if (user) redirect("/lobby");

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>
      <div className="mb-10">
        <Logo />
      </div>
      <div className="w-full max-w-sm">{children}</div>
      <AuthNote />
    </div>
  );
}
