/**
 * Bulk balance operations — the most dangerous tools in the admin console.
 *
 * A single press of any of these rewrites balances the operator has not looked
 * at individually, so the properties worth proving are not the happy paths:
 *
 *   · Money MOVES, never gets written. Every balance change here has to be
 *     backed by ledger entries that sum to zero, or the whole wallet stops
 *     being auditable.
 *   · All-or-nothing. A batch that pays thirty of forty and then fails leaves
 *     an operator guessing which thirty, and the natural response — press it
 *     again — pays those thirty twice.
 *   · The preview cannot lie. It runs the same predicate and the same
 *     arithmetic as the sweep, or the confirmation dialog is a guess dressed
 *     up as a fact.
 *   · Over the cap it REFUSES rather than truncating.
 *   · Admins and bots are out unless explicitly opted in.
 *
 * The script snapshots every balance it is about to disturb and restores them
 * through the ledger at the end, so running it leaves the database's money
 * exactly as it found it — extra history, zero net movement.
 *
 *   npx tsx --env-file=.env tools/bulk-balance-test.ts
 */
import {
  AccountKeys,
  BULK_BALANCE_MAX_ACCOUNTS,
  bulkAdjustBalance,
  getBalanceTetri,
  postTransaction,
  previewResetAllUsers,
  prisma,
  resetAllUsersToSignupBalance,
  setExactBalance,
} from "@gamearena/db";
import { SIGNUP_CREDIT_TETRI, formatTetri, lariToTetri } from "@gamearena/shared";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Assert that a call refuses, and that the refusal says something useful. */
async function refuses(label: string, fn: () => Promise<unknown>, expect: RegExp) {
  try {
    await fn();
    check(label, false, "it did NOT refuse");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(label, expect.test(message), message.slice(0, 110));
  }
}

const cash = (userId: string) => getBalanceTetri(prisma, AccountKeys.userCash(userId));

/** Sum of every entry on a transaction — the invariant the ledger exists for. */
async function txSum(idempotencyKey: string): Promise<number | null> {
  const tx = await prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey },
    include: { entries: true },
  });
  if (!tx) return null;
  return tx.entries.reduce((s, e) => s + e.amountTetri, 0);
}

