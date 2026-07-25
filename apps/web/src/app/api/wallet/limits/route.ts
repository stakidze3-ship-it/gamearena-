import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@gamearena/db";
import { lariToTetri } from "@gamearena/shared";
import { getSession } from "@/lib/session";
import { limitsSchema } from "@/lib/validation";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = limitsSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const lari = parsed.data.dailyDepositLimitLari;
  await prisma.user.update({
    where: { id: session.sub },
    data: { dailyDepositLimitTetri: lari === null ? null : lariToTetri(lari) },
  });
  return NextResponse.json({ ok: true });
}
