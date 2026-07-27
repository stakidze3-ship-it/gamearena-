import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, setAccountFrozen } from "@gamearena/db";
import { accountStateErrorResponse } from "@/lib/admin-account-state";
import { requireAdmin } from "@/lib/auth";

/**
 * Admin-only: ban or unban an account.
 *
 * READ THIS BEFORE ASSUMING BAN AND FREEZE DIFFER — THEY DO NOT.
 *
 * The schema has exactly one column for "this account may not sign in":
 * `User.suspendedAt`. There is no `bannedAt`, no severity, no tier. Both this
 * route and ../freeze/route.ts write that same field through setAccountFrozen,
 * so:
 *
 *   · Banning a frozen account changes nothing that was not already true.
 *   · UNBANNING ALSO UNFREEZES. There is no state where an account is "unbanned
 *     but still frozen", because there is nothing to hold that state in.
 *   · The status this API reports for a suspended account is "BANNED" either
 *     way.
 *
 * The route exists under its own name because that is the word support staff
 * and the console use, and forcing them to translate "ban this cheat" into
 * "freeze" during an incident is how the wrong control gets clicked. It is a
 * synonym, deliberately, and it says so in its own response so nobody has to
 * read this file to find out.
 *
 * What it does NOT do — and what an operator must therefore do by hand:
 *
 *   · It does not confiscate the balance. Taking money off an account is a
 *     separate, ledgered decision: POST ../balance with a negative amount.
 *   · It does not refund or withdraw open tournament entries. That money is in
 *     escrow, and pulling a player out of a live bracket is the tournament
 *     layer's job (remove player / cancel), not a side effect of an access
 *     change.
 *
 * A real ban tier — reason, expiry, appeal state, distinct from a temporary
 * freeze — needs a column and a migration. Until then this is the honest shape.
 */
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  banned: z.boolean(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  const { id } = await params;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected { banned: true | false }" }, { status: 400 });
  }
  const { banned } = parsed.data;

  if (banned && id === admin.id) {
    return NextResponse.json(
      { error: "You cannot ban your own account — it would sign you out of the console." },
      { status: 400 }
    );
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { username: true } });
  if (!target) {
    return NextResponse.json({ error: "No account with that id" }, { status: 404 });
  }

  try {
    const result = await setAccountFrozen(id, banned);
    return NextResponse.json({
      ok: true,
      ...result,
      banned,
      status: banned ? "BANNED" : "ACTIVE",
      /** True, and stated in every response: ban and freeze are one column. */
      banEqualsFreeze: true,
      message: banned
        ? `${result.username} is banned — signed out and blocked from every screen that needs a session. This is the same state as a freeze; their balance and any open entries are untouched.`
        : `${result.username} can sign in again — this also clears a freeze, because they are the same state.`,
    });
  } catch (err) {
    return accountStateErrorResponse(err);
  }
}
