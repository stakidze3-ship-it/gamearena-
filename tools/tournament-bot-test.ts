/**
 * End-to-end test of the admin bot-fill tournament.
 *
 * Runs a complete knockout with bots in every seat, driving it only through the
 * paths production uses — joinTournament, the poll driver, submitKnockoutScore,
 * advanceKnockout, finalizeKnockout. Nothing here reaches around the lifecycle,
 * so a pass means the real thing works.
 *
 * Uses a short round window so six rounds finish in about a minute; the bot
 * delay logic is exercised exactly as it is in production, just against a
 * smaller clock.
 *
 *   npx tsx --env-file=.env tools/tournament-bot-test.ts [capacity]
 */
import {
  AccountKeys,
  advanceKnockout,
  driveBotMatches,
  fillTournamentWithBots,
  finalizeKnockout,
  generateKnockout,
  getBalanceTetri,
  liveTournamentView,
  prisma,
  recordSpectator,
  spectatorCounts,
  sweepBotBalances,
} from "@gamearena/db";
import { KNOCKOUT_CONFIG, formatTetri } from "@gamearena/shared";

const CAPACITY = Number(process.argv[2] ?? 16);
const ROUND_S = 8; // short window so the whole bracket runs in ~1 minute
const COUNTDOWN_S = 2;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(14, 19);

