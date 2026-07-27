import { NextResponse } from "next/server";
import { z } from "zod";
import { AccountKeys, getBalanceTetri, postTransaction, prisma } from "@gamearena/db";
import { lariToTetri } from "@gamearena/shared";
import { withAdminAudit } from "@/lib/with-admin-audit";

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

export const POST = withAdminAudit(
  { action: "user.wallet.self-reset", targetType: "user" },
  async ({ req, admin, audit }) => {

    const parsed = schema.safeParse((await req.json().catch(() => null)) ?? {});
    if (!parsed.success) {
      return NextResponse.json({ error: "Amount must be between ₾0 and ₾100" }, { status: 400 });
    }
    const targetTetri = lariToTetri(parsed.data.amountLari);

    // An admin topping up their OWN wallet is exactly the movement an audit is
    // for. It was the last money-moving route with no trail at all, which made
    // the one balance change nobody else can see also the one nobody could find.
    audit.target(admin.id, admin.username);
    audit.meta({ targetTetri, amountLari: parsed.data.amountLari, self: true });

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
    audit.meta({ balanceBeforeTetri: current, balanceAfterTetri: after });
    return NextResponse.json({ ok: true, balanceTetri: after, changed: true });
  }
);
