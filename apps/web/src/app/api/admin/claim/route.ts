import { NextResponse } from "next/server";
import { prisma } from "@gamearena/db";
import { adminClaimEligibility } from "@/lib/admin-claim";
import { getCurrentUser } from "@/lib/auth";

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
  return NextResponse.json({ ok: true, username: user.username });
}
