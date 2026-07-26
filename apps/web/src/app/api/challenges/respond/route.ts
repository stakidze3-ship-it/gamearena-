import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AccountKeys, getBalanceTetri, prisma } from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";
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

  // Refuse an accept the responder cannot fund.
  //
  // Accepting sends both players into a private queue and the responder's
  // client auto-joins; the stake check then fails inside the realtime service,
  // which leaves the responder on an error screen and the challenger waiting
  // for an opponent who can never arrive. A ₾5 starting balance makes this the
  // common case rather than a rare one — a new account cannot fund the ₾10 or
  // ₾25 stakes the picker still offers.
  if (parsed.data.accept) {
    const balance = await getBalanceTetri(prisma, AccountKeys.userCash(me.id));
    if (balance < c.stakeTetri) {
      return NextResponse.json(
        {
          error: `You need ${formatTetri(c.stakeTetri)} to accept this challenge — you have ${formatTetri(balance)}.`,
        },
        { status: 402 }
      );
    }
  }

  await prisma.challenge.update({
    where: { id: c.id },
    data: { status: parsed.data.accept ? "ACCEPTED" : "DECLINED" },
  });
  return NextResponse.json({ ok: true, accepted: parsed.data.accept });
}
