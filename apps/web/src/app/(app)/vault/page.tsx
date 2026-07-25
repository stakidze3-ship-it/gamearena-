import type { Metadata } from "next";
import { AccountKeys, getBalanceTetri, prisma } from "@gamearena/db";
import { PageHeader } from "@/components/app-shell";
import { requireUser } from "@/lib/auth";
import { VaultClient, type VaultTierView } from "./vault-client";

export const metadata: Metadata = { title: "Vault" };

export default async function VaultPage() {
  const user = await requireUser();

  const [tiers, vaultTetri, cashTetri] = await Promise.all([
    prisma.vaultTier.findMany({ where: { enabled: true }, orderBy: { priceTetri: "asc" } }),
    getBalanceTetri(prisma, AccountKeys.userVault(user.id)),
    getBalanceTetri(prisma, AccountKeys.userCash(user.id)),
  ]);

  const view: VaultTierView[] = tiers.map((t) => ({
    id: t.id,
    key: t.key,
    name: t.name,
    priceTetri: t.priceTetri,
    prizeTable: t.prizeTable as unknown as { prizeTetri: number; weightBps: number; label: string }[],
  }));

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Vault" subtitle="Open with vault credits — prizes pay out in cash." />
      <VaultClient tiers={view} vaultTetri={vaultTetri} cashTetri={cashTetri} />
    </div>
  );
}
