import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma, recordAdminAction } from "@gamearena/db";
import { clientIp } from "@/lib/client-ip";

/**
 * One-time admin bootstrap.
 *
 * The production seed deliberately creates no users, so a fresh deployment has
 * no ADMIN — which makes every admin screen unreachable, including the bot fill
 * that exists to test tournaments. This promotes one existing account, once.
 *
 * Two hard guards, both required:
 *
 *   1. ADMIN_BOOTSTRAP_SECRET must be set in the environment and match the
 *      request. Unset means this endpoint refuses outright — it must never
 *      default to permitting, or it is a privilege-escalation hole.
 *   2. It refuses if an ADMIN already exists. So it can create the first admin
 *      and never a second, and leaving the secret configured cannot be used to
 *      escalate later.
 *
 * The account must already exist: register normally first, then call this. That
 * keeps password handling entirely on the normal signup path.
 *
 * NOT WRAPPED IN withAdminAudit, and it cannot be. The wrapper's first act is
 * requireAdmin(), and this endpoint exists precisely for the case where no
 * admin exists yet — guard 2 above means a successful call is only ever made by
 * someone who is not an admin and cannot become one any other way. Wrapping it
 * would redirect every legitimate caller to the lobby and leave the one action
 * that most needs a record unable to run at all. So the row is written by hand,
 * exactly as ../claim/route.ts does for the same reason.
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  secret: z.string().min(1),
  email: z.string().email(),
});

export async function POST(req: NextRequest) {
  const secret = process.env.ADMIN_BOOTSTRAP_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Admin bootstrap is not enabled on this deployment." },
      { status: 404 }
    );
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Send { secret, email }" }, { status: 400 });
  }
  if (parsed.data.secret !== secret) {
    // The audit table cannot hold this one: adminUserId is a foreign key to
    // User, and a caller who guessed wrong has no identity at all — there is no
    // session here, only possession of a secret. The server log is the only
    // place a guessing attempt can be recorded, and an unrecorded brute force
    // against the endpoint that mints the first admin is worth more than a
    // tidy log, so it is recorded loudly.
    console.warn(
      "[admin-bootstrap] rejected a request with the wrong secret from ip=%s",
      clientIp(req)
    );
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const existingAdmins = await prisma.user.count({ where: { role: "ADMIN" } });
  if (existingAdmins > 0) {
    return NextResponse.json(
      { error: "An admin already exists. Promote further accounts from the admin Users screen." },
      { status: 409 }
    );
  }

  const email = parsed.data.email.toLowerCase();
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, username: true } });
  if (!user) {
    return NextResponse.json(
      { error: "No account with that email. Register it first, then retry." },
      { status: 404 }
    );
  }

  await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });

  // Granting the ability to move every balance on the platform is the single
  // most audit-worthy event in the system, and it was leaving no trace at all.
  //
  // The actor is recorded as the promoted account itself. That is not a
  // pretence that they made the request — nobody can know who did, because the
  // only credential involved is an environment secret — it is the closest true
  // statement the schema can hold, and the metadata says plainly that the
  // caller was unauthenticated. The IP is the only other fact there is about
  // them, so it is kept.
  await recordAdminAction({
    adminUserId: user.id,
    adminUsername: user.username,
    action: "admin.bootstrap",
    targetType: "user",
    targetId: user.id,
    targetLabel: user.username,
    reason: "First admin on a deployment with none, via ADMIN_BOOTSTRAP_SECRET",
    metadata: {
      // The distinction that matters when this row is read: an ordinary
      // promotion has a named operator behind it and this does not.
      actor: "unauthenticated-bootstrap-secret",
      email,
      adminCountBefore: existingAdmins,
    },
    ip: clientIp(req),
  });

  return NextResponse.json({
    ok: true,
    username: user.username,
    note: "The role takes effect immediately — no need to sign out.",
  });
}
