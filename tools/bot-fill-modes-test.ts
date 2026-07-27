/**
 * Bot fill must work on live tournaments without hiding them.
 *
 * The old behaviour coupled two unrelated things: seating bots set isTest, and
 * isTest hides an event from every player. So filling a real tournament would
 * have silently deleted it from the Tournaments page, and the only defence was
 * to forbid filling live events at all — which left an operator unable to test
 * the thing they most needed to test.
 *
 * This pins the new contract: provenance is recorded, visibility is untouched,
 * and a live fill cannot happen by accident.
 *
 *   npx tsx --env-file=.env tools/bot-fill-modes-test.ts
 */
import {
  AccountKeys,
  fillTournamentWithBots,
  getBalanceTetri,
  prisma,
  removeBotsFromTournament,
  removePlayerFromTournament,
  resetTournament,
} from "@gamearena/db";
import { AWAITING_PLAYERS_AT } from "@gamearena/shared";
import { KNOCKOUT_CONFIG as CFG } from "@gamearena/shared";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function makeTournament(isTest: boolean, capacity = 4) {
  const game = await prisma.game.findFirstOrThrow({ where: { key: "block-blast" } });
  return prisma.tournament.create({
    data: {
      name: `${isTest ? "Test" : "Live"} fill check ${Date.now()}`,
      gameId: game.id,
      entryTetri: 500,
      prizeStructure: CFG.prizeStructure as unknown as object[],
      guaranteeTetri: 0,
      startsAt: new Date("2099-01-01T00:00:00.000Z"),
      capacity,
      format: "KNOCKOUT",
      roundDurationS: 60,
      readyWindowS: 60,
      durationS: game.durationS,
      isTest,
    },
  });
}

