import { redirect } from "next/navigation";
import { IconShield } from "@/components/icons";
import { adminClaimEligibility } from "@/lib/admin-claim";
import { requireUser } from "@/lib/auth";
import { AdminNav } from "./admin-nav";
import { ClaimAdminScreen } from "./claim-admin-screen";

/**
 * Gate for every admin screen.
 *
 * This used to be a bare `requireAdmin()`, which redirected anyone who was not
 * already an ADMIN straight to /lobby. That produced a genuinely dead
 * navigation item: the top bar shows Admin to anyone who is an admin OR is
 * eligible to become one, so an owner who had not yet claimed the role saw the
 * tab, clicked it, and was bounced back to the page they started on — which
 * reads exactly as "the button does nothing".
 *
 * The rule now matches what the navigation promises. Three outcomes, and none
 * of them is a silent bounce:
 *
 *   · ADMIN          → the console.
 *   · claim-eligible → a screen explaining why it is not open yet, with the
 *                      one button that fixes it.
 *   · everyone else  → /lobby, and they were never shown the tab.
 *
 * The redirect is kept for that last group deliberately: /admin is a URL they
 * typed rather than a link they were offered, and bouncing a guess is right.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  if (user.role !== "ADMIN") {
    const eligibility = await adminClaimEligibility(user);
    if (!eligibility.eligible) redirect("/lobby");
    return (
      <div>
        <div className="mb-4 flex items-center gap-2">
          <IconShield className="h-4 w-4 text-gold" />
          <span className="text-2xs font-medium uppercase tracking-wider text-muted">Admin</span>
        </div>
        <ClaimAdminScreen username={user.username} adminCount={eligibility.adminCount} />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <IconShield className="h-4 w-4 text-gold" />
        <span className="text-2xs font-medium uppercase tracking-wider text-muted">Admin</span>
      </div>
      <AdminNav />
      {children}
    </div>
  );
}
