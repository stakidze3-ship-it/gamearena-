/**
 * Manual wallet refunds.
 *
 * A tool that credits other people's accounts has to be provably boring: the
 * money must come from somewhere, the same refund must not pay twice, and a
 * mistyped amount must bounce rather than settle.
 *
 *   npx tsx --env-file=.env tools/wallet-refund-test.ts
 */
import { AccountKeys, getBalanceTetri, prisma } from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function cookieFor(identifier: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  const c = (res.headers.getSetCookie?.() ?? []).find((x) => x.startsWith("ga_session="));
  if (!c) throw new Error(`login failed for ${identifier}`);
  return c.split(";")[0]!;
}

function credit(cookie: string, body: unknown) {
  return fetch(`${BASE}/api/admin/wallet-credit`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
    // requireAdmin() REDIRECTS rather than returning 403, and fetch follows
    // redirects by default — which reports the lobby's 200 and makes a refusal
    // look like a success. Ask for the real status.
    redirect: "manual",
  });
}

(async () => {
  console.log("\nMANUAL WALLET REFUND\n");
  const admin = await cookieFor("admin@gamearena.ge", "admin1234");
  const target = await prisma.user.findFirstOrThrow({
    where: { isBot: false, role: "USER" },
    select: { id: true, username: true },
  });
  const key = AccountKeys.userCash(target.id);
  const before = await getBalanceTetri(prisma, key);
  const REF = `test-${Date.now()}`;

  // ── the refund ──
  const res = await credit(admin, {
    identifier: target.username,
    amountLari: 5,
    reason: "Blitz entry reimbursement",
    reference: REF,
  });
  const out = await res.json();
  check("refund accepted", res.ok, `HTTP ${res.status}`);
  const after = await getBalanceTetri(prisma, key);
  check("balance rose by exactly ₾5", after - before === 500, `${formatTetri(before)} → ${formatTetri(after)}`);

  // ── it is a real ledger movement, not a balance write ──
  const tx = await prisma.ledgerTransaction.findFirst({
    where: { idempotencyKey: `manual-refund:${target.id}:${REF}` },
    include: { entries: { include: { account: true } } },
  });
  check("a transaction was posted", !!tx);
  check("kind is MANUAL_REFUND, not a generic adjustment", tx?.kind === "MANUAL_REFUND", tx?.kind);
  check("the issuing admin is named in the memo", !!tx?.memo?.includes("arena_admin"), tx?.memo ?? "");
  const sum = (tx?.entries ?? []).reduce((n, e) => n + e.amountTetri, 0);
  check("double-entry balances to zero", sum === 0, `sums to ${sum}`);
  check(
    "funded from treasury",
    (tx?.entries ?? []).some((e) => e.account.key === AccountKeys.treasury() && e.amountTetri === -500)
  );
  check(
    "the player's account is the credited side",
    (tx?.entries ?? []).some((e) => e.account.key === key && e.amountTetri === 500)
  );

  // ── a repeat must not pay twice ──
  const dupe = await credit(admin, {
    identifier: target.username,
    amountLari: 5,
    reason: "Blitz entry reimbursement",
    reference: REF,
  });
  const dupeOut = await dupe.json();
  const afterDupe = await getBalanceTetri(prisma, key);
  check("a repeat is reported as already refunded", dupeOut.alreadyRefunded === true);
  check("and pays nothing extra", afterDupe === after, `${formatTetri(afterDupe)}`);

  const txCount = await prisma.ledgerTransaction.count({
    where: { idempotencyKey: `manual-refund:${target.id}:${REF}` },
  });
  check("exactly one transaction exists", txCount === 1, `${txCount}`);

  // ── guards ──
  const noUser = await credit(admin, { identifier: "nobody-at-all", amountLari: 5, reason: "x y z", reference: "ref-unknown" });
  check("unknown account is refused", noUser.status === 404, `HTTP ${noUser.status}`);

  const tooBig = await credit(admin, { identifier: target.username, amountLari: 5000, reason: "fat finger", reference: "ref-toobig" });
  check("an absurd amount is refused", tooBig.status === 400, `HTTP ${tooBig.status}`);

  const negative = await credit(admin, { identifier: target.username, amountLari: -5, reason: "negative", reference: "ref-negative" });
  check("a negative amount is refused", negative.status === 400, `HTTP ${negative.status}`);

  const asPlayer = await cookieFor("irakli@demo.ge", "demo1234");
  const balanceBeforeAttack = await getBalanceTetri(prisma, key);
  const notAdmin = await credit(asPlayer, { identifier: target.username, amountLari: 5, reason: "self serve", reference: "ref-nonadmin" });
  check("a non-admin is turned away", notAdmin.status >= 300 && notAdmin.status < 400, `HTTP ${notAdmin.status}`);
  const attackTx = await prisma.ledgerTransaction.count({
    where: { idempotencyKey: `manual-refund:${target.id}:ref-nonadmin` },
  });
  check("and no money moved", attackTx === 0 && (await getBalanceTetri(prisma, key)) === balanceBeforeAttack);

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
