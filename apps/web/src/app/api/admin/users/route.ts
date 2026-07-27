import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { withAdminAudit } from "@/lib/with-admin-audit";

/**
 * Admin-only: the five account controls that change access rather than money.
 *
 * One endpoint with an action in the body, because these are the same kind of
 * decision taken from the same panel — and because they share the guard that
 * matters most (see "suspend" below). Each verb is renamed apart on the audit
 * row, though: "show me every suspension" must not also return every KYC edit.
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  userId: z.string().min(1),
  action: z.enum(["suspend", "unsuspend", "setKyc", "releaseHold", "deviceOverride"]),
  kyc: z.enum(["NONE", "PENDING", "VERIFIED"]).optional(),
});

/**
 * Body verb → audit action.
 *
 * Dotted names rather than the camelCase the API speaks, because the console
 * filters on the action prefix and the trail is read by people who have never
 * seen this schema.
 */
const AUDIT_ACTIONS: Record<z.infer<typeof schema>["action"], string> = {
  suspend: "user.suspend",
  unsuspend: "user.unsuspend",
  setKyc: "user.set-kyc",
  releaseHold: "user.release-hold",
  deviceOverride: "user.device-override",
};

export const POST = withAdminAudit(
  // "user.account" is the fallback for a body this route has not read yet, and
  // it survives only when the body could not be parsed into one of the five
  // verbs above. Defaulting to a real verb instead would file a malformed
  // request as an attempted suspension — an accusation the trail cannot support.
  { action: "user.account", targetType: "user" },
  async ({ req, admin, audit }) => {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid" }, { status: 400 });
    const { userId, action, kyc } = parsed.data;

    // Set before anything can refuse, so a blocked attempt — suspending
    // yourself, suspending the last admin — records who was aimed at and with
    // what. A refusal nobody can attribute is the gap this trail exists to close.
    audit.action(AUDIT_ACTIONS[action]);
    audit.target(userId);
    if (action === "setKyc") audit.meta({ kyc: kyc ?? "NONE" });

    // One lookup, shared with the suspend branch's last-admin guard below.
    // Deliberately does NOT 404 on an unknown id: this route has never done so,
    // and the update's own failure is the behaviour its callers already handle.
    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, role: true },
    });
    audit.label(target?.username);

    switch (action) {
      case "suspend": {
        // A suspended account cannot authenticate, so suspending yourself or the
        // last admin locks the platform out of its own admin surface for good.
        if (userId === admin.id) {
          return NextResponse.json({ error: "You cannot suspend your own account" }, { status: 400 });
        }
        if (target?.role === "ADMIN") {
          const remaining = await prisma.user.count({
            where: { role: "ADMIN", suspendedAt: null, id: { not: userId } },
          });
          if (remaining === 0) {
            return NextResponse.json(
              { error: "Cannot suspend the last active admin" },
              { status: 400 }
            );
          }
        }
        await prisma.user.update({ where: { id: userId }, data: { suspendedAt: new Date() } });
        break;
      }
      case "unsuspend":
        await prisma.user.update({ where: { id: userId }, data: { suspendedAt: null } });
        break;
      case "setKyc":
        await prisma.user.update({ where: { id: userId }, data: { kycStatus: kyc ?? "NONE" } });
        break;
      case "releaseHold":
        await prisma.user.update({ where: { id: userId }, data: { payoutHold: false } });
        break;
      case "deviceOverride": {
        // Whitelist this account's devices (e.g. shared family/staff device).
        const devices = await prisma.deviceFingerprint.updateMany({
          where: { userId },
          data: { overrideAllowed: true },
        });
        const cases = await prisma.reviewCase.updateMany({
          where: { userId, reason: "DEVICE_SHARED", status: "OPEN" },
          data: { status: "CLEARED", resolvedAt: new Date() },
        });
        // Counts, because this verb is the one that silently does nothing when
        // the account has no shared-device history — and "the override did not
        // take" is otherwise indistinguishable from "the override was never run".
        audit.meta({ devicesAllowed: devices.count, reviewCasesCleared: cases.count });
        break;
      }
    }
    return NextResponse.json({ ok: true });
  }
);
