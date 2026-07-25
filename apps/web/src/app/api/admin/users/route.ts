import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";

const schema = z.object({
  userId: z.string().min(1),
  action: z.enum(["suspend", "unsuspend", "setKyc", "releaseHold", "deviceOverride"]),
  kyc: z.enum(["NONE", "PENDING", "VERIFIED"]).optional(),
});

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });
  const { userId, action, kyc } = parsed.data;

  switch (action) {
    case "suspend": {
      // A suspended account cannot authenticate, so suspending yourself or the
      // last admin locks the platform out of its own admin surface for good.
      if (userId === admin.id) {
        return NextResponse.json({ error: "You cannot suspend your own account" }, { status: 400 });
      }
      const target = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      if (target?.role === "ADMIN") {
        const remaining = await prisma.user.count({
          where: { role: "ADMIN", suspendedAt: null, id: { not: userId } },
        });
        if (remaining === 0) {
          return NextResponse.json(
            { error: "Cannot suspend the last active admin" },
            { status: 400 }
          );
        }
      }
      await prisma.user.update({ where: { id: userId }, data: { suspendedAt: new Date() } });
      break;
    }
    case "unsuspend":
      await prisma.user.update({ where: { id: userId }, data: { suspendedAt: null } });
      break;
    case "setKyc":
      await prisma.user.update({ where: { id: userId }, data: { kycStatus: kyc ?? "NONE" } });
      break;
    case "releaseHold":
      await prisma.user.update({ where: { id: userId }, data: { payoutHold: false } });
      break;
    case "deviceOverride":
      // Whitelist this account's devices (e.g. shared family/staff device).
      await prisma.deviceFingerprint.updateMany({ where: { userId }, data: { overrideAllowed: true } });
      await prisma.reviewCase.updateMany({
        where: { userId, reason: "DEVICE_SHARED", status: "OPEN" },
        data: { status: "CLEARED", resolvedAt: new Date() },
      });
      break;
  }
  return NextResponse.json({ ok: true });
}
