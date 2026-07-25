/**
 * Ledger integrity audit — run with: npm run ledger:check
 *
 *   1. GLOBAL ZERO-SUM: sum of every LedgerEntry.amountTetri === 0
 *   2. PER-TX ZERO-SUM: each transaction's entries sum to 0
 *   3. CACHE CONSISTENCY: Account.balanceTetri === sum of its entries
 *   4. FLOOR: no user/escrow account is negative
 */
import { formatSignedTetri, formatTetri } from "@gamearena/shared";
import { prisma } from "./client";

async function main() {
  let failures = 0;

  // 1. Global zero-sum
  const global = await prisma.ledgerEntry.aggregate({ _sum: { amountTetri: true } });
  const globalSum = global._sum.amountTetri ?? 0;
  if (globalSum === 0) {
    console.log("✓ Global zero-sum: all entries sum to ₾0.00");
  } else {
    failures++;
    console.error(`✗ GLOBAL SUM BROKEN: ${formatSignedTetri(globalSum)}`);
  }

  // 2. Per-transaction zero-sum
  const badTx = await prisma.$queryRaw<{ txId: string; sum: bigint }[]>`
    SELECT "txId", SUM("amountTetri")::bigint AS sum
    FROM "LedgerEntry" GROUP BY "txId" HAVING SUM("amountTetri") != 0`;
  if (badTx.length === 0) {
    const txCount = await prisma.ledgerTransaction.count();
    console.log(`✓ Per-tx zero-sum: all ${txCount} transactions balance`);
  } else {
    failures++;
    console.error(`✗ ${badTx.length} UNBALANCED TRANSACTIONS:`, badTx.slice(0, 10));
  }

  // 3. Cached balance === sum of entries
  const badCache = await prisma.$queryRaw<{ key: string; cached: number; actual: bigint }[]>`
    SELECT a."key", a."balanceTetri" AS cached, COALESCE(SUM(e."amountTetri"), 0)::bigint AS actual
    FROM "Account" a LEFT JOIN "LedgerEntry" e ON e."accountId" = a."id"
    GROUP BY a."id" HAVING a."balanceTetri" != COALESCE(SUM(e."amountTetri"), 0)`;
  if (badCache.length === 0) {
    const accCount = await prisma.account.count();
    console.log(`✓ Cache consistency: all ${accCount} account balances match their entries`);
  } else {
    failures++;
    console.error(`✗ ${badCache.length} STALE CACHED BALANCES:`, badCache.slice(0, 10));
  }

  // 4. No negative user/escrow balances
  const negative = await prisma.account.findMany({
    where: {
      balanceTetri: { lt: 0 },
      type: { notIn: ["SYS_TREASURY", "SYS_PROMO"] },
    },
  });
  if (negative.length === 0) {
    console.log("✓ Floor: no user/escrow account below zero");
  } else {
    failures++;
    console.error(`✗ NEGATIVE BALANCES:`, negative.map((a) => `${a.key}=${a.balanceTetri}`));
  }

  // Summary by account type
  const byType = await prisma.account.groupBy({
    by: ["type"],
    _sum: { balanceTetri: true },
    _count: true,
  });
  console.log("\nBalances by account type:");
  for (const row of byType.sort((a, b) => a.type.localeCompare(b.type))) {
    const sum = row._sum.balanceTetri ?? 0;
    console.log(
      `  ${row.type.padEnd(18)} ${String(row._count).padStart(4)} accts  ${formatSignedTetri(sum).padStart(14)}`
    );
  }
  const total = byType.reduce((s, r) => s + (r._sum.balanceTetri ?? 0), 0);
  console.log(`  ${"TOTAL".padEnd(18)} ${" ".repeat(4)}       ${formatSignedTetri(total).padStart(14)}`);

  if (failures > 0) {
    console.error(`\n✗ LEDGER CHECK FAILED (${failures} invariant(s) broken)`);
    process.exit(1);
  }
  console.log(`\n✓ Ledger is sound. Every tetri accounted for (treasury mint = ${formatTetri(
    Math.abs((byType.find((r) => r.type === "SYS_TREASURY")?._sum.balanceTetri ?? 0))
  )} issued).`);
}

main().finally(() => prisma.$disconnect());
