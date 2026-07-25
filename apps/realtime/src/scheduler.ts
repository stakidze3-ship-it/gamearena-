/**
 * Liveops scheduler — runs inside the always-on realtime service.
 *
 *   • Keeps exactly one knockout event open for registration. It is
 *     fill-triggered, not clock-triggered: registration stays open until the
 *     60th player joins, at which point the join itself sets `startsAt` to
 *     now + countdown and the start path below draws the bracket.
 *   • Drives every running knockout forward each tick: opens rounds, forfeits
 *     no-shows when a ready check expires, seats the third-place match, and
 *     crowns + pays the podium. (The web submit route and the tournament pages
 *     also advance a bracket, so the happy path never waits for a tick.)
 *   • Still auto-finalizes any legacy leaderboard tournament on window close.
 */
import {
  Prisma,
  prisma,
  finalizeTournament,
  tournamentEndsAt,
  generateKnockout,
  advanceKnockout,
  cancelKnockout,
} from "@gamearena/db";
import { AWAITING_PLAYERS_AT, KNOCKOUT_CONFIG, KNOCKOUT_ROUNDS } from "@gamearena/shared";

/** Prisma's Json input type rejects interface-typed arrays; the shape is JSON. */
const PRIZE_STRUCTURE = KNOCKOUT_CONFIG.prizeStructure as unknown as Prisma.InputJsonValue;

// A tick has to be quick enough to serve the 60s lobby countdown and the 3min
// ready checks without visibly lagging.
const TICK_MS = 5_000;

/** The event runs on the bracket's own clock; this is a display fallback. */
const NOMINAL_DURATION_S = KNOCKOUT_CONFIG.roundDurationS * KNOCKOUT_ROUNDS;

/**
 * Make sure exactly one event is open for registration, and that it matches the
 * published configuration. An event that is still filling gets normalised in
 * place, so a config change (seats, entry, prizes, windows) reaches the live
 * lobby without an operator touching the database.
 */
async function ensureOpenEvent(): Promise<void> {
  const game = await prisma.game.findFirst({ where: { key: "block-blast", enabled: true } });
  if (!game) return;

  // One at a time: never open registration while a bracket is being played.
  const live = await prisma.tournament.findFirst({
    where: { format: "KNOCKOUT", status: "RUNNING" },
    select: { id: true },
  });
  if (live) return;

  const open = await prisma.tournament.findFirst({
    where: { format: "KNOCKOUT", status: "SCHEDULED" },
    include: { _count: { select: { entries: true } } },
    orderBy: { createdAt: "asc" },
  });

  if (open) {
    // Leave a filled lobby alone — its countdown is already running.
    if (open._count.entries >= open.capacity) return;
    const needsSync =
      open.capacity !== KNOCKOUT_CONFIG.capacity ||
      open.entryTetri !== KNOCKOUT_CONFIG.entryTetri ||
      open.readyWindowS !== KNOCKOUT_CONFIG.readyWindowS ||
      open.roundDurationS !== KNOCKOUT_CONFIG.roundDurationS ||
      open.guaranteeTetri !== KNOCKOUT_CONFIG.guaranteeTetri ||
      open.startsAt.getTime() !== AWAITING_PLAYERS_AT.getTime();
    if (needsSync) {
      await prisma.tournament.update({
        where: { id: open.id },
        data: {
          name: KNOCKOUT_CONFIG.name,
          capacity: KNOCKOUT_CONFIG.capacity,
          entryTetri: KNOCKOUT_CONFIG.entryTetri,
          guaranteeTetri: KNOCKOUT_CONFIG.guaranteeTetri,
          prizeStructure: PRIZE_STRUCTURE,
          readyWindowS: KNOCKOUT_CONFIG.readyWindowS,
          roundDurationS: KNOCKOUT_CONFIG.roundDurationS,
          durationS: NOMINAL_DURATION_S,
          startsAt: AWAITING_PLAYERS_AT,
        },
      });
      console.log(`[scheduler] normalised open event ${open.id} to the published config`);
    }
    return;
  }

  await prisma.tournament.create({
    data: {
      name: KNOCKOUT_CONFIG.name,
      gameId: game.id,
      entryTetri: KNOCKOUT_CONFIG.entryTetri,
      guaranteeTetri: KNOCKOUT_CONFIG.guaranteeTetri,
      prizeStructure: PRIZE_STRUCTURE,
      capacity: KNOCKOUT_CONFIG.capacity,
      // Parked in the far future: the field filling is what starts this event.
      startsAt: AWAITING_PLAYERS_AT,
      durationS: NOMINAL_DURATION_S,
      format: "KNOCKOUT",
      roundDurationS: KNOCKOUT_CONFIG.roundDurationS,
      readyWindowS: KNOCKOUT_CONFIG.readyWindowS,
      status: "SCHEDULED",
      isRecurring: true,
    },
  });
  console.log(
    `[scheduler] opened registration — ${KNOCKOUT_CONFIG.name}, ${KNOCKOUT_CONFIG.capacity} seats`
  );
}

async function tick(): Promise<void> {
  try {
    await ensureOpenEvent();

    const now = new Date();

    // Draw any event whose countdown has run out.
    const starting = await prisma.tournament.findMany({
      where: { status: "SCHEDULED", startsAt: { lte: now } },
      select: { id: true, format: true },
    });
    for (const t of starting) {
      if (t.format === "KNOCKOUT") {
        const placed = await generateKnockout(t.id);
        if (placed === 0) await cancelKnockout(t.id); // nobody to play → refund
        else console.log(`[scheduler] bracket drawn for ${t.id} — ${placed} players`);
      } else {
        await prisma.tournament.update({ where: { id: t.id }, data: { status: "RUNNING" } });
      }
    }

    // Drive running knockouts; finalize leaderboards on window close.
    const running = await prisma.tournament.findMany({
      where: { status: "RUNNING" },
      select: { id: true, format: true, startsAt: true, durationS: true },
    });
    for (const t of running) {
      if (t.format === "KNOCKOUT") {
        await advanceKnockout(t.id);
      } else if (new Date() > tournamentEndsAt(t.startsAt, t.durationS)) {
        await finalizeTournament(t.id);
      }
    }
  } catch (err) {
    console.error("[scheduler] tick failed", err);
  }
}

export function startScheduler(): void {
  void tick();
  setInterval(() => void tick(), TICK_MS);
  console.log(
    `[scheduler] running — ${KNOCKOUT_CONFIG.name}: ` +
      `${KNOCKOUT_CONFIG.capacity} seats, starts when full, ` +
      `${KNOCKOUT_CONFIG.readyWindowS}s ready check`
  );
}
