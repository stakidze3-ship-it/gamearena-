import { NextResponse } from "next/server";

/**
 * The one place that decides what an operations-layer failure looks like over
 * HTTP.
 *
 * The admin operations in @gamearena/db throw plain Errors whose messages are
 * written to be read by a human mid-incident — "This tournament is RUNNING;
 * that is only possible while it is SCHEDULED". The routes above them are
 * deliberately thin (authorise, parse, call one operation, serialise), so
 * without a shared classifier every one of them would either invent its own
 * status codes or flatten everything into a 500.
 *
 * That distinction matters more here than it usually does. A 500 tells the
 * console "something is broken", and an operator's response to that is to stop
 * and escalate. A 409 tells them "the event is not in a state where that is
 * possible", and their response is to do the other thing instead. Collapsing
 * the two would have an operator paging someone at 2am over a button they
 * pressed in the wrong order.
 *
 * Matching on message text is not elegant, and it is a deliberate trade: giving
 * every refusal in a written-and-tested operations layer its own error class is
 * a much larger change, and an unrecognised message falls through to 500, which
 * is the safe direction to fail in — a genuine bug is never dressed up as a
 * well-understood refusal.
 */

/** The thing being addressed does not exist. */
const NOT_FOUND: RegExp[] = [
  /\bnot found\b/i, // "Tournament not found", "Match not found"
  /^no such account/i,
];

/**
 * Understood, and refused because of the state of the world rather than
 * anything wrong with the request itself.
 */
const STATE_CONFLICT: RegExp[] = [
  /that is only possible while/i, // requireTournamentIn's status gate
  /already been drawn/i, // a bracket exists, so the field can no longer change
  /has no open match/i, // nothing to force this player through
  /only an open match/i, // force-finish and declare-winner status gates
  /resolved by the tournament itself/i, // lost the race with the scheduler
  /cannot advance on its own/i, // endTournamentNow could not converge
  /^cannot fill a/i, // fillTournamentWithBots' status gate
  /live, player-visible tournament/i, // the bot-fill live override, unacknowledged
];

/** The request itself was wrong — a different body would have worked. */
const BAD_REQUEST: RegExp[] = [
  /not in this match/i, // the named winner is not one of the two players
  /must be a whole number|must not be zero|capped at|reference is required/i,
  /would take the balance below zero/i,
];

const matches = (patterns: RegExp[], message: string) => patterns.some((p) => p.test(message));

export interface AdminOpsErrorOptions {
  /**
   * Machine-readable tag for the console, when the failure is one the UI has to
   * branch on rather than merely display.
   */
  code?: string;
  /** Shown when the thrown value is not an Error and so carries no message. */
  fallback?: string;
}

/**
 * Turn a thrown operations error into the response the console should see.
 *
 * Callers must keep `requireAdmin()` OUTSIDE the try block that feeds this.
 * requireAdmin redirects rather than returning, and Next signals a redirect by
 * throwing — catching that and handing it here would turn "you are not an
 * admin, go to the lobby" into a 500 and hide the auth failure completely.
 */
export function adminOpsErrorResponse(
  err: unknown,
  options: AdminOpsErrorOptions = {}
): NextResponse {
  const message =
    err instanceof Error && err.message
      ? err.message
      : (options.fallback ?? "That operation failed.");

  const status = matches(NOT_FOUND, message)
    ? 404
    : matches(STATE_CONFLICT, message)
      ? 409
      : matches(BAD_REQUEST, message)
        ? 400
        : 500;

  if (status === 500) {
    // Only the unrecognised ones are logged. A refused button press is normal
    // operation and logging it would bury the failures that are not.
    console.error("[admin] unclassified operation failure:", err);
  }

  return NextResponse.json(
    { error: message, ...(options.code ? { code: options.code } : {}) },
    { status }
  );
}

/**
 * Read a JSON body that may legitimately be absent.
 *
 * Several console buttons take no arguments and post nothing at all, so
 * `req.json()` rejects on an empty body. Treating that as `{}` lets one Zod
 * schema of optional fields serve both the bare press and the parameterised
 * one, instead of every no-argument route hand-rolling the same guard.
 */
export async function readJsonBody(req: Request): Promise<unknown> {
  return (await req.json().catch(() => null)) ?? {};
}
