import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: show or hide one announcement.
 *
 * Player-facing copy, which is why it is logged despite moving nothing: an
 * announcement that appeared and was pulled leaves no trace in the row itself,
 * and "who took down the maintenance notice" is a question with operational
 * consequences. The title is copied onto the row so the trail still reads as
 * something after the announcement is deleted.
 */
export const dynamic = "force-dynamic";

const schema = z.object({ id: z.string().min(1), active: z.boolean() });

export const POST = withAdminAudit(
  // "system": announcements are platform content, not a user or an event.
  { action: "content.announcement", targetType: "system" },
  async ({ req, audit }) => {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });

    // Recorded before the update so an id that no longer exists still leaves
    // behind what was attempted — the update below throws on a missing row, and
    // that failure is logged by the wrapper with this detail already attached.
    audit.meta({ announcementId: parsed.data.id, active: parsed.data.active });

    // Best effort, and before the write: the title is what makes this row
    // readable later, and an announcement can be deleted after the fact.
    const existing = await prisma.announcement
      .findUnique({ where: { id: parsed.data.id }, select: { title: true } })
      .catch(() => null);
    if (existing) audit.label(existing.title);

    await prisma.announcement.update({
      where: { id: parsed.data.id },
      data: { active: parsed.data.active },
    });
    return NextResponse.json({ ok: true });
  }
);
