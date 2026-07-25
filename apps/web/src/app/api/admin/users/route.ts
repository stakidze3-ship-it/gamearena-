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
  await requireAdmin();
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });
  const { userId, action, kyc } = parsed.data;

  switch (action) {
    case "suspend":
      await prisma.user.update({ where: { id: userId }, data: { suspendedAt: new Date() } });
      break;
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