(async () => {
  console.log("\nBOT FILL MODES\n");

  // ── A test event fills with no ceremony ──
  const test = await makeTournament(true);
  const testFill = await fillTournamentWithBots(test.id, { countdownS: 60 });
  check("a test event fills without an override", testFill.seated > 0, `${testFill.seated} seated`);
  check("  and reports mode 'test'", testFill.mode === "test", testFill.mode);
  const testAfter = await prisma.tournament.findUniqueOrThrow({ where: { id: test.id } });
  check("  it stays a test event", testAfter.isTest === true);
  check("  provenance is stamped", testAfter.botsSeated === testFill.seated && !!testAfter.botFilledAt,
    `botsSeated=${testAfter.botsSeated}`);

  // ── A live event REFUSES without acknowledgement ──
  const live = await makeTournament(false);
  let threw = false;
  let message = "";
  try {
    await fillTournamentWithBots(live.id, { countdownS: 60 });
  } catch (e) {
    threw = true;
    message = e instanceof Error ? e.message : String(e);
  }
  check("a live event refuses an unacknowledged fill", threw);
  check("  and the message explains why", /live/i.test(message) && /confirm|override/i.test(message),
    message.slice(0, 80));
  const untouched = await prisma.tournament.findUniqueOrThrow({ where: { id: live.id } });
  check("  nothing was seated", await prisma.tournamentEntry.count({ where: { tournamentId: live.id } }) === 0);
  check("  and it is still visible", untouched.isTest === false);

  // ── A live event fills WITH acknowledgement, and stays visible ──
  const liveFill = await fillTournamentWithBots(live.id, {
    countdownS: 60,
    acknowledgeLive: true,
  });
  check("a live event fills once acknowledged", liveFill.seated > 0, `${liveFill.seated} seated`);
  check("  and reports mode 'live-override'", liveFill.mode === "live-override", liveFill.mode);

  const liveAfter = await prisma.tournament.findUniqueOrThrow({ where: { id: live.id } });
  // THE POINT OF THE WHOLE CHANGE:
  check("  the tournament is STILL VISIBLE (isTest false)", liveAfter.isTest === false);
  check("  it is stamped as bot-filled for audit", !!liveAfter.botFilledAt);
  check("  with the bot count recorded", liveAfter.botsSeated === liveFill.seated,
    `${liveAfter.botsSeated}`);

  // It must still be listed where players look.
  const visible = await prisma.tournament.count({
    where: { id: live.id, isTest: false, status: { in: ["SCHEDULED", "RUNNING"] } },
  });
  check("  and it still appears in the players' listing query", visible === 1);

  // ── Bots can be removed again, with their entry fees refunded ──
  const removed = await removeBotsFromTournament(live.id);
  check("bots can be removed", removed.removed === liveFill.seated, `${removed.removed} removed`);
  check("  and their entry fees came back out of escrow", removed.refundedTetri > 0,
    `${removed.refundedTetri} tetri`);
  const stillThere = await prisma.tournamentEntry.count({ where: { tournamentId: live.id } });
  check("  leaving no bot entries", stillThere === 0);

  // ── Refilling a partly-emptied field must not mint money into a void ──
  //
  // ensureBotUsers returns the OLDEST bots every time. Once one already holds a
  // seat, the old loop funded it again, got `alreadyEntered`, counted a seat it
  // never filled, and stranded the fee. Every further click repeated it.
  const refill = await makeTournament(true, 4);
  await fillTournamentWithBots(refill.id, { countdownS: 60 });
  const seatedBots = await prisma.tournamentEntry.findMany({
    where: { tournamentId: refill.id },
    select: { userId: true },
  });
  await removePlayerFromTournament(refill.id, seatedBots[0]!.userId);

  const treasuryBefore = await getBalanceTetri(prisma, AccountKeys.treasury());
  const second = await fillTournamentWithBots(refill.id, { countdownS: 60 });
  const seatsNow = await prisma.tournamentEntry.count({ where: { tournamentId: refill.id } });
  const treasuryAfter = await getBalanceTetri(prisma, AccountKeys.treasury());

  check("a partial refill actually fills the empty seat", seatsNow === 4, `${seatsNow}/4`);
  check("  and reports only the seats it really took", second.seated === 1, `${second.seated}`);
  check(
    "  minting exactly one entry fee, not one per already-seated bot",
    treasuryBefore - treasuryAfter <= 500,
    `treasury moved ${treasuryBefore - treasuryAfter} tetri`
  );
  const stranded = await prisma.tournamentEntry.findMany({
    where: { tournamentId: refill.id },
    select: { userId: true },
  });
  let strandedTetri = 0;
  for (const e of stranded) {
    strandedTetri += await getBalanceTetri(prisma, AccountKeys.userCash(e.userId));
  }
  check("  leaving no unspent credit in seated bots' wallets", strandedTetri === 0,
    `${strandedTetri} tetri`);

  // ── Removing a single bot returns its fee to treasury, not its own wallet ──
  const victim = stranded[0]!.userId;
  const beforeT = await getBalanceTetri(prisma, AccountKeys.treasury());
  const removedOne = await removePlayerFromTournament(refill.id, victim);
  const victimBalance = await getBalanceTetri(prisma, AccountKeys.userCash(victim));
  const afterT = await getBalanceTetri(prisma, AccountKeys.treasury());
  check("removing a bot refunds to treasury", removedOne.refundedTo === "treasury",
    String(removedOne.refundedTo));
  check("  the bot is left holding nothing", victimBalance === 0, `${victimBalance}`);
  check("  and treasury got the fee back", afterT - beforeT === removedOne.refundedTetri,
    `${afterT - beforeT} tetri`);

  // ── Resetting a FULL field must not park it on the 2099 sentinel ──
  //
  // The draw is triggered by a join and a full tournament refuses joins, so the
  // sentinel would strand it forever — and the lobby keeper stops at the oldest
  // full SCHEDULED knockout, freezing registration platform-wide.
  const fullEvent = await makeTournament(true, 4);
  await fillTournamentWithBots(fullEvent.id, { countdownS: 60 });
  await prisma.tournament.update({
    where: { id: fullEvent.id },
    data: { status: "RUNNING", bracketStartedAt: new Date() },
  });
  await resetTournament(fullEvent.id);
  const afterReset = await prisma.tournament.findUniqueOrThrow({ where: { id: fullEvent.id } });
  check("a reset FULL field gets a real countdown, not the 2099 sentinel",
    afterReset.startsAt.getTime() !== AWAITING_PLAYERS_AT.getTime(),
    afterReset.startsAt.toISOString());
  check("  and its entries survive the reset",
    (await prisma.tournamentEntry.count({ where: { tournamentId: fullEvent.id } })) === 4);

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
