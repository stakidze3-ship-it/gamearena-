import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { STAKES_TETRI } from "@gamearena/shared";
import { getGameDefinition } from "@gamearena/games";
import { getCurrentUser } from "@/lib/auth";

const schema = z.object({
  toUsername: z.string().min(1).max(40),
  gameKey: z.string(),
  stakeTetri: z.number().int().positive(),
});

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });
  const { toUsername, gameKey, stakeTetri } = parsed.data;

  if (!STAKES_TETRI.includes(stakeTetri as (typeof STAKES_TETRI)[number]) || !getGameDefinition(gameKey)) {
    return NextResponse.json({ error: "Invalid challenge" }, { status: 400 });
  }
  const game = await prisma.game.findUnique({ where: { key: gameKey } });
  if (!game || !game.enabled) return NextResponse.json({ error: "Game unavailable" }, { status: 400 });

  const target = await prisma.user.findUnique({ where: { usernameLower: toUsername.toLowerCase() } });
  if (!target || target.isBot || target.id === me.id) {
    return NextResponse.json({ error: "No such player" }, { status: 404 });
  }

  const existing = await prisma.challenge.findFirst({
    where: { fromUserId: me.id, toUserId: target.id, status: "PENDING" },
  });
  if (existing) return NextResponse.json({ error: "Challenge already pending" }, { status: 409 });

  await prisma.challenge.create({
    data: {
      fromUserId: me.id,
      toUserId: target.id,
      gameId: game.id,
      stakeTetri,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return NextResponse.json({ ok: true });
}
