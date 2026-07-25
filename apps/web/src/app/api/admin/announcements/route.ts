import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";

const schema = z.object({ id: z.string().min(1), active: z.boolean() });

export async function POST(req: NextRequest) {
  await requireAdmin();
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });
  await prisma.announcement.update({
    where: { id: parsed.data.id },
    data: { active: parsed.data.active },
  });
  return NextResponse.json({ ok: true });
}
