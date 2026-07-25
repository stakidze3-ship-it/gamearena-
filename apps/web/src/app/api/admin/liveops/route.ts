import { NextRequest, NextResponse } from "next/server";
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { lariToTetri } from "@gamearena/shared";
import { requireAdmin } from "@/lib/auth";

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

export async function POST(req: NextRequest) {
  await requireAdmin();
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });
  const d = parsed.data;

  if (d.type === "tournament") {
    const game = await prisma.game.findUnique({ where: { key: d.gameKey } });
    if (!game) return NextResponse.json({ error: "Unknown game" }, { status: 400 });
    const startsAt = new Date(Date.now() + d.startsInHours * 3_600_000);
    const seed = randomInt(100_000, 1_000_000).toString();
    await prisma.tournament.create({
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
    });
    return NextResponse.json({ ok: true });
  }

  if (d.type === "announcement") {
    await prisma.announcement.create({ data: { title: d.title, body: d.body, active: true } });
    return NextResponse.json({ ok: true });
  }

  // happyHour
  const startsAt = new Date(Date.now() + d.startsInHours * 3_600_000);
  await prisma.happyHour.create({
    data: {
      name: d.name,
      startsAt,
      endsAt: new Date(startsAt.getTime() + d.durationMin * 60_000),
      rakeDiscountBps: Math.round(d.rakeDiscountPct * 100),
    },
  });
  return NextResponse.json({ ok: true });
}
