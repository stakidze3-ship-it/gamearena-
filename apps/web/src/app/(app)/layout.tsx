import { AccountKeys, getBalanceTetri, prisma } from "@gamearena/db";
import { AppShell } from "@/components/app-shell";
import { DeviceProbe } from "@/components/device-probe";
import { requireUser } from "@/lib/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const balanceTetri = await getBalanceTetri(prisma, AccountKeys.userCash(user.id));

  return (
    <AppShell username={user.username} isAdmin={user.role === "ADMIN"} balanceTetri={balanceTetri}>
      <DeviceProbe />
      {children}
    </AppShell>
  );
}
