import { NextResponse } from "next/server";
import { adminOpsErrorResponse } from "./admin-ops-http";

/**
 * How a refused access change is reported to the console.
 *
 * setAccountFrozen has one refusal of its own: it will not suspend the last
 * active admin, because doing so locks the platform out of its own console
 * permanently. That is a state conflict — the platform is in a state where the
 * action is not possible — but the shared classifier in admin-ops-http.ts does
 * not recognise the message, and its fallback is 500.
 *
 * A refusal reported as a server fault is the specific harm that file exists to
 * prevent: an operator sees "something is broken", escalates, and pages someone
 * at 2am over a button they were correctly stopped from pressing. So the one
 * message it does not know is matched here, and everything else is delegated
 * unchanged.
 *
 * The pattern's proper home is that file's STATE_CONFLICT table. It lives here
 * only to avoid two authors editing the same table at the same time; folding it
 * in and deleting this file is a clean follow-up.
 */
export function accountStateErrorResponse(err: unknown): NextResponse {
  if (err instanceof Error && /last active admin/i.test(err.message)) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  return adminOpsErrorResponse(err, { fallback: "Could not change the account state." });
}