(async () => {
  console.log("\nBULK BALANCE OPERATIONS\n");

  const admin = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const players = await prisma.user.findMany({
    where: { isBot: false, role: "USER" },
    select: { id: true, username: true },
    take: 4,
  });
  if (players.length < 4) throw new Error("need at least 4 non-bot players seeded");
  const [alice, bob, carol, dave] = players as [
    (typeof players)[0],
    (typeof players)[0],
    (typeof players)[0],
    (typeof players)[0],
  ];
  const bot = await prisma.user.findFirstOrThrow({ where: { isBot: true } });

  // Everything this script will disturb, remembered so it can be put back.
  const touched = [alice, bob, carol, dave];
  const snapshot = new Map<string, number>();
  for (const u of touched) snapshot.set(u.id, await cash(u.id));

  const run = Date.now();

  // ── setExactBalance ─────────────────────────────────────────────────────
  console.log("setExactBalance");

  const up = await setExactBalance(alice.id, lariToTetri(20), "test up", admin.username, `t${run}-up`);
  check(
    "moves UP to the target",
    up.balanceAfterTetri === lariToTetri(20) && up.reachedTarget && up.changed,
    `${formatTetri(up.balanceBeforeTetri)} → ${formatTetri(up.balanceAfterTetri)}`
  );
  check(
    "the posting it made balances to zero",
    (await txSum(`admin-set-balance:${alice.id}:t${run}-up`)) === 0
  );

  const down = await setExactBalance(alice.id, lariToTetri(3), "test down", admin.username, `t${run}-dn`);
  check(
    "moves DOWN to the target",
    down.balanceAfterTetri === lariToTetri(3) && down.deltaTetri === lariToTetri(-17),
    `delta ${formatTetri(down.deltaTetri)}`
  );

  const same = await setExactBalance(alice.id, lariToTetri(3), "test noop", admin.username, `t${run}-noop`);
  check(
    "already on target is a no-op, not a zero-amount posting",
    !same.changed && same.reachedTarget && (await txSum(`admin-set-balance:${alice.id}:t${run}-noop`)) === null
  );

  // A reused reference must not move money a second time — AND must not claim
  // the account reached the target, because the balance has moved on since.
  await setExactBalance(alice.id, lariToTetri(9), "first", admin.username, `t${run}-dup`);
  const spentAfter = await setExactBalance(alice.id, lariToTetri(11), "second", admin.username, `t${run}-dup2`);
  const replay = await setExactBalance(alice.id, lariToTetri(9), "replay", admin.username, `t${run}-dup`);
  check(
    "a reused reference moves nothing",
    replay.alreadyApplied && replay.balanceAfterTetri === spentAfter.balanceAfterTetri,
    `still ${formatTetri(replay.balanceAfterTetri)}`
  );
  check(
    "…and admits the target was NOT reached",
    !replay.reachedTarget,
    "reachedTarget=false, so the route can say so instead of claiming success"
  );

  await refuses(
    "refuses a negative target",
    () => setExactBalance(alice.id, -1, "r", admin.username, `t${run}-neg`),
    /must not be negative/i
  );
  await refuses(
    "refuses a target over the adjustment cap",
    () => setExactBalance(alice.id, lariToTetri(999_999), "r", admin.username, `t${run}-big`),
    /capped at/i
  );
  await refuses(
    "refuses a blank reason",
    () => setExactBalance(alice.id, 100, "   ", admin.username, `t${run}-nr`),
    /reason is required/i
  );
  await refuses(
    "refuses an unknown account",
    () => setExactBalance("nope", 100, "r", admin.username, `t${run}-404`),
    /no such account/i
  );

  // ── bulkAdjustBalance ───────────────────────────────────────────────────
  console.log("\nbulkAdjustBalance");

  for (const u of [bob, carol, dave]) {
    await setExactBalance(u.id, lariToTetri(10), "test setup", admin.username, `t${run}-setup-${u.id}`);
  }

  const batch = await bulkAdjustBalance({
    userIds: [bob.id, carol.id, dave.id],
    amountTetri: lariToTetri(2),
    reason: "test batch",
    adminUsername: admin.username,
    reference: `t${run}-batch`,
  });
  check(
    "credits every account in the list",
    batch.affectedCount === 3 &&
      batch.rows.every((r) => r.balanceAfterTetri === r.balanceBeforeTetri + lariToTetri(2)),
    `net ${formatTetri(batch.netTetri)}`
  );
  check(
    "posts ONE balanced transaction for the whole batch, not three",
    (await txSum(`admin-bulk-adjust:t${run}-batch`)) === 0,
    "entries sum to 0"
  );

  const batchTx = await prisma.ledgerTransaction.findUnique({
    where: { idempotencyKey: `admin-bulk-adjust:t${run}-batch` },
    include: { entries: { include: { account: true } } },
  });
  check(
    "…with one entry per player plus a single treasury counterparty",
    batchTx?.entries.length === 4 &&
      batchTx.entries.filter((e) => e.account.key === AccountKeys.treasury()).length === 1
  );
  check(
    "…and treasury is the FIRST entry, so the hottest lock is taken first",
    batchTx?.entries[0]?.account.key === AccountKeys.treasury()
  );

  const replayBatch = await bulkAdjustBalance({
    userIds: [bob.id, carol.id, dave.id],
    amountTetri: lariToTetri(2),
    reason: "test batch replay",
    adminUsername: admin.username,
    reference: `t${run}-batch`,
  });
  const afterReplay = await cash(bob.id);
  check(
    "a reused reference pays nobody a second time",
    replayBatch.alreadyApplied && afterReplay === batch.rows.find((r) => r.userId === bob.id)!.balanceAfterTetri,
    `${formatTetri(afterReplay)} unchanged`
  );

  await refuses(
    "refuses a batch containing a bot, naming it",
    () =>
      bulkAdjustBalance({
        userIds: [bob.id, bot.id],
        amountTetri: 100,
        reason: "r",
        adminUsername: admin.username,
        reference: `t${run}-bot`,
      }),
    new RegExp(bot.username)
  );
  await refuses(
    "refuses a batch containing an unknown id",
    () =>
      bulkAdjustBalance({
        userIds: [bob.id, "not-a-user"],
        amountTetri: 100,
        reason: "r",
        adminUsername: admin.username,
        reference: `t${run}-ghost`,
      }),
    /are not accounts/i
  );
  await refuses(
    "refuses a batch over the account cap",
    () =>
      bulkAdjustBalance({
        userIds: Array.from({ length: BULK_BALANCE_MAX_ACCOUNTS + 1 }, (_, i) => `u${i}`),
        amountTetri: 100,
        reason: "r",
        adminUsername: admin.username,
        reference: `t${run}-cap`,
      }),
    /capped at/i
  );

  // All-or-nothing, proved rather than asserted: one account in the batch
  // cannot afford the debit, so NOBODY may be debited.
  await setExactBalance(dave.id, 1, "test poor", admin.username, `t${run}-poor`);
  const bobBefore = await cash(bob.id);
  await refuses(
    "refuses a debit that any one account cannot afford",
    () =>
      bulkAdjustBalance({
        userIds: [bob.id, carol.id, dave.id],
        amountTetri: lariToTetri(-5),
        reason: "r",
        adminUsername: admin.username,
        reference: `t${run}-over`,
      }),
    /below zero/i
  );
  check(
    "…and the accounts that COULD afford it were left alone",
    (await cash(bob.id)) === bobBefore,
    `${formatTetri(bobBefore)} untouched — all-or-nothing held`
  );

  // ── preview / reset-all ─────────────────────────────────────────────────
  console.log("\npreviewResetAllUsers");

  const preview = await previewResetAllUsers();
  const adminBalanceBefore = await cash(admin.id);
  const botBalanceBefore = await cash(bot.id);
  check(
    "excludes admins and bots by default",
    !preview.includeAdmins && !preview.includeBots,
    `${preview.eligibleCount} eligible, ${preview.affectedCount} would move`
  );

  const eligibleUsers = await prisma.user.count({ where: { isBot: false, role: { not: "ADMIN" } } });
  check(
    "the eligible count matches the same query run by hand",
    preview.eligibleCount === eligibleUsers,
    `${preview.eligibleCount} vs ${eligibleUsers}`
  );

  const withAdmins = await previewResetAllUsers({ includeAdmins: true });
  const withBots = await previewResetAllUsers({ includeBots: true });
  check(
    "includeAdmins widens the set by exactly the admin count",
    withAdmins.eligibleCount === preview.eligibleCount + (await prisma.user.count({ where: { role: "ADMIN", isBot: false } }))
  );
  check(
    "includeBots widens the set by exactly the bot count",
    withBots.eligibleCount === preview.eligibleCount + (await prisma.user.count({ where: { isBot: true, role: { not: "ADMIN" } } }))
  );
  check(
    "affected + already-at-target accounts for every eligible account",
    preview.affectedCount + preview.alreadyAtTargetCount === preview.eligibleCount
  );
  check(
    "the cap it reports is the one the sweep enforces",
    preview.maxAccounts === BULK_BALANCE_MAX_ACCOUNTS && preview.overCap === preview.affectedCount > BULK_BALANCE_MAX_ACCOUNTS
  );

  console.log("\nresetAllUsersToSignupBalance");

  // The whole eligible set is about to move, so remember all of it.
  const eligible = await prisma.user.findMany({
    where: { isBot: false, role: { not: "ADMIN" } },
    select: { id: true },
  });
  const before = new Map<string, number>();
  for (const u of eligible) before.set(u.id, await cash(u.id));

  const swept = await resetAllUsersToSignupBalance({
    adminUsername: admin.username,
    reason: "tools/bulk-balance-test",
  });

  check(
    "the sweep's affected count matches the preview taken moments before",
    swept.affectedCount === preview.affectedCount,
    `${swept.affectedCount} accounts, ${formatTetri(swept.grossTetri)} moved`
  );
  check(
    "reports the total tetri moved, and it matches the snapshot arithmetic",
    swept.grossTetri ===
      [...before.values()].reduce((s, b) => s + Math.abs(SIGNUP_CREDIT_TETRI - b), 0),
    formatTetri(swept.grossTetri)
  );

  let allOnTarget = true;
  for (const u of eligible) if ((await cash(u.id)) !== SIGNUP_CREDIT_TETRI) allOnTarget = false;
  check("every eligible account is now on the signup grant", allOnTarget);

  check(
    "the admin's own balance was NOT touched",
    (await cash(admin.id)) === adminBalanceBefore,
    formatTetri(adminBalanceBefore)
  );
  check(
    "no bot balance was touched",
    (await cash(bot.id)) === botBalanceBefore,
    formatTetri(botBalanceBefore)
  );

  const sweepTx = await prisma.ledgerTransaction.findFirst({
    where: { idempotencyKey: { startsWith: "admin-reset-all:" } },
    orderBy: { createdAt: "desc" },
    include: { entries: true },
  });
  check(
    "the sweep is ONE balanced ledger transaction",
    !!sweepTx && sweepTx.entries.reduce((s, e) => s + e.amountTetri, 0) === 0,
    `${sweepTx?.entries.length} entries summing to 0`
  );
  check(
    "…kind ADJUSTMENT — machinery, not a discretionary operator movement",
    sweepTx?.kind === "ADJUSTMENT"
  );
  check(
    "…and it names the operator and the reason in the memo",
    !!sweepTx?.memo?.includes(admin.username) && !!sweepTx?.memo?.includes("bulk-balance-test")
  );

  const repeat = await resetAllUsersToSignupBalance({
    adminUsername: admin.username,
    reason: "tools/bulk-balance-test repeat",
  });
  check(
    "running it again with everyone on target is a clean no-op",
    repeat.affectedCount === 0 && !repeat.alreadyApplied,
    "no empty transaction was posted"
  );

  await refuses(
    "refuses a sweep with no reason",
    () => resetAllUsersToSignupBalance({ adminUsername: admin.username, reason: "" }),
    /reason is required/i
  );

  // ── restore ─────────────────────────────────────────────────────────────
  // Put every balance back where it was, through the ledger, in one balanced
  // posting. The database ends with more history and identical money.
  console.log("\nrestore");
  // The four accounts the earlier sections moved were also caught by the sweep,
  // so their pre-TEST balance is the snapshot taken at the top, not the one read
  // just before the sweep.
  for (const u of touched) before.set(u.id, snapshot.get(u.id)!);

  const entries = [];
  for (const [userId, wasTetri] of before) {
    const amountTetri = wasTetri - (await cash(userId));
    if (amountTetri !== 0) entries.push({ accountKey: AccountKeys.userCash(userId), amountTetri });
  }
  const net = entries.reduce((s, e) => s + e.amountTetri, 0);
  if (entries.length > 0) {
    await postTransaction({
      kind: "ADJUSTMENT",
      memo: "tools/bulk-balance-test — restoring pre-test balances",
      entries: net === 0 ? entries : [{ accountKey: AccountKeys.treasury(), amountTetri: -net }, ...entries],
    });
  }
  let restored = true;
  for (const [userId, wasTetri] of before) if ((await cash(userId)) !== wasTetri) restored = false;
  check("every balance this test disturbed is back where it started", restored);

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
})();
