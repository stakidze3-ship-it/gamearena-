import { redirect } from "next/navigation";
import { Logo } from "@/components/logo";
import { getSession } from "@/lib/session";
import { LanguageSwitcher } from "@/lib/i18n";
import { AuthNote } from "./auth-form";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session) redirect("/lobby");

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
