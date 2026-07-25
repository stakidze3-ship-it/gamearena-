import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { openReviewCase, prisma } from "@gamearena/db";
import { getCurrentUser } from "@/lib/auth";

const schema = z.object({ hash: z.string().min(16).max(128) });

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });
  const { hash } = parsed.data;

  await prisma.deviceFingerprint.upsert({
    where: { hash_userId: { hash, userId: user.id } },
    update: { lastSeenAt: new Date() },
    create: { hash, userId: user.id },
  });

  // One device = one account: flag when a device backs multiple (non-overridden) accounts.
  const sharing = await prisma.deviceFingerprint.findMany({
    where: { hash, overrideAllowed: false },
    select: { userId: true },
  });
  const accounts = [...new Set(sharing.map((d) => d.userId))];
  if (accounts.length > 1) {
    await openReviewCase(prisma, user.id, "DEVICE_SHARED", {
      hash: hash.slice(0, 16),
      accountCount: accounts.length,
    });
  }

  return NextResponse.json({ ok: true });
}
