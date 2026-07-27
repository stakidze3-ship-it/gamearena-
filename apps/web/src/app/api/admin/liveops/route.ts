import { NextResponse } from "next/server";
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { lariToTetri } from "@gamearena/shared";
import { withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: the live-ops desk — schedule an event, post a notice, run a
 * promotion.
 *
 * Three creations behind one endpoint, and three separate audit actions, because
 * they are three different kinds of consequence: a tournament can take real
 * entry money, an announcement is player-facing copy, a happy hour changes the
 * rake for everybody who plays during it. Filing them under one name would make
 * "what did we run last weekend" unanswerable without reading every row.
 */
export const dynamic = "force-dynamic";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const PRIZE_PRESETS: Record<string, { rank: number; shareBps: number }[]> = {
  winner: [{ rank: 1, shareBps: 10_000 }],
  top2: [
    { rank: 1, shareBps: 6000 },
    { rank: 2, shareBps: 4000 },
  ],
  top3: [
    { rank: 1, shareBps: 5000 },
    { rank: 2, shareBps: 3000 },
    { rank: 3, shareBps: 2000 },
  ],
};

const schema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tournament"),
    name: z.string().min(2).max(60),
    gameKey: z.string(),
    entryLari: z.number().min(0).max(10_000),
    guaranteeLari: z.number().min(0).max(1_000_000),
    capacity: z.number().int().min(2).max(1024),
    startsInHours: z.number().min(0).max(720),
    durationMin: z.number().int().min(5).max(1440),
    prizes: z.enum(["winner", "top2", "top3"]),
  }),
  z.object({
    type: z.literal("announcement"),
    title: z.string().min(2).max(120),
    body: z.string().min(2).max(400),
  }),
  z.object({
    type: z.literal("happyHour"),
    name: z.string().min(2).max(60),
    startsInHours: z.number().min(0).max(720),
    durationMin: z.number().int().min(15).max(1440),
    rakeDiscountPct: z.number().min(0).max(100),
  }),
]);

export const POST = withAdminAudit(
  // "liveops.create" is the fallback for a body that matched none of the three
  // members of the union; a parsed body renames itself to the exact creation
  // below. targetType is left to each branch, because a tournament is a
  // tournament and the other two are platform content.
  { action: "liveops.create", targetType: "system" },
  async ({ req, audit }) => {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });
    const d = parsed.data;

    if (d.type === "tournament") {
      audit.action("liveops.create-tournament");
      audit.label(d.name);
      // Everything that decides what this event costs and pays, recorded before
      // it exists — an event created with the wrong entry fee is corrected by
      // deleting it, and then the only record of what was asked for is this row.
      audit.meta({
        name: d.name,
        gameKey: d.gameKey,
        entryTetri: lariToTetri(d.entryLari),
        guaranteeTetri: lariToTetri(d.guaranteeLari),
        capacity: d.capacity,
        startsInHours: d.startsInHours,
        durationMin: d.durationMin,
        prizes: d.prizes,
      });

      const game = await prisma.game.findUnique({ where: { key: d.gameKey } });
      if (!game) return NextResponse.json({ error: "Unknown game" }, { status: 400 });
      const startsAt = new Date(Date.now() + d.startsInHours * 3_600_000);
      const seed = randomInt(100_000, 1_000_000).toString();
      const created = await prisma.tournament.create({
        data: {
          name: d.name,
          gameId: game.id,
          entryTetri: lariToTetri(d.entryLari),
          guaranteeTetri: lariToTetri(d.guaranteeLari),
          prizeStructure: PRIZE_PRESETS[d.prizes]!,
          capacity: d.capacity,
          startsAt,
          durationS: d.durationMin * 60,
          seed,
          seedHash: sha256(seed),
          status: d.startsInHours <= 0 ? "RUNNING" : "SCHEDULED",
        },
        // Selected only so the audit row can name what was created. The response
        // below is unchanged — the console reloads its own list.
        select: { id: true, name: true, status: true },
      });
      // The id goes in the metadata rather than in targetId. One config declares
      // one targetType for the whole route, and this endpoint creates three
      // different kinds of thing — filing a tournament id under targetType
      // "system" would be worse than not filing it, because the console reads
      // the pair together. The dedicated /tournaments/create* routes, which is
      // what the console actually calls to run an event, do file against the
      // tournament properly.
      audit.meta({
        tournamentId: created.id,
        status: created.status,
        startsAt: startsAt.toISOString(),
      });
      return NextResponse.json({ ok: true });
    }

    if (d.type === "announcement") {
      audit.action("liveops.create-announcement");
      audit.label(d.title);
      // The copy itself: an announcement can be edited or deleted, and "what did
      // it actually say when it went out" is the whole question afterwards.
      audit.meta({ title: d.title, body: d.body });
      const created = await prisma.announcement.create({
        data: { title: d.title, body: d.body, active: true },
        select: { id: true },
      });
      audit.meta({ announcementId: created.id });
      return NextResponse.json({ ok: true });
    }

    // happyHour
    audit.action("liveops.create-happy-hour");
    audit.label(d.name);
    const startsAt = new Date(Date.now() + d.startsInHours * 3_600_000);
    const endsAt = new Date(startsAt.getTime() + d.durationMin * 60_000);
    // A rake discount is revenue given away for a window. The window and the
    // size of the discount are the two facts a finance question will ask for.
    audit.meta({
      name: d.name,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      rakeDiscountBps: Math.round(d.rakeDiscountPct * 100),
    });
    const created = await prisma.happyHour.create({
      data: {
        name: d.name,
        startsAt,
        endsAt,
        rakeDiscountBps: Math.round(d.rakeDiscountPct * 100),
      },
      select: { id: true },
    });
    audit.meta({ happyHourId: created.id });
    return NextResponse.json({ ok: true });
  }
);
