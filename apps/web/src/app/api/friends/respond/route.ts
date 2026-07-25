import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { getCurrentUser } from "@/lib/auth";

const schema = z.object({ friendshipId: z.string().min(1), accept: z.boolean() });

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });

  const f = await prisma.friendship.findUnique({ where: { id: parsed.data.friendshipId } });
  // Only the recipient of a pending request may respond.
  if (!f || f.friendId !== me.id || f.status !== "PENDING") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (parsed.data.accept) {
    await prisma.friendship.update({ where: { id: f.id }, data: { status: "ACCEPTED" } });
  } else {
    await prisma.friendship.delete({ where: { id: f.id } });
  }
  return NextResponse.json({ ok: true });
}
