import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";

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
  return NextResponse.json({
    ok: true,
    username: user.username,
    note: "The role takes effect immediately — no need to sign out.",
  });
}
