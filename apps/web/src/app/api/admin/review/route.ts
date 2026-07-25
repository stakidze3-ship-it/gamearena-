import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveReviewCase } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";

const schema = z.object({
  caseId: z.string().min(1),
  action: z.enum(["clear", "suspend"]),
  notes: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });
  const { caseId, action, notes } = parsed.data;

  if (action === "clear") {
    await resolveReviewCase(caseId, "CLEARED", admin.username, { releaseHold: true, notes });
  } else {
    await resolveReviewCase(caseId, "ACTION_TAKEN", admin.username, { suspend: true, notes });
  }

  return NextResponse.json({ ok: true });
}
