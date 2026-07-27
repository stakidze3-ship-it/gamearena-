/**
 * A repeated bulk adjustment must not pay twice.
 *
 * Bulk balance is the one endpoint that can double-pay hundreds of people at
 * once, because the adjustment is RELATIVE: re-sending it credits everyone
 * again. The route originally fell back to a one-minute bucket when the caller
 * sent no reference, which is a dedupe window rather than an idempotency key —
 * a 500-account batch takes long enough that a gateway timeout or a re-run
 * during an incident crosses the minute boundary trivially, and the console
 * defeated it outright by always sending `console-bulk-<Date.now()>`.
 *
 * The key is now derived from the batch itself, so a retry of the same batch is
 * a no-op however long the gap. This pins that.
 *
 * Needs the dev server on :3100.
 *   npx tsx --env-file=.env tools/bulk-idempotency-test.ts
 */
import { AccountKeys, getBalanceTetri, prisma } from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function adminCookie(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "admin@gamearena.ge", password: "admin1234" }),
  });
  const c = (res.headers.getSetCookie?.() ?? []).find((x) => x.startsWith("ga_session="));
  if (!c) throw new Error("admin login failed");
  return c.split(";")[0]!;
}

const balance = (userId: string) => getBalanceTetri(prisma, AccountKeys.userCash(userId));

(async () => {
  console.log("\nBULK ADJUSTMENT IDEMPOTENCY\n");
  const cookie = await adminCookie();

  const targets = await prisma.user.findMany({
    where: { isBot: false, role: "USER" },
    select: { id: true, username: true },
    take: 2,
  });
  if (targets.length < 2) throw new Error("need two non-admin players");
  const userIds = targets.map((t) => t.id);
  const before = await Promise.all(userIds.map(balance));

  const body = {
    userIds,
    amountTetri: 250,
    reason: "Idempotency regression check",
    // Deliberately NO reference — this is the path the console uses, and the
    // one that used to fall back to a clock bucket.
  };
  const send = () =>
    fetch(`${BASE}/api/admin/users/bulk-balance`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
      redirect: "manual",
    });

  const first = await send();
  const firstBody = await first.json().catch(() => ({}));
  check("the batch is accepted", first.ok, `HTTP ${first.status}`);
  const afterFirst = await Promise.all(userIds.map(balance));
  check(
    "each selected account moved exactly once",
    afterFirst.every((b, i) => b - before[i]! === 250),
    afterFirst.map((b, i) => `${targets[i]!.username} ${formatTetri(before[i]!)}→${formatTetri(b)}`).join(", ")
  );

  // The same batch again — the scenario that used to pay twice once the minute
  // rolled over. No sleep is needed: the key must not depend on the clock at all.
  const second = await send();
  const secondBody = await second.json().catch(() => ({}));
  const afterSecond = await Promise.all(userIds.map(balance));

  check("the identical batch is accepted rather than erroring", second.ok, `HTTP ${second.status}`);
  check(
    "but nothing moves the second time",
    afterSecond.every((b, i) => b === afterFirst[i]!),
    afterSecond.map((b) => formatTetri(b)).join(", ")
  );
  check(
    "and it says so plainly",
    secondBody.alreadyApplied === true || /already/i.test(String(secondBody.message ?? "")),
    JSON.stringify(secondBody.message ?? secondBody.alreadyApplied)
  );

  // A genuinely DIFFERENT batch must still go through — an idempotency key that
  // blocked real work would be its own outage.
  const different = await fetch(`${BASE}/api/admin/users/bulk-balance`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ ...body, amountTetri: 100 }),
    redirect: "manual",
  });
  const afterDifferent = await Promise.all(userIds.map(balance));
  check("a different amount is a different batch and still applies", different.ok, `HTTP ${different.status}`);
  check(
    "  moving each account again",
    afterDifferent.every((b, i) => b - afterSecond[i]! === 100),
    afterDifferent.map((b) => formatTetri(b)).join(", ")
  );

  // ── put it all back ──
  const restore = await fetch(`${BASE}/api/admin/users/bulk-balance`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      userIds,
      amountTetri: -350,
      reason: "Idempotency regression check — restore",
    }),
    redirect: "manual",
  });
  const restored = await Promise.all(userIds.map(balance));
  check("restore succeeded", restore.ok, `HTTP ${restore.status}`);
  check(
    "every balance is back where it started",
    restored.every((b, i) => b === before[i]!),
    restored.map((b, i) => `${formatTetri(before[i]!)}→${formatTetri(b)}`).join(", ")
  );

  void firstBody;
  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
