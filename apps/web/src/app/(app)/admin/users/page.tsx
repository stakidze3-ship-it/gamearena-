import type { Metadata } from "next";
import { prisma } from "@gamearena/db";
import { PageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { List } from "@/components/ui/list-row";
import { UserActions, UserSearch } from "./users-client";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;

  const users = await prisma.user.findMany({
    where: {
      isBot: false,
      ...(q
        ? {
            OR: [
              { usernameLower: { contains: q.toLowerCase() } },
              { email: { contains: q.toLowerCase() } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 40,
    select: {
      id: true,
      username: true,
      email: true,
      role: true,
      kycStatus: true,
      payoutHold: true,
      suspendedAt: true,
      createdAt: true,
    },
  });

  return (
    <>
      <PageHeader title="Users" subtitle="Manage accounts — KYC, payout holds, suspensions, device overrides." />
      <UserSearch initialQuery={q ?? ""} />
      <Card>
        <List>
          {users.length === 0 && (
            <p className="px-5 py-8 text-center text-sm text-muted">No users match.</p>
          )}
          {users.map((u) => (
            <div key={u.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{u.username}</span>
                  {u.role === "ADMIN" && <Badge tone="gold">Admin</Badge>}
                  {u.suspendedAt && <Badge tone="coral">Suspended</Badge>}
                  {u.payoutHold && <Badge tone="coral">Payout held</Badge>}
                  <Badge tone={u.kycStatus === "VERIFIED" ? "mint" : "muted"}>
                    KYC {u.kycStatus.toLowerCase()}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted">{u.email}</p>
              </div>
              <UserActions
                userId={u.id}
                suspended={!!u.suspendedAt}
                payoutHold={u.payoutHold}
                kyc={u.kycStatus}
              />
            </div>
          ))}
        </List>
      </Card>
    </>
  );
}
