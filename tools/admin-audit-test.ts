/**
 * The admin audit trail.
 *
 * A console that can move money, suspend accounts and decide match results is
 * only trustworthy if every one of those leaves a row naming who did it, to
 * whom, and why. Two properties matter more than the happy path:
 *
 *   · Recording must NEVER throw. A failure to write the trail cannot be
 *     allowed to turn a completed money movement into a 500 — the money has
 *     already moved, and failing the response would tell the operator it had
 *     not.
 *   · Refused and failed attempts must be recorded too. Those are exactly what
 *     an investigation looks for, and a log of successes only is a log that
 *     hides the interesting half.
 *
 *   npx tsx --env-file=.env tools/admin-audit-test.ts
 */
import { listAdminAudit, prisma, recordAdminAction } from "@gamearena/db";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  console.log("\nADMIN AUDIT TRAIL\n");

  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true, username: true },
  });
  const target = await prisma.user.findFirstOrThrow({
    where: { isBot: false, role: "USER" },
    select: { id: true, username: true },
  });
  const marker = `test.audit.${Date.now()}`;

  // ── a successful action ──
  await recordAdminAction({
    adminUserId: admin.id,
    adminUsername: admin.username,
    action: marker,
    targetType: "user",
    targetId: target.id,
    targetLabel: target.username,
    reason: "verifying the trail",
    metadata: { amountTetri: 500, reference: "audit-test" },
    ip: "203.0.113.7",
  });

  const page = await listAdminAudit({ limit: 50 });
  const row = page.entries.find((e) => e.action === marker);
  check("a successful action is recorded", !!row);
  check("  it names the operator", row?.adminUsername === admin.username, row?.adminUsername);
  check("  and the affected user", row?.targetId === target.id);
  check("  keeping a readable label", row?.targetLabel === target.username, row?.targetLabel ?? "");
  check("  the stated reason survives", row?.reason === "verifying the trail");
  check("  with a timestamp", !!row?.createdAt);
  check("  and the caller IP", row?.ip === "203.0.113.7", row?.ip ?? "");
  check("  outcome defaults to ok", row?.outcome === "ok", row?.outcome ?? "");

  // ── a FAILED action must be recorded too ──
  const failMarker = `${marker}.refused`;
  await recordAdminAction({
    adminUserId: admin.id,
    adminUsername: admin.username,
    action: failMarker,
    targetType: "user",
    targetId: target.id,
    outcome: "error",
    errorMessage: "Refused: would overdraw the account",
  });
  const failRow = (await listAdminAudit({ limit: 50 })).entries.find(
    (e) => e.action === failMarker
  );
  check("a refused action is recorded, not dropped", !!failRow);
  check("  marked as an error", failRow?.outcome === "error", failRow?.outcome ?? "");
  check("  with the reason it failed", !!failRow?.errorMessage, failRow?.errorMessage ?? "");

  // ── recording must never throw, whatever it is handed ──
  let threw = false;
  try {
    await recordAdminAction({
      // A deliberately invalid FK: the operation this describes still happened,
      // so the write must fail loudly in the log and quietly to the caller.
      adminUserId: "does-not-exist",
      adminUsername: "ghost",
      action: `${marker}.badfk`,
      targetType: "user",
      targetId: target.id,
    });
  } catch {
    threw = true;
  }
  check("recording never throws, even on a bad write", !threw);

  // ── filtering, which is how an investigation actually reads it ──
  const byTarget = await listAdminAudit({ targetId: target.id, limit: 20 });
  check(
    "entries can be filtered to one affected user",
    byTarget.entries.length > 0 && byTarget.entries.every((e) => e.targetId === target.id),
    `${byTarget.entries.length} rows`
  );
  const byAdmin = await listAdminAudit({ adminUserId: admin.id, limit: 20 });
  check(
    "and to one operator",
    byAdmin.entries.length > 0 && byAdmin.entries.every((e) => e.adminUserId === admin.id),
    `${byAdmin.entries.length} rows`
  );
  check(
    "newest first",
    page.entries.length < 2 ||
      page.entries[0]!.createdAt.getTime() >= page.entries[1]!.createdAt.getTime()
  );

  // ── clean up only what this test wrote ──
  const removed = await prisma.adminAuditLog.deleteMany({
    where: { action: { startsWith: marker } },
  });
  console.log(`\n  (cleaned up ${removed.count} test rows)`);

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
