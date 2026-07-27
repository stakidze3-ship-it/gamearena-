import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma, setAccountFrozen } from "@gamearena/db";
import { accountStateErrorResponse } from "@/lib/admin-account-state";
import { withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: freeze or unfreeze an account.
 *
 * Freezing writes `User.suspendedAt`, which `getCurrentUser` already treats as
 * "not logged in" — one write locks the account out of every authenticated
 * surface at once. A parallel "frozen" boolean would have to be honoured
 * everywhere that field is read, and the first place anyone forgot would be a
 * frozen account still playing for money.
 *
 * That also means FREEZE AND BAN ARE THE SAME STATE. There is no separate ban
 * column in the schema, and inventing a difference in the API that the database
 * cannot keep would be worse than having one control: an operator would ban an
 * account, see it "unfrozen", and assume it could still play. See
 * ../ban/route.ts, which is the same operation under the name support staff
 * reach for.
 *
 * Two guards, and they live in different places for a reason:
 *
 *   · "Not the last active admin" is derived from data, so it lives in the ops
 *     layer where it cannot be bypassed by a second caller.
 *   · "Not yourself" can only be checked here — the ops layer has no session.
 *     Freezing yourself signs you out mid-action and, if you are the only
 *     admin, locks the platform out of its own console permanently.
 */
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  frozen: z.boolean(),
});

export const POST = withAdminAudit<{ id: string }>(
  // The default action covers the body this route cannot see yet. Freezing and
  // unfreezing are renamed apart below, because the console filters on the
  // action prefix and "show me every freeze" must not also return every thaw.
  { action: "user.freeze", targetType: "user", targetIdParam: "id" },
  async ({ req, admin, params, audit }) => {
    const { id } = params;

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: "Expected { frozen: true | false }" }, { status: 400 });
    }
    const { frozen } = parsed.data;

    audit.action(frozen ? "user.freeze" : "user.unfreeze");

    if (frozen && id === admin.id) {
      return NextResponse.json(
        { error: "You cannot freeze your own account — it would sign you out of the console." },
        { status: 400 }
      );
    }

    // Checked up front so an unknown id is a plain 404 with a plain message,
    // rather than a thrown error classified back into one by matching its text.
    const target = await prisma.user.findUnique({ where: { id }, select: { username: true } });
    if (!target) {
      return NextResponse.json({ error: "No account with that id" }, { status: 404 });
    }
    audit.label(target.username);

    try {
      const result = await setAccountFrozen(id, frozen);

      // Recorded even though the action name already says it: the row is read
      // alongside ../ban, which writes the same column, and an operator
      // reconstructing an account's access history should not have to know that
      // to read it.
      audit.meta({ frozen: result.frozen, banEqualsFreeze: true });

      return NextResponse.json({
        ok: true,
        ...result,
        status: result.frozen ? "BANNED" : "ACTIVE",
        // Stated in the response, not just in this comment: whoever reads it
        // must know the two controls share one column.
        banEqualsFreeze: true,
        message: frozen
          ? `${result.username} is frozen — signed out and blocked from every screen that needs a session. This is the same state as a ban.`
          : `${result.username} can sign in again.`,
      });
    } catch (err) {
      return accountStateErrorResponse(err);
    }
  }
);
