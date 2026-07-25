import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { getCurrentUser } from "@/lib/auth";

const schema = z.object({ username: z.string().min(1).max(40) });

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });

  const target = await prisma.user.findUnique({
    where: { usernameLower: parsed.data.username.toLowerCase() },
  });
  if (!target || target.isBot) return NextResponse.json({ error: "No such player" }, { status: 404 });
  if (target.id === me.id) return NextResponse.json({ error: "That's you" }, { status: 400 });

  const existing = await prisma.friendship.findFirst({
    where: {
      OR: [
        { userId: me.id, friendId: target.id },
        { userId: target.id, friendId: me.id },
      ],
    },
  });
  if (existing) {
    return NextResponse.json(
      { error: existing.status === "ACCEPTED" ? "Already friends" : "Request already pending" },
      { status: 409 }
    );
  }

  await prisma.friendship.create({
    data: { userId: me.id, friendId: target.id, status: "PENDING" },
  });
  return NextResponse.json({ ok: true });
}
