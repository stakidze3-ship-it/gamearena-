import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: turn one feature flag on or off.
 *
 * A flag flip changes the platform's behaviour for everybody at once and leaves
 * no other trace — the row it writes has no history, so without this log
 * "withdrawals were off for two hours last night" has no author and no
 * timestamp. Both the key and the value it was set to go on the row, because
 * knowing a flag was touched without knowing which way is not an answer.
 */
export const dynamic = "force-dynamic";

const schema = z.object({ key: z.string().min(1), enabled: z.boolean() });

export const POST = withAdminAudit(
  // "system": a flag governs the deployment, not any one account or event.
  { action: "config.feature-flag", targetType: "system" },
  async ({ req, audit }) => {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });

    // Before the write, so a flip that fails on the database still records
    // which flag somebody was trying to move and in which direction.
    audit.label(parsed.data.key);
    audit.meta({ key: parsed.data.key, enabled: parsed.data.enabled });

    await prisma.featureFlag.upsert({
      where: { key: parsed.data.key },
      update: { enabled: parsed.data.enabled },
      create: { key: parsed.data.key, enabled: parsed.data.enabled },
    });
    return NextResponse.json({ ok: true });
  }
);
