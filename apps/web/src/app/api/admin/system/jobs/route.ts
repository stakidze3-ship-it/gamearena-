import { NextResponse } from "next/server";
import { listActiveMatches, prisma, systemSnapshot } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";

/**
 * Admin-only: the state of the platform's background work.
 *
 * THERE IS NO JOB QUEUE. Nothing in this system records that a job ran, when,
 * for how long, or whether it failed. What actually exists is:
 *
 *   · one 5-second tick inside the always-on realtime service
 *     (apps/realtime/src/scheduler.ts), which keeps a registration lobby open,
 *     draws brackets whose countdown has expired, and advances running
 *     knockouts; and
 *   · the same advancement running opportunistically from the web app whenever
 *     a player submits a run, so the happy path never waits for a tick.
 *
 * So this route does not report job runs — it cannot. It reports the EVIDENCE
 * those jobs leave in the database, and infers a state from it: a lobby that
 * exists, a bracket that was drawn, a match whose play window closed and was
 * never decided. That inference is the honest version of a status page, and
 * where it cannot know something it says so in `detail` rather than rendering a
 * confident green.
 *
 * The distinction matters in one direction especially: a healthy bracket does
 * NOT prove the scheduler is alive, because player submissions advance it too.
 * The realtime probe is the only direct evidence, and it is listed first.
 */
export const dynamic = "force-dynamic";

/**
 * How far past a deadline is still "the tick has not come round yet" rather
 * than "nothing is driving this". The scheduler ticks every 5s; six ticks of
 * slack keeps a busy moment from being reported as an outage.
 */
const GRACE_MS = 30_000;

type JobState = "healthy" | "idle" | "attention" | "stalled" | "unknown";

interface JobRow {
  name: string;
  state: JobState;
  detail: string;
  /**
   * The last time this job demonstrably DID something, read from what it left
   * behind — not a run timestamp, because none is recorded. Null when there is
   * no such evidence.
   */
  lastRunAt: string | null;
}

