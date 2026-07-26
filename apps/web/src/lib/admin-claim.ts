import { prisma } from "@gamearena/db";

/**
 * Who may grant themselves the admin tools.
 *
 * Two ways to qualify, and both are deliberately narrow:
 *
 *   1. The deployment has NO admin at all. A fresh production database is
 *      created by seed-production.ts, which creates no users, so somebody has
 *      to be first — and requiring a shell or a database console to get there
 *      is what made this feature unusable in the first place.
 *
 *   2. The signed-in account is on the owner list. This is what makes it
 *      recoverable: once an admin exists, rule 1 closes forever, and without
 *      rule 2 an owner who lost their admin account would be locked out again.
 *
 * Set OWNER_EMAILS (comma-separated) to control rule 2. The default is the
 * account this project belongs to, so a fresh deploy works without any
 * configuration — which is the entire point.
 *
 * Note what this is NOT: it is not "any logged-in user can become admin". Once
 * one admin exists, everyone not on the owner list is refused, by the API as
 * well as by the UI.
 */

const DEFAULT_OWNERS = ["stakidze3@gmail.com"];

export function ownerEmails(): string[] {
  const raw = process.env.OWNER_EMAILS;
  const list = raw ? raw.split(",") : DEFAULT_OWNERS;
  return list.map((e) => e.trim().toLowerCase()).filter(Boolean);
}

export interface ClaimEligibility {
  eligible: boolean;
  /** Why — shown in the UI so the state is never mysterious. */
  reason: "already-admin" | "no-admin-yet" | "owner-account" | "admin-exists";
  adminCount: number;
}

export async function adminClaimEligibility(user: {
  email: string;
  role: string;
}): Promise<ClaimEligibility> {
  const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
  if (user.role === "ADMIN") return { eligible: false, reason: "already-admin", adminCount };
  if (adminCount === 0) return { eligible: true, reason: "no-admin-yet", adminCount };
  if (ownerEmails().includes(user.email.toLowerCase())) {
    return { eligible: true, reason: "owner-account", adminCount };
  }
  return { eligible: false, reason: "admin-exists", adminCount };
}
