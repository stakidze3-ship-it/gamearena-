/**
 * End-to-end check of the signup demo balance.
 *
 * Registers a genuinely new account through the real HTTP API — no mocks, no
 * direct writes — then reads the balance back out of the ledger.
 *
 * The "existing accounts are untouched" requirement is checked the only way
 * that actually proves anything: every pre-existing cash balance is snapshotted
 * before the registration and compared byte-for-byte afterwards. A backfill or
 * a migration that rewrote old grants would show up here as a diff.
 *
 *   npx tsx tools/signup-balance-test.ts            # against http://localhost:3100
 *   BASE=http://localhost:3000 npx tsx tools/signup-balance-test.ts
 */
import { AccountKeys, getBalanceTetri, prisma } from "@gamearena/db";
import { SIGNUP_CREDIT_TETRI, formatTetri } from "@gamearena/shared";

const BASE = process.env.BASE ?? "http://localhost:3100";
const EXPECTED_TETRI = 500; // ₾5 — written literally so a wrong constant cannot pass

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label} — ${detail}`);
  if (!ok) failures++;
}

/** Every user cash account, keyed by account key. */
async function cashSnapshot(): Promise<Map<string, number>> {
  const accounts = await prisma.account.findMany({
    where: { type: "USER_CASH" },
    select: { key: true, balanceTetri: true },
  });
  return new Map(accounts.map((a) => [a.key, a.balanceTetri]));
}

async function main() {
  console.log(`\nSIGNUP BALANCE · ${BASE}\n`);

  check(
    "SIGNUP_CREDIT_TETRI is ₾5",
    SIGNUP_CREDIT_TETRI === EXPECTED_TETRI,
    `${SIGNUP_CREDIT_TETRI} tetri (${formatTetri(SIGNUP_CREDIT_TETRI)})`
  );

  const before = await cashSnapshot();
  // Without this the "existing accounts unchanged" check below would pass on an
  // empty database while proving nothing at all.
  check(
    "there are pre-existing accounts to compare against",
    before.size > 0,
    `${before.size} cash accounts — run npm run db:seed first if this is 0`
  );

  // ── A brand-new account, through the real endpoint ──
  const tag = `sbt${Date.now().toString(36)}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `${tag}@example.com`,
      username: tag,
      password: "testpass1234",
    }),
  });
  const body = await res.json().catch(() => ({}));
  check("registration succeeds", res.ok, `HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
  if (!res.ok) {
    console.log(`\nFAIL (${failures})\n`);
    process.exit(1);
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { email: `${tag}@example.com` } });
  const cashKey = AccountKeys.userCash(user.id);
  const cash = await getBalanceTetri(prisma, cashKey);
  check(
    "new account cash balance is exactly ₾5",
    cash === EXPECTED_TETRI,
    `${cash} tetri (${formatTetri(cash)})`
  );

  // The grant must be one ledger movement of the right kind, not a raw write.
  const account = await prisma.account.findUniqueOrThrow({ where: { key: cashKey } });
  const entries = await prisma.ledgerEntry.findMany({
    where: { accountId: account.id },
    include: { tx: true },
  });
  check("balance came from exactly one ledger entry", entries.length === 1, `${entries.length} entries`);
  check(
    "that entry is a SIGNUP_CREDIT",
    entries[0]?.tx.kind === "SIGNUP_CREDIT",
    `kind=${entries[0]?.tx.kind ?? "none"}`
  );
  check(
    "the cached balance matches its entries",
    account.balanceTetri === entries.reduce((n, e) => n + e.amountTetri, 0),
    `cached ${account.balanceTetri}`
  );

  // Zero-sum: the treasury funded it.
  const txId = entries[0]?.txId;
  if (txId) {
    const legs = await prisma.ledgerEntry.findMany({ where: { txId } });
    const sum = legs.reduce((n, l) => n + l.amountTetri, 0);
    check("the signup transaction is zero-sum", sum === 0, `${legs.length} legs summing to ${sum}`);
  }

  // ── Requirement: existing accounts must not be modified ──
  const after = await cashSnapshot();
  const drifted: string[] = [];
  for (const [key, was] of before) {
    const now = after.get(key);
    if (now !== was) drifted.push(`${key}: ${was} → ${now ?? "gone"}`);
  }
  check(
    "every pre-existing cash balance is unchanged",
    drifted.length === 0,
    drifted.length === 0
      ? `all ${before.size} accounts identical`
      : drifted.slice(0, 5).join("; ")
  );
  check(
    "exactly one new cash account appeared",
    after.size === before.size + 1,
    `${before.size} → ${after.size}`
  );

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
