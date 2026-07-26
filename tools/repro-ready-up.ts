/**
 * Put a real account one click away from the Ready Up crash.
 *
 * Reproducing this by hand means filling a 32-seat tournament, which is why it
 * reached production in the first place: the state that breaks is expensive to
 * reach. This builds it in a few seconds — a small bracket, one human, bots in
 * every other seat, drawn and waiting — and prints the URL to open.
 *
 * Run it against a PRODUCTION build (next build && next start), not the dev
 * server. The failure is a React invariant that reports as a readable sentence
 * in development and as a bare error code in production, and it is the
 * production form that has to be diagnosable.
 *
 *   npx tsx --env-file=.env tools/repro-ready-up.ts [seats]
 */
import { fillTournamentWithBots, generateKnockout, prisma } from "@gamearena/db";
import { KNOCKOUT_CONFIG as CFG } from "@gamearena/shared";

const SEATS = Number(process.argv[2] ?? 8);
const WHO = process.env.REPRO_USER ?? "tamar@demo.ge";

(async () => {
  const me = await prisma.user.findFirstOrThrow({ where: { email: WHO } });
  const game = await prisma.game.findFirstOrThrow({ where: { key: "block-blast" } });

  const t = await prisma.tournament.create({
    data: {
      name: `Ready Up repro ${new Date().toISOString().slice(11, 19)}`,
      gameId: game.id,
      entryTetri: 0, // free: the crash is a render bug, money is not part of it
      prizeStructure: CFG.prizeStructure as unknown as object[],
      guaranteeTetri: 0,
      startsAt: new Date(),
      capacity: SEATS,
      format: "KNOCKOUT",
      roundDurationS: 120,
      readyWindowS: 600, // long, so the window cannot close mid-investigation
      durationS: game.durationS,
      isTest: true,
    },
  });

  await prisma.tournamentEntry.create({ data: { tournamentId: t.id, userId: me.id } });
  await fillTournamentWithBots(t.id, 1);
  const placed = await generateKnockout(t.id);

  const mine = await prisma.bracketMatch.findFirst({
    where: { tournamentId: t.id, round: 1, OR: [{ aUserId: me.id }, { bUserId: me.id }] },
  });

  console.log(`
  READY UP REPRO
    tournament   ${t.id}
    seats        ${placed}
    player       ${me.username} (${WHO})
    match        ${mine?.id ?? "NOT DRAWN"}  round ${mine?.round}  seed ${mine?.seed}

    open  http://127.0.0.1:3100/tournaments/${t.id}
    then click "Ready up & play"
`);
  process.exit(0);
})()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