export async function GET() {
  await requireAdmin();

  const snapshot = await systemSnapshot();
  const now = Date.now();

  const realtimeJob: JobRow = {
    name: "Realtime service",
    state: !snapshot.realtime.configured ? "unknown" : snapshot.realtime.ok ? "healthy" : "stalled",
    detail: !snapshot.realtime.configured
      ? "NEXT_PUBLIC_REALTIME_URL is not set, so the scheduler's host is unknown and none of the state below can be attributed to it."
      : snapshot.realtime.ok
        ? `Answering /health at ${snapshot.realtime.url}. The scheduler runs inside this process.`
        : (snapshot.realtime.error ?? "Not answering its health check."),
    // Live probe, not a heartbeat: nothing records when the service last ticked.
    lastRunAt: null,
  };

  // Every job below is read out of the database. If the database is down there
  // is no evidence to read, and reporting "healthy" or "stalled" from a failed
  // query would be a guess dressed as a status.
  if (!snapshot.database.ok) {
    return NextResponse.json({
      ok: true,
      jobs: [
        realtimeJob,
        {
          name: "Open event keeper",
          state: "unknown" as JobState,
          detail: "The database is unreachable — job state cannot be read.",
          lastRunAt: null,
        },
        {
          name: "Bracket draw",
          state: "unknown" as JobState,
          detail: "The database is unreachable — job state cannot be read.",
          lastRunAt: null,
        },
        {
          name: "Knockout advancement",
          state: "unknown" as JobState,
          detail: "The database is unreachable — job state cannot be read.",
          lastRunAt: null,
        },
      ],
      note: "The database is not answering, so every state below the realtime probe is unknown rather than healthy.",
    });
  }

  const [openLobbies, runningKnockouts, overdueDraws, lastDrawn, lastDecided, activeMatches] =
    await Promise.all([
      prisma.tournament.findMany({
        where: { format: "KNOCKOUT", status: "SCHEDULED" },
        select: { id: true, createdAt: true, capacity: true, _count: { select: { entries: true } } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.tournament.count({ where: { format: "KNOCKOUT", status: "RUNNING" } }),
      // A lobby waiting to fill sits on a far-future sentinel start time, so it
      // never appears here; only an expired countdown does.
      prisma.tournament.findMany({
        where: { status: "SCHEDULED", startsAt: { lte: new Date(now - GRACE_MS) } },
        select: { id: true, name: true, startsAt: true },
        orderBy: { startsAt: "asc" },
        take: 5,
      }),
      prisma.tournament.findFirst({
        where: { bracketStartedAt: { not: null } },
        select: { bracketStartedAt: true },
        orderBy: { bracketStartedAt: "desc" },
      }),
      prisma.bracketMatch.findFirst({
        where: { finishedAt: { not: null } },
        select: { finishedAt: true },
        orderBy: { finishedAt: "desc" },
      }),
      // Reuses the ops layer's deadline arithmetic rather than recomputing which
      // window a round is on. If that rule ever changes, this page changes with
      // it instead of quietly disagreeing about what "overdue" means.
      listActiveMatches(),
    ]);

  // ── Open event keeper ──────────────────────────────────────────────────
  // The keeper holds off while a knockout is live, so "no lobby open" is
  // correct during an event and a problem the moment there is no event either.
  const lobby = openLobbies[0];
  const keeperJob: JobRow = {
    name: "Open event keeper",
    state:
      openLobbies.length > 1
        ? "attention"
        : lobby
          ? "healthy"
          : runningKnockouts > 0
            ? "idle"
            : "stalled",
    detail:
      openLobbies.length > 1
        ? `${openLobbies.length} lobbies are open at once — the keeper is meant to hold exactly one, so players are being split across events.`
        : lobby
          ? `Registration open, ${lobby._count.entries}/${lobby.capacity} seated. The event starts when the field fills, not on a clock.`
          : runningKnockouts > 0
            ? `Holding off while ${runningKnockouts} knockout${runningKnockouts === 1 ? " is" : "s are"} live — a new lobby opens when it finishes.`
            : "No lobby open and nothing running — nobody can join a tournament right now. This is what a stopped scheduler looks like.",
    // When the current lobby was created, which is the last time the keeper is
    // known to have acted. Not the last tick.
    lastRunAt: lobby?.createdAt.toISOString() ?? null,
  };

  // ── Bracket draw ───────────────────────────────────────────────────────
  const oldestOverdueDraw = overdueDraws[0];
  const drawJob: JobRow = {
    name: "Bracket draw",
    state: oldestOverdueDraw ? "stalled" : "healthy",
    detail: oldestOverdueDraw
      ? `${overdueDraws.length} event${overdueDraws.length === 1 ? "" : "s"} past their start time and still undrawn — oldest: "${oldestOverdueDraw.name}", due ${oldestOverdueDraw.startsAt.toISOString()}. Draw by hand from the Tournaments tab if the scheduler is down.`
      : "Nothing is waiting to be drawn.",
    lastRunAt: lastDrawn?.bracketStartedAt?.toISOString() ?? null,
  };

  // ── Knockout advancement ───────────────────────────────────────────────
  // Bracket matches only: duels are driven by their own socket room, not by the
  // scheduler, and mixing them in would attribute one's failure to the other.
  const bracketMatches = activeMatches.filter((match) => match.kind === "BRACKET");
  const overdue = bracketMatches.filter(
    (match) => match.closesAt !== null && match.closesAt.getTime() < now - GRACE_MS
  );
  // OPEN with no clock at all: the round was opened without a start time, so
  // nothing will ever expire it. It cannot resolve on its own.
  const clockless = bracketMatches.filter((match) => match.closesAt === null);

  const advanceJob: JobRow = {
    name: "Knockout advancement",
    state:
      overdue.length > 0
        ? "stalled"
        : clockless.length > 0
          ? "attention"
          : bracketMatches.length > 0
            ? "healthy"
            : "idle",
    detail:
      overdue.length > 0
        ? `${overdue.length} of ${bracketMatches.length} open match${bracketMatches.length === 1 ? "" : "es"} are past their play window and were never decided — the forfeit path is not running. Force them from the Matches tab.`
        : clockless.length > 0
          ? `${clockless.length} open match${clockless.length === 1 ? " has" : "es have"} no play window at all, so nothing will ever expire ${clockless.length === 1 ? "it" : "them"}. ${bracketMatches.length - clockless.length} other${bracketMatches.length - clockless.length === 1 ? "" : "s"} are on the clock.`
          : bracketMatches.length > 0
            ? `${bracketMatches.length} match${bracketMatches.length === 1 ? "" : "es"} in play, all inside their window.`
            : "No knockout is running — nothing to advance.",
    lastRunAt: lastDecided?.finishedAt?.toISOString() ?? null,
  };

  return NextResponse.json({
    ok: true,
    jobs: [realtimeJob, keeperJob, drawJob, advanceJob],
    note:
      "There is no job queue and no run history: nothing records when a job last ran, how long it took or whether it threw. " +
      "Every state above is inferred from what the work left in the database, and `lastRunAt` is the timestamp of the last " +
      "thing each job produced — not a tick. Bracket advancement also happens when a player submits a run, so a healthy " +
      "bracket does not on its own prove the scheduler is alive; the realtime probe is the only direct evidence of that.",
  });
}
