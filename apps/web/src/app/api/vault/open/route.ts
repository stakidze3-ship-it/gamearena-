import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { AccountKeys, getBalanceTetri, openVaultIn, prisma } from "@gamearena/db";
import { getCurrentUser } from "@/lib/auth";

const schema = z.object({ tierId: z.string().min(1) });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

interface PrizeSlot {
  prizeTetri: number;
  weightBps: number;
  label: string;
}

/** Deterministic weighted pick from the seed — anyone can recompute it. */
function pickPrize(seed: string, table: PrizeSlot[]): { index: number; slot: PrizeSlot } {
  const total = table.reduce((s, p) => s + p.weightBps, 0);
  const roll = parseInt(sha256(seed).slice(0, 8), 16) % total;
  let acc = 0;
  for (let i = 0; i < table.length; i++) {
    acc += table[i]!.weightBps;
    if (roll < acc) return { index: i, slot: table[i]! };
  }
  return { index: table.length - 1, slot: table[table.length - 1]! };
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.selfExcludedUntil && user.selfExcludedUntil > new Date()) {
    return NextResponse.json({ error: "Self-exclusion active" }, { status: 403 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });

  const tier = await prisma.vaultTier.findUnique({ where: { id: parsed.data.tierId } });
  if (!tier || !tier.enabled) return NextResponse.json({ error: "Vault unavailable" }, { status: 400 });

  const vaultBalance = await getBalanceTetri(prisma, AccountKeys.userVault(user.id));
  if (vaultBalance < tier.priceTetri) {
    return NextResponse.json({ error: "Not enough vault credits" }, { status: 402 });
  }

  const table = tier.prizeTable as unknown as PrizeSlot[];
  const seed = randomBytes(6).toString("hex");
  const seedHash = sha256(seed);
  const { index, slot } = pickPrize(seed, table);

  const open = await prisma.$transaction(async (db) => {
    const created = await db.vaultOpen.create({
      data: {
        userId: user.id,
        tierId: tier.id,
        seed,
        seedHash,
        prizeTetri: slot.prizeTetri,
      },
    });
    await openVaultIn(db, created.id, user.id, tier.priceTetri, slot.prizeTetri);
    return created;
  });

  const [newVaultTetri, newCashTetri] = await Promise.all([
    getBalanceTetri(prisma, AccountKeys.userVault(user.id)),
    getBalanceTetri(prisma, AccountKeys.userCash(user.id)),
  ]);

  return NextResponse.json({
    openId: open.id,
    prizeIndex: index,
    prizeTetri: slot.prizeTetri,
    label: slot.label,
    seed,
    seedHash,
    newVaultTetri,
    newCashTetri,
  });
}
