/**
 * The three bulk-balance routes over real HTTP: authorisation, status codes,
 * and the audit row every attempt is supposed to leave behind.
 *
 *   npx tsx --env-file=.env <this file>
 */
import { AccountKeys, getBalanceTetri, listAdminAudit, prisma, setExactBalance } from "@gamearena/db";
import { formatTetri, lariToTetri } from "@gamearena/shared";

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
  if (!c) throw new Error(`login failed for ${identifier}: ${res.status}`);
  return c.split(";")[0]!;
}

const post = (path: string, body: unknown, cookie?: string) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    // requireAdmin REDIRECTS rather than returning 403, and fetch follows
    // redirects by default — which reports the lobby's 200 and makes a refusal
    // look like a success.
    redirect: "manual",
  });

const get = (path: string, cookie?: string) =>
  fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });

const cash = (id: string) => getBalanceTetri(prisma, AccountKeys.userCash(id));

(async () => {
  console.log("\nBULK BALANCE ROUTES over HTTP\n");

  const admin = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  const players = await prisma.user.findMany({
    where: { isBot: false, role: "USER" },
    select: { id: true, username: true },
    take: 3,
  });
  const [p1, p2, p3] = players as [(typeof players)[0], (typeof players)[0], (typeof players)[0]];
  const bot = await prisma.user.findFirstOrThrow({ where: { isBot: true } });
  const snapshot = new Map<string, number>();
  for (const p of players) snapshot.set(p.id, await cash(p.id));

  const since = new Date();
  const run = Date.now();

  // ── unauthenticated ──
  console.log("unauthenticated");
  const anonSet = await post(`/api/admin/users/${p1.id}/set-balance`, {
    targetTetri: lariToTetri(500),
    reason: "should never happen",
  });
  const anonBulk = await post(`/api/admin/users/bulk-balance`, {
    userIds: [p1.id],
    amountTetri: 100,
    reason: "should never happen",
  });
  const anonReset = await post(`/api/admin/users/reset-all`, { reason: "should never happen" });
  const anonPreview = await get(`/api/admin/users/reset-all`);
  check("set-balance bounces", anonSet.status === 307 || anonSet.status === 302, `${anonSet.status}`);
  check("bulk-balance bounces", anonBulk.status === 307 || anonBulk.status === 302, `${anonBulk.status}`);
  check("reset-all bounces", anonReset.status === 307 || anonReset.status === 302, `${anonReset.status}`);
  check("the preview GET bounces too", anonPreview.status === 307 || anonPreview.status === 302, `${anonPreview.status}`);
  check("nothing moved", (await cash(p1.id)) === snapshot.get(p1.id));

  const cookie = await cookieFor("admin@gamearena.ge", "admin1234");

  // ── set-balance ──
  console.log("\nset-balance");
  const setRes = await post(
    `/api/admin/users/${p1.id}/set-balance`,
    { targetTetri: lariToTetri(17), reason: "http test", reference: `h${run}-1` },
    cookie
  );
  const setBody = await setRes.json();
  check("200 and the balance lands on the target", setRes.status === 200 && (await cash(p1.id)) === lariToTetri(17), setBody.message);

  const dupRes = await post(
    `/api/admin/users/${p1.id}/set-balance`,
    { targetTetri: lariToTetri(99), reason: "http test dup", reference: `h${run}-1` },
    cookie
  );
  const dupBody = await dupRes.json();
  check(
    "a reused reference reports the truth rather than claiming success",
    dupRes.status === 200 && dupBody.reachedTarget === false && (await cash(p1.id)) === lariToTetri(17),
    dupBody.message
  );

  const negRes = await post(
    `/api/admin/users/${p1.id}/set-balance`,
    { targetTetri: -5, reason: "http test neg" },
    cookie
  );
  check("a negative target is 400, not 500", negRes.status === 400, (await negRes.json()).error);

  const botRes = await post(
    `/api/admin/users/${bot.id}/set-balance`,
    { targetTetri: 100, reason: "http test bot" },
    cookie
  );
  check("a bot target is 400", botRes.status === 400, (await botRes.json()).error);

  // ── bulk-balance ──
  console.log("\nbulk-balance");
  const bulkRes = await post(
    `/api/admin/users/bulk-balance`,
    { userIds: [p2.id, p3.id], amountTetri: lariToTetri(3), reason: "http test bulk", reference: `h${run}-b` },
    cookie
  );
  const bulkBody = await bulkRes.json();
  check(
    "200 and both accounts moved",
    bulkRes.status === 200 &&
      (await cash(p2.id)) === snapshot.get(p2.id)! + lariToTetri(3) &&
      (await cash(p3.id)) === snapshot.get(p3.id)! + lariToTetri(3),
    bulkBody.message
  );

  const bulkBotRes = await post(
    `/api/admin/users/bulk-balance`,
    { userIds: [p2.id, bot.id], amountTetri: 100, reason: "http test bulk bot" },
    cookie
  );
  check("a bot in the selection is 400, not 500", bulkBotRes.status === 400, (await bulkBotRes.json()).error?.slice(0, 70));

  const bulkEmptyRes = await post(
    `/api/admin/users/bulk-balance`,
    { userIds: [], amountTetri: 100, reason: "http test empty" },
    cookie
  );
  check("an empty selection is 400", bulkEmptyRes.status === 400, (await bulkEmptyRes.json()).error);

  // ── reset-all preview ──
  console.log("\nreset-all");
  const prevRes = await get(`/api/admin/users/reset-all`, cookie);
  const prevBody = await prevRes.json();
  check(
    "the preview returns real numbers and moves nothing",
    prevRes.status === 200 && typeof prevBody.preview?.affectedCount === "number",
    prevBody.message
  );
  const p1Held = await cash(p1.id);
  check("…the preview really is read-only", p1Held === lariToTetri(17), formatTetri(p1Held));

  const prevAdmins = await get(`/api/admin/users/reset-all?includeAdmins=true`, cookie);
  const prevAdminsBody = await prevAdmins.json();
  check(
    "includeAdmins=true widens the set",
    prevAdminsBody.preview.eligibleCount > prevBody.preview.eligibleCount,
    `${prevBody.preview.eligibleCount} → ${prevAdminsBody.preview.eligibleCount}`
  );
  const prevFalse = await get(`/api/admin/users/reset-all?includeAdmins=false`, cookie);
  check(
    'the string "false" does not read as true',
    (await prevFalse.json()).preview.eligibleCount === prevBody.preview.eligibleCount
  );

  const noReason = await post(`/api/admin/users/reset-all`, { includeBots: false }, cookie);
  check("a sweep with no reason is 400", noReason.status === 400, (await noReason.json()).error);

  // ── audit trail ──
  console.log("\naudit trail");
  const page = await listAdminAudit({ limit: 200 });
  const mine = page.entries.filter((e) => e.createdAt >= since);
  const byAction = (a: string) => mine.filter((e) => e.action === a);
  check(
    "every authenticated attempt left a row",
    byAction("user.balance.set-exact").length === 4 &&
      byAction("user.balance.bulk-adjust").length === 3 &&
      byAction("user.balance.reset-all").length === 1,
    `${byAction("user.balance.set-exact").length} set-exact, ${byAction("user.balance.bulk-adjust").length} bulk, ${byAction("user.balance.reset-all").length} reset-all`
  );
  check(
    "the unauthenticated attempts left none",
    mine.length === 8,
    `${mine.length} rows total, all by ${[...new Set(mine.map((e) => e.adminUsername))].join(",")}`
  );
  // The bot refusal specifically. It is the case where NO ledger transaction
  // exists, so this row is the only surviving record of who somebody tried to
  // pay — which is exactly why the handler records the id list before it runs
  // the operation rather than after.
  const refused = byAction("user.balance.bulk-adjust").find(
    (e) => e.outcome === "error" && e.errorMessage?.includes("bot")
  );
  check(
    "a refused batch is logged as an error WITH the ids it was aimed at",
    !!refused && Array.isArray((refused.metadata as { userIds?: unknown })?.userIds),
    refused?.errorMessage?.slice(0, 60)
  );
  // A malformed body is refused by Zod before the handler runs, so it logs the
  // attempt without a target list. That is the correct trade: the ids never
  // reached a validated shape, and inventing them for the row would be worse.
  const malformed = byAction("user.balance.bulk-adjust").find(
    (e) => e.errorMessage === "Select at least one account."
  );
  check(
    "a body that never parsed still logs the attempt",
    !!malformed && malformed.outcome === "error",
    malformed?.errorMessage ?? ""
  );
  const okSet = byAction("user.balance.set-exact").find((e) => e.outcome === "ok" && e.targetId === p1.id);
  check(
    "a successful set-exact records the movement it actually made",
    typeof (okSet?.metadata as { deltaTetri?: unknown })?.deltaTetri === "number",
    JSON.stringify(okSet?.metadata).slice(0, 90)
  );

  // ── restore ──
  for (const p of players) {
    await setExactBalance(p.id, snapshot.get(p.id)!, "http test restore", admin.username, `h${run}-restore-${p.id}`);
  }
  let restored = true;
  for (const p of players) if ((await cash(p.id)) !== snapshot.get(p.id)) restored = false;
  console.log("\nrestore");
  check("balances put back", restored);

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
})();
