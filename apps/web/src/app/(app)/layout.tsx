import { AccountKeys, getBalanceTetri, prisma } from "@gamearena/db";
import { AppShell } from "@/components/app-shell";
import { adminClaimEligibility } from "@/lib/admin-claim";
import { DeviceProbe } from "@/components/device-probe";
import { requireUser } from "@/lib/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const balanceTetri = await getBalanceTetri(prisma, AccountKeys.userCash(user.id));
  // Surfaced in the menu so the testing tools are discoverable to whoever can
  // actually use them — including the first owner, who is not an admin yet.
  const { eligible: canClaimAdmin } = await adminClaimEligibility(user);

  return (
    <AppShell
      username={user.username}
      isAdmin={user.role === "ADMIN"}
      canClaimAdmin={canClaimAdmin}
      balanceTetri={balanceTetri}
    >
      <DeviceProbe />
      {children}
    </AppShell>
  );
}
