import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AccountKeys, getBalanceTetri, postTransaction, prisma } from "@gamearena/db";
import { lariToTetri } from "@gamearena/shared";
import { requireAdmin } from "@/lib/auth";

/**
 * Admin-only: set YOUR OWN demo cash balance to an exact figure.
 *
 * Exists so an operator whose account predates the ₾5 signup grant can feel
 * exactly what a new player feels — the default stake being their entire
 * balance, one affordable knockout seat — without a database console. It only
 * ever touches the caller's own account: resetting someone else's wallet is a
 * different, more dangerous tool, deliberately not built.
 *
 * Moves money the only way money moves here: one zero-sum ledger ADJUSTMENT
 * against the treasury. Cash only — vault credits are a separate economy and
 * are left alone.
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  // Bounded so a typo cannot mint a fortune even for an admin.
  amountLari: z.number().min(0).max(100).default(5),
});

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();

  const parsed = schema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Amount must be between ₾0 and ₾100" }, { status: 400 });
  }
  const targetTetri = lariToTetri(parsed.data.amountLari);

  const cashKey = AccountKeys.userCash(admin.id);
  const current = await getBalanceTetri(prisma, cashKey);
  const delta = targetTetri - current; // >0 mint from treasury, <0 return to it
  if (delta === 0) {
    return NextResponse.json({ ok: true, balanceTetri: current, changed: false });
  }

  await postTransaction({
    kind: "ADJUSTMENT",
    memo: `Demo balance reset to ₾${parsed.data.amountLari}`,
    refType: "user",
    refId: admin.id,
    entries: [
      { accountKey: AccountKeys.treasury(), amountTetri: -delta },
      { accountKey: cashKey, amountTetri: delta },
    ],
  });

  const after = await getBalanceTetri(prisma, cashKey);
  return NextResponse.json({ ok: true, balanceTetri: after, changed: true });
}
