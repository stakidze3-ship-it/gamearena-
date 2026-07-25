import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@gamearena/db";
import { getSession } from "@/lib/session";
import { selfExcludeSchema } from "@/lib/validation";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = selfExcludeSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const until = new Date(Date.now() + parsed.data.days * 86_400_000);
  // Only ever extend — self-exclusion cannot be shortened via the API.
  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.sub } });
  if (user.selfExcludedUntil && user.selfExcludedUntil > until) {
    return NextResponse.json({ ok: true, until: user.selfExcludedUntil });
  }
  await prisma.user.update({
    where: { id: session.sub },
    data: { selfExcludedUntil: until },
  });
  return NextResponse.json({ ok: true, until });
}
