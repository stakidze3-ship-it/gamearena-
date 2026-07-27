import { NextResponse } from "next/server";
import { z } from "zod";
import { AccountKeys, getBalanceTetri, postTransaction, prisma } from "@gamearena/db";
import { lariToTetri } from "@gamearena/shared";
import { withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: credit a named player's wallet by hand.
 *
 * The support tool — a goodwill refund, a resolved complaint. Unlike
 * /wallet-reset, which only ever touches the caller's own balance, this moves
 * money into someone else's account, so it is built to be boring and provable
 * rather than convenient:
 *
 *   · It posts through the ledger, never a balance write. The double-entry
 *     invariant (every tetri comes from somewhere) is what makes the wallet
 *     auditable at all, and a direct update would quietly break it.
 *   · Its own kind, MANUAL_REFUND, so an operator credit is never mistaken in
 *     an audit for machinery like bot funding or a balance reset.
 *   · Keyed for idempotency on a caller-supplied reference, so a double-click,
 *     a retried request or a reload cannot pay twice — the second call returns
 *     the first result.
 *   · The issuing admin is recorded in the memo. A movement of money with no
 *     name against it is not an audit trail.
 *   · Bounded per call. A slipped decimal point should bounce, not settle.
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  /** Username or email — whichever the operator has to hand. */
  identifier: z.string().min(1).max(120),
  amountLari: z.number().positive().max(500),
  reason: z.string().min(3).max(120),
  /**
   * Distinguishes one refund from another for the same person. Two genuine
   * refunds need two references; the same reference twice is a repeat.
   */
  reference: z.string().min(3).max(60),
});

export const POST = withAdminAudit(
  // No targetIdParam: this route has no dynamic segment, and the person being
  // paid is named in the body. The id is set by audit.target() once the lookup
  // below has resolved it — before that point there is nothing trustworthy to
  // file the row against, because the identifier the operator typed may match
  // nobody at all.
  { action: "user.wallet.credit", targetType: "user" },
  async ({ req, admin, audit }) => {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid refund" },
        { status: 400 }
      );
    }
    const { identifier, amountLari, reason, reference } = parsed.data;
    const needle = identifier.trim().toLowerCase();

    // Recorded before the lookup, so a credit aimed at an account that does not
    // exist still leaves behind what was attempted and who it was aimed at. A
    // mistyped identifier repeated against several spellings of one name is
    // exactly the pattern this trail exists to make visible.
    audit.reason(reason);
    audit.meta({ identifier, amountLari, reference });

    const user = await prisma.user.findFirst({
      where: { OR: [{ usernameLower: needle }, { email: needle }] },
      select: { id: true, username: true, isBot: true },
    });
    if (!user) {
      return NextResponse.json({ error: `No account matching "${identifier}"` }, { status: 404 });
    }
    audit.target(user.id, user.username);

    if (user.isBot) {
      return NextResponse.json({ error: "That account is a bot" }, { status: 400 });
    }

    const amountTetri = lariToTetri(amountLari);
    const before = await getBalanceTetri(prisma, AccountKeys.userCash(user.id));

    // In tetri as well as lari, because every other money row in this table is
    // in tetri and an audit that mixes units is one somebody eventually reads
    // off by a factor of a hundred.
    audit.meta({ amountTetri, balanceBeforeTetri: before });

    const { alreadyPosted } = await postTransaction({
      kind: "MANUAL_REFUND",
      memo: `${reason} — issued by ${admin.username}`,
      refType: "user",
      refId: user.id,
      idempotencyKey: `manual-refund:${user.id}:${reference}`,
      entries: [
        // Treasury is the mint and is negative by design; crediting a player
        // draws from it exactly as the signup grant does.
        { accountKey: AccountKeys.treasury(), amountTetri: -amountTetri },
        { accountKey: AccountKeys.userCash(user.id), amountTetri },
      ],
    });

    const after = await getBalanceTetri(prisma, AccountKeys.userCash(user.id));

    // alreadyRefunded is the fact that stops this row being read as a second
    // payment: the call succeeded and no money moved.
    audit.meta({ balanceAfterTetri: after, alreadyRefunded: alreadyPosted === true });

    return NextResponse.json({
      ok: true,
      username: user.username,
      amountTetri,
      balanceBeforeTetri: before,
      balanceAfterTetri: after,
      // True when this reference had already been paid — the credit was NOT
      // applied a second time.
      alreadyRefunded: alreadyPosted === true,
    });
  }
);