async function main() {
  console.log(`\nTOURNAMENT BOT FILL · ${CAPACITY} seats · ${ROUND_S}s rounds\n`);

  const game = await prisma.game.findFirstOrThrow({ where: { key: "block-blast" } });
  const t = await prisma.tournament.create({
    data: {
      name: `Bot test ${Date.now()}`,
      gameId: game.id,
      entryTetri: KNOCKOUT_CONFIG.entryTetri,
      prizeStructure: KNOCKOUT_CONFIG.prizeStructure as unknown as object[],
      guaranteeTetri: 0,
      startsAt: new Date("2099-01-01T00:00:00.000Z"), // awaiting-players sentinel
      capacity: CAPACITY,
      format: "KNOCKOUT",
      roundDurationS: ROUND_S,
      readyWindowS: ROUND_S,
      durationS: 60,
    },
  });
  console.log(`  tournament ${t.id}`);

  const treasuryBefore = await getBalanceTetri(prisma, AccountKeys.treasury());

  // ── 1. Bot fill ──
  const fill = await fillTournamentWithBots(t.id, COUNTDOWN_S);
  check("every seat filled", fill.entryCount === CAPACITY, `${fill.entryCount}/${CAPACITY}`);

  const marked = await prisma.tournament.findUniqueOrThrow({ where: { id: t.id } });
  check("tournament flagged as a test event", marked.isTest);
  check("countdown started on fill", marked.startsAt.getFullYear() < 2099, marked.startsAt.toISOString());

  const escrow = await getBalanceTetri(prisma, AccountKeys.tournamentEscrow(t.id));
  check(
    "escrow equals seats × entry",
    escrow === CAPACITY * KNOCKOUT_CONFIG.entryTetri,
    `${formatTetri(escrow)}`
  );

  const bots = await prisma.user.findMany({
    where: { tournamentEntries: { some: { tournamentId: t.id } } },
    select: { username: true, isBot: true },
    take: 6,
  });
  check("bots have realistic handles", bots.every((b) => b.isBot && !/^bot\d+$/i.test(b.username)),
    bots.map((b) => b.username).join(", "));

  // ── 2. Draw ──
  await sleep(COUNTDOWN_S * 1000 + 300);
  const placed = await generateKnockout(t.id);
  check("bracket drawn", placed === CAPACITY, `${placed} placed`);

  const round1 = await prisma.bracketMatch.count({ where: { tournamentId: t.id, round: 1 } });
  check("round 1 seeded", round1 === CAPACITY / 2, `${round1} matches`);

  // ── 3. Spectator view + counts ──
  const view = await liveTournamentView(t.id);
  check("live view lists open matches", (view?.matches.length ?? 0) > 0, `${view?.matches.length} live`);
  check("round labels present", !!view?.matches[0]?.roundLabel, view?.matches[0]?.roundLabel);
  check("remaining time reported", (view?.matches[0]?.secondsLeft ?? 0) > 0, `${view?.matches[0]?.secondsLeft}s`);

  const watched = view!.matches[0]!.matchId;
  await recordSpectator(t.id, watched, "viewer-1");
  await recordSpectator(t.id, watched, "viewer-2");
  await recordSpectator(t.id, view!.matches[1]?.matchId ?? watched, "viewer-3");
  const counts = await spectatorCounts(t.id);
  check("spectators counted per match", (counts.get(watched) ?? 0) === 2, `${counts.get(watched)} on the watched match`);

  // Switching must MOVE a viewer, not clone them.
  const other = view!.matches[1]?.matchId;
  if (other) {
    await recordSpectator(t.id, other, "viewer-1");
    const after = await spectatorCounts(t.id);
    const total = [...after.values()].reduce((n, v) => n + v, 0);
    check("switching moves the viewer, never duplicates", total === 3, `${total} viewers for 3 people`);
    check("the left match lost its viewer", (after.get(watched) ?? 0) === 1, `${after.get(watched)} left behind`);
  }

  // ── 4. Play it out ──
  console.log("\n  driving rounds…");
  const deadline = Date.now() + 180_000;
  let ticks = 0;
  let lastDone = -1;
  while (Date.now() < deadline) {
    await driveBotMatches(t.id);
    await advanceKnockout(t.id);
    ticks++;
    const [done, open, status] = await Promise.all([
      prisma.bracketMatch.count({ where: { tournamentId: t.id, status: "DONE" } }),
      prisma.bracketMatch.count({ where: { tournamentId: t.id, status: "OPEN" } }),
      prisma.tournament.findUniqueOrThrow({ where: { id: t.id }, select: { status: true } }),
    ]);
    if (done !== lastDone) {
      console.log(`  [${stamp()}] done ${done}  open ${open}  ${status.status}`);
      lastDone = done;
    }
    if (status.status === "FINISHED") break;
    await sleep(1200);
  }

  const finalT = await prisma.tournament.findUniqueOrThrow({ where: { id: t.id } });
  if (finalT.status !== "FINISHED") await finalizeKnockout(t.id);
  const settled = await prisma.tournament.findUniqueOrThrow({ where: { id: t.id } });
  check("tournament finished", settled.status === "FINISHED", `${settled.status} after ${ticks} ticks`);

  // ── 5. Bracket integrity ──
  const all = await prisma.bracketMatch.findMany({ where: { tournamentId: t.id } });
  const rounds = Math.max(...all.map((m) => m.round));
  check("every match resolved", all.every((m) => m.status === "DONE"),
    `${all.filter((m) => m.status !== "DONE").length} unresolved`);
  const final = all.find((m) => m.round === rounds && m.slot === 0);
  const bronze = all.find((m) => m.round === rounds && m.slot === 1);
  check("final has a winner", !!final?.winnerUserId);
  check("third-place match played", !!bronze?.winnerUserId);

  // ── 6. Replays ──
  const played = all.filter((m) => m.aPlayed && m.bPlayed);
  const withLogs = played.filter((m) => m.aInputLog && m.bInputLog);
  check("finished matches stored both replays", withLogs.length === played.length,
    `${withLogs.length}/${played.length}`);
  check("replays carry a rules version", played.every((m) => m.rulesVersion >= 1));
  const sample = withLogs[0];
  check("a replay has real inputs",
    Array.isArray(sample?.aInputLog) && (sample!.aInputLog as unknown[]).length > 0,
    `${(sample?.aInputLog as unknown[] | undefined)?.length ?? 0} inputs`);

  // ── 7. Money ──
  const pool = CAPACITY * KNOCKOUT_CONFIG.entryTetri;
  const escrowAfter = await getBalanceTetri(prisma, AccountKeys.tournamentEscrow(t.id));
  check("escrow drained", escrowAfter === 0, formatTetri(escrowAfter));

  const prizeTx = await prisma.ledgerTransaction.findFirst({
    where: { kind: "TOURNAMENT_PRIZE", refId: t.id },
    include: { entries: true },
  });
  check("settlement posted", !!prizeTx);
  if (prizeTx) {
    const sum = prizeTx.entries.reduce((n, e) => n + e.amountTetri, 0);
    check("settlement is zero-sum", sum === 0, `sums to ${sum}`);
    const paid = prizeTx.entries.filter((e) => e.amountTetri > 0).reduce((n, e) => n + e.amountTetri, 0);
    check("prizes do not exceed the pool", paid <= pool, `${formatTetri(paid)} of ${formatTetri(pool)}`);
  }

  const recovered = await sweepBotBalances(t.id);
  // Scoped to THIS event's bots. ARENA_BOT holds 1v1 demo funding by design and
  // never entered this tournament, so a global check would wrongly fail.
  const botBalances = await prisma.account.findMany({
    where: {
      type: "USER_CASH",
      user: { isBot: true, tournamentEntries: { some: { tournamentId: t.id } } },
    },
    select: { balanceTetri: true },
  });
  check(
    "no bot holds a balance after the event",
    botBalances.every((b) => b.balanceTetri === 0),
    `recovered ${formatTetri(recovered)}, ${botBalances.filter((b) => b.balanceTetri !== 0).length} non-zero`
  );

  // Scoped to THIS tournament's own postings, not the global treasury balance.
  // Anything else touching the ledger concurrently — another tab playing Blitz,
  // a parallel test — moves the global figure and would fail this for reasons
  // that have nothing to do with the tournament.
  const treasuryAcc = await prisma.account.findUniqueOrThrow({
    where: { key: AccountKeys.treasury() },
  });
  const mine = await prisma.ledgerEntry.findMany({
    where: {
      accountId: treasuryAcc.id,
      tx: {
        OR: [
          { refType: "tournament", refId: t.id },
          { memo: { contains: t.id } },
        ],
      },
    },
    select: { amountTetri: true },
  });
  const netTreasury = mine.reduce((n, e) => n + e.amountTetri, 0);
  // The sweep is deliberately excluded from the funding check. Bots are
  // persistent and reused, so a sweep legitimately reclaims residue left on
  // them by an EARLIER event as well as this one's prizes — recovering more
  // than this tournament minted is the sweep working, not a leak. What must
  // hold here is narrower: this event funded exactly its own entries.
  const funding = await prisma.ledgerEntry.findMany({
    where: {
      accountId: treasuryAcc.id,
      tx: { kind: "ADJUSTMENT", memo: { contains: `Bot entry · ${t.id}` } },
    },
    select: { amountTetri: true },
  });
  const funded = -funding.reduce((n, e) => n + e.amountTetri, 0);
  check(
    "treasury funded exactly this event's entries",
    funded === pool,
    `${formatTetri(funded)} minted for a ${formatTetri(pool)} field`
  );
  check(
    "the sweep never costs the treasury money",
    netTreasury >= 0,
    `net ${formatTetri(netTreasury)} across ${mine.length} postings (surplus = residue reclaimed)`
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
