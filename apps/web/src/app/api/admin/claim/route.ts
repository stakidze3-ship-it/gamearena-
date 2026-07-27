import { NextResponse } from "next/server";
import { prisma } from "@gamearena/db";
import { adminClaimEligibility } from "@/lib/admin-claim";
import { getCurrentUser } from "@/lib/auth";
import { createSessionToken, setSessionCookie } from "@/lib/session";

/**
 * Grant the signed-in account the admin tools, if it qualifies.
 *
 * No secret, no header, no environment variable to set — a bootstrap that
 * needs a shell is not a bootstrap. Eligibility is decided server-side by
 * adminClaimEligibility, and re-checked here rather than trusted from the UI:
 * hiding the button is ergonomics, this is the actual gate.
 */
export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in first" }, { status: 401 });

  const eligibility = await adminClaimEligibility(user);
  if (!eligibility.eligible) {
    return NextResponse.json(
      {
        error:
          eligibility.reason === "already-admin"
            ? "This account already has the admin tools."
            : "An admin already exists on this deployment. Ask them to promote you from Admin → Users.",
        ...eligibility,
      },
      { status: eligibility.reason === "already-admin" ? 409 : 403 }
    );
  }

  await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });

  // Re-issue the session, or the promotion does not take effect.
  //
  // The role travels inside the JWT, so the caller's existing cookie still says
  // USER the moment after this succeeds. Everything that reads the token — and
  // anything that ever gates on it again — would keep treating a real admin as
  // an ordinary player until they happened to sign in again, which made the
  // claim button look like it had done nothing at all.
  const token = await createSessionToken({ sub: user.id, un: user.username, rl: "ADMIN" });
  await setSessionCookie(token);

  return NextResponse.json({ ok: true, username: user.username });
}
