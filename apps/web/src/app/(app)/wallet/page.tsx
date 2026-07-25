import type { Metadata } from "next";
import { AccountKeys, prisma } from "@gamearena/db";
import { IconChevronDown } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { requireUser } from "@/lib/auth";
import { ResponsibleGaming } from "./responsible-gaming";
import { PaymentButtons } from "./payment-buttons";

export const metadata: Metadata = { title: "Wallet" };

const KIND_LABELS: Record<string, string> = {
  SIGNUP_CREDIT: "Welcome demo credit",
  MATCH_STAKE: "Match stake → escrow",
  MATCH_PAYOUT: "Match win",
  MATCH_REFUND: "Match refund",
  BLITZ_ENTRY: "Blitz entry",
  BLITZ_PAYOUT: "Blitz payout",
  RAKEBACK: "Weekly rakeback",
  BONUS_CREDIT: "Bonus",
  VAULT_OPEN: "Vault open",
  VAULT_PRIZE: "Vault prize",
  TOURNAMENT_ENTRY: "Tournament entry",
  TOURNAMENT_PRIZE: "Tournament prize",
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
  ADJUSTMENT: "Adjustment",
};

export default async function WalletPage() {
  const user = await requireUser();
  const paymentsEnabled = process.env.PAYMENTS_ENABLED === "true";

  const [cash, vault, entries] = await Promise.all([
    prisma.account.findUnique({ where: { key: AccountKeys.userCash(user.id) } }),
    prisma.account.findUnique({ where: { key: AccountKeys.userVault(user.id) } }),
    prisma.ledgerEntry.findMany({
      where: { account: { userId: user.id, type: { in: ["USER_CASH", "USER_VAULT"] } } },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { tx: true },
    }),
  ]);

  return (
    <div className="mx-auto w-full max-w-xl space-y-10">
      {/* ── Balance — the screen ── */}
      <section className="pt-4 text-center">
        <p className="text-sm text-muted">Available balance</p>
        <p className="tnum mt-3 font-display text-4xl font-bold tracking-tight text-gold">
          <Money tetri={cash?.balanceTetri ?? 0} />
        </p>
        <p className="mt-4 flex flex-wrap items-center justify-center gap-2 text-sm text-muted">
          <Badge tone={user.kycStatus === "VERIFIED" ? "mint" : "muted"}>
            KYC {user.kycStatus.toLowerCase()}
          </Badge>
          {(vault?.balanceTetri ?? 0) > 0 && (
            <span>
              + <Money tetri={vault!.balanceTetri} className="text-fg-secondary" /> vault credits
            </span>
          )}
        </p>

        <PaymentButtons paymentsEnabled={paymentsEnabled} kycStatus={user.kycStatus} />

        <p className="mt-3 text-xs text-faint">
          Demo season: deposits and withdrawals are disabled platform-wide.
        </p>
      </section>

      {/* ── History ── */}
      <section>
        <h2 className="mb-3 text-base font-semibold tracking-tight">Transaction history</h2>
        <Card>
          <List>
            {entries.length === 0 && (
              <p className="px-5 py-10 text-center text-sm text-muted">No transactions yet.</p>
            )}
            {entries.map((e) => (
              <ListRow key={e.id}>
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    {KIND_LABELS[e.tx.kind] ?? e.tx.kind}
                    {e.tx.memo && e.tx.kind !== "SIGNUP_CREDIT" && (
                      <span className="ml-2 hidden text-xs text-faint md:inline">{e.tx.memo}</span>
                    )}
                  </p>
                  <p className="tnum mt-0.5 text-xs text-faint">
                    {e.createdAt.toLocaleString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {e.tx.refType && e.tx.refId ? ` · ${e.tx.refType} ${e.tx.refId.slice(-6)}` : ""}
                  </p>
                </div>
                <Money tetri={e.amountTetri} signed className="shrink-0 text-sm font-semibold" />
              </ListRow>
            ))}
          </List>
        </Card>
      </section>

      {/* ── Play controls ── */}
      <details className="group rounded-lg border border-border bg-surface">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-muted transition-colors duration-150 hover:text-fg [&::-webkit-details-marker]:hidden">
          Play controls &amp; limits
          <IconChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180" />
        </summary>
        <div className="border-t border-border px-4 py-3 text-sm text-muted">
          <ResponsibleGaming
            dailyLimitTetri={user.dailyDepositLimitTetri}
            selfExcludedUntil={user.selfExcludedUntil?.toISOString() ?? null}
          />
        </div>
      </details>
    </div>
  );
}
