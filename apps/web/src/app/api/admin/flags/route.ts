import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";

const schema = z.object({ key: z.string().min(1), enabled: z.boolean() });

export async function POST(req: NextRequest) {
  await requireAdmin();
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });

  await prisma.featureFlag.upsert({
    where: { key: parsed.data.key },
    update: { enabled: parsed.data.enabled },
    create: { key: parsed.data.key, enabled: parsed.data.enabled },
  });
  return NextResponse.json({ ok: true });
}
