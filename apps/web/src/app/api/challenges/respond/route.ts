import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { getCurrentUser } from "@/lib/auth";

const schema = z.object({ challengeId: z.string().min(1), accept: z.boolean() });

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });

  const c = await prisma.challenge.findUnique({ where: { id: parsed.data.challengeId } });
  if (!c || c.toUserId !== me.id || c.status !== "PENDING") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.challenge.update({
    where: { id: c.id },
    data: { status: parsed.data.accept ? "ACCEPTED" : "DECLINED" },
  });
  return NextResponse.json({ ok: true, accepted: parsed.data.accept });
}
