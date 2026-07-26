/**
 * Proves the Championship prize structure pays exactly ₾80 / ₾50 / ₾30.
 *
 * Creates an event with the same shape as the live one — 32 seats, ₾5 entry,
 * prizes given in lari — fills it with bots, plays the whole bracket out
 * through the production driver, and then checks the actual ledger postings
 * against the advertised figures. Uses a short round window so five rounds plus
 * the third-place playoff finish in about a minute; nothing else differs.
 *
 *   npx tsx --env-file=.env tools/championship-payout-test.ts
 */
import {
  AccountKeys,
  advanceKnockout,
  driveBotMatches,
  fillTournamentWithBots,
  finalizeKnockout,
  generateKnockout,
  getBalanceTetri,
  prisma,
  sweepBotBalances,
} from "@gamearena/db";
import { formatTetri } from "@gamearena/shared";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const CAPACITY = 32;
const ENTRY_LARI = 5;
const PRIZES_LARI = [80, 50, 30];
const ROUND_S = 30;

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

(async () => {
  console.log(`\nCHAMPIONSHIP PAYOUT · ${CAPACITY} seats · ₾${ENTRY_LARI} · ${PRIZES_LARI.map((p) => "₾" + p).join(" / ")}\n`);
  const cookie = await adminCookie();

  // Created through the same admin endpoint the button uses.
  const created = await (
    await fetch(`${BASE}/api/admin/tournaments/create`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: `Championship payout check ${Date.now()}`,
        gameKey: "block-blast",
        capacity: CAPACITY,
        entryLari: ENTRY_LARI,
        prizesLari: PRIZES_LARI,
        roundDurationS: ROUND_S,
        readyWindowS: ROUND_S,
      }),
    })
  ).json();
  if (!created.id) throw new Error(`create failed: ${JSON.stringify(created)}`);

  const poolTetri = CAPACITY * ENTRY_LARI * 100;
  check("pool matches seats × entry", created.poolTetri === poolTetri, formatTetri(created.poolTetri));
  check("no rake — prizes consume the whole pool", created.rakeTetri === 0, `${created.rakeTetri} tetri`);

  // Created live (that is the path under test), but bot-filling a live event is
  // now refused — correctly, since it would hide it from players. Flag this one
  // as a test first: we are verifying settlement maths, not running an event.
  await prisma.tournament.update({ where: { id: created.id }, data: { isTest: true } });
  await fillTournamentWithBots(created.id, 1);
  await prisma.tournament.update({ where: { id: created.id }, data: { startsAt: new Date() } });
  const placed = await generateKnockout(created.id);
  check("32 players drawn into the bracket", placed === CAPACITY, `${placed} placed`);

  const rounds = await prisma.bracketMatch.aggregate({
    where: { tournamentId: created.id },
    _max: { round: true },
  });
  check("five rounds: 32 → 16 → 8 → 4 → 2 → champion", rounds._max.round === 5, `${rounds._max.round} rounds`);

  console.log("\n  playing it out…");
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    await driveBotMatches(created.id);
    await advanceKnockout(created.id);
    const t = await prisma.tournament.findUniqueOrThrow({
      where: { id: created.id },
      select: { status: true },
    });
    if (t.status === "FINISHED") break;
    await sleep(1200);
  }
  const settledT = await prisma.tournament.findUniqueOrThrow({ where: { id: created.id } });
  if (settledT.status !== "FINISHED") await finalizeKnockout(created.id);
  check("tournament finished", (await prisma.tournament.findUniqueOrThrow({ where: { id: created.id } })).status === "FINISHED");

  // Third-place playoff really ran.
  const top = rounds._max.round ?? 5;
  const bronze = await prisma.bracketMatch.findFirst({
    where: { tournamentId: created.id, round: top, slot: 1 },
  });
  check("third-place playoff was played", !!bronze?.winnerUserId, bronze ? bronze.status : "missing");

  // ── The figures that matter ──
  const prizeTx = await prisma.ledgerTransaction.findFirst({
    where: { kind: "TOURNAMENT_PRIZE", refId: created.id },
    include: { entries: { include: { account: true } } },
  });
  check("settlement posted", !!prizeTx);
  if (prizeTx) {
    const paid = prizeTx.entries
      .filter((e) => e.amountTetri > 0 && e.account.type === "USER_CASH")
      .map((e) => e.amountTetri)
      .sort((a, b) => b - a);
    console.log(`  paid out: ${paid.map((p) => formatTetri(p)).join(" · ")}`);

    check("1st place receives ₾80", paid[0] === 8000, formatTetri(paid[0] ?? 0));
    check("2nd place receives ₾50", paid[1] === 5000, formatTetri(paid[1] ?? 0));
    check("3rd place receives ₾30", paid[2] === 3000, formatTetri(paid[2] ?? 0));
    check("exactly three players are paid", paid.length === 3, `${paid.length} paid`);

    const sum = prizeTx.entries.reduce((n, e) => n + e.amountTetri, 0);
    check("settlement is zero-sum", sum === 0, `sums to ${sum}`);
    check(
      "prizes exactly consume the pool",
      paid.reduce((n, p) => n + p, 0) === poolTetri,
      `${formatTetri(paid.reduce((n, p) => n + p, 0))} of ${formatTetri(poolTetri)}`
    );
  }

  const escrow = await getBalanceTetri(prisma, AccountKeys.tournamentEscrow(created.id));
  check("escrow drained", escrow === 0, formatTetri(escrow));
  await sweepBotBalances(created.id);

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
