import { NextResponse, type NextRequest } from "next/server";
import {
  prisma,
  recordAdminAction,
  type AdminAuditTargetType,
  type RecordAdminActionInput,
  type User,
} from "@gamearena/db";
import { requireAdmin } from "./auth";
import { clientIp } from "./client-ip";

/**
 * The wrapper every mutating admin route puts itself inside, so that logging
 * cannot be forgotten.
 *
 * The alternative — each route calling requireAdmin(), doing its work, and
 * remembering to write an audit row on every exit path — fails the same way
 * every time it is tried: the success path gets logged, the early `return
 * NextResponse.json({ error }, { status: 400 })` three lines up does not, and
 * the trail is missing exactly the refused attempts an incident is looking for.
 * There are fifteen of these routes and more coming; "remember to log" is not a
 * control.
 *
 * Here logging is structural. The wrapper owns the response, so every way out
 * of the handler — a 200, an early 4xx, a thrown error — passes through one
 * place that writes the row.
 *
 * It also enforces the house rule about authorisation on behalf of the routes:
 * requireAdmin() runs FIRST, before params are awaited and before the body is
 * read, and OUTSIDE the try block. That ordering is not stylistic. requireAdmin
 * signals "not an admin, go to the lobby" by throwing a redirect, and a try
 * block around it would catch that redirect and serve a 500 instead of the
 * redirect — turning a working auth failure into a mystery.
 *
 * ─────────────────────────── USAGE ───────────────────────────
 *
 *   export const dynamic = "force-dynamic";
 *
 *   export const POST = withAdminAudit<{ id: string }>(
 *     { action: "user.balance.adjust", targetType: "user", targetIdParam: "id" },
 *     async ({ req, admin, params, audit }) => {
 *       // `admin` is the authorised operator; `params` is already awaited.
 *       const { id } = params;
 *
 *       const parsed = schema.safeParse(await req.json().catch(() => null));
 *       if (!parsed.success) {
 *         // Logged as outcome "error" without any extra work — the wrapper
 *         // reads the status and the `error` field off this response.
 *         return NextResponse.json({ error: "…" }, { status: 400 });
 *       }
 *
 *       const target = await prisma.user.findUnique({ where: { id } });
 *       audit.label(target.username);              // denormalised target name
 *       audit.reason(parsed.data.reason);          // operator's justification
 *       audit.meta({ amountTetri: parsed.data.amountTetri });
 *
 *       return NextResponse.json({ ok: true, … });  // logged as outcome "ok"
 *     }
 *   );
 *
 * Every `audit.*` call is optional and order does not matter: the row is only
 * written once the handler has returned, so late refinements still land.
 *
 * The route's parameter shape is passed EXPLICITLY — `withAdminAudit<{ id: string }>`
 * — because TypeScript has nothing to infer it from, and the fallback index
 * signature would hand the handler `string | undefined` for every parameter
 * under this project's noUncheckedIndexedAccess. A route with no dynamic
 * segment omits the generic entirely and ignores `params`.
 * ─────────────────────────────────────────────────────────────
 */

/** The handful of facts a route can add to its own audit row while it runs. */
export interface AdminAuditRecorder {
  /**
   * Rename the action after the fact, for routes whose verb depends on the
   * body — "user.freeze" versus "user.unfreeze" from one endpoint. Two names
   * are worth having because the console filters on the action prefix, and
   * "show me every ban" should not also return every unban.
   */
  action(action: string): void;
  /** Set the target explicitly, when it is not a route parameter. */
  target(targetId: string | null, label?: string | null): void;
  /**
   * The target's human-readable name, copied into the row so the log still
   * reads true after a rename or a deletion.
   */
  label(label: string | null | undefined): void;
  /** The operator's stated justification, where the operation collects one. */
  reason(reason: string | null | undefined): void;
  /**
   * Merge operation-specific detail into the row: amounts in tetri,
   * idempotency references, counts. NEVER credentials or session tokens — more
   * people read this table than can reach the database.
   */
  meta(patch: Record<string, unknown>): void;
}

/** What the wrapper hands the route once the caller is known to be an admin. */
export interface AdminAuditHandlerArgs<P> {
  req: NextRequest;
  /** The authorised operator, straight from the session. Never from the body. */
  admin: User;
  /** Route parameters, already awaited. `{}` on routes with no dynamic segment. */
  params: P;
  audit: AdminAuditRecorder;
}

export interface AdminAuditRouteConfig<P> {
  /**
   * Dotted verb naming the operation, e.g. "tournament.cancel". Keep the
   * "<subject>.<thing>.<verb>" shape — the console filters on the prefix.
   */
  action: string;
  targetType?: AdminAuditTargetType;
  /**
   * Which route parameter holds the target id, so the common case needs no code
   * in the handler at all. `audit.target()` overrides it where the target is in
   * the body instead (remove-player, declare-winner, wallet-credit).
   */
  targetIdParam?: keyof P & string;
}

/**
 * The second argument Next hands a route handler.
 *
 * NOT optional, and that is load-bearing rather than tidy. Next type-checks
 * every route export at build time against its own
 * `{ params: Promise<SegmentParams> }`, and it rejects a handler whose second
 * parameter is declared `ctx?:` with "Expected RouteContext, got RouteContext |
 * undefined" — `tsc -b` never sees this, because the check lives in the
 * generated .next/types, so the failure only appears at `next build` and takes
 * down every route wrapped here at once.
 *
 * Next passes the context to static and dynamic routes alike (a route with no
 * dynamic segment gets a params promise that resolves to `{}`), so requiring it
 * costs the no-segment routes nothing. The body below still reads it
 * defensively, because a direct unit-test call has no reason to construct one.
 */
type RouteContext<P> = { params: Promise<P> };

/**
 * Next signals redirect() and notFound() by throwing a tagged error rather than
 * returning. Those are control flow, not failures: recording "the operator's
 * action errored" when they were merely bounced to the login page would fill
 * the trail with events that never happened. Detected by the `digest` tag Next
 * documents on these errors, and always re-thrown untouched so the framework
 * still gets to act on them.
 */
function isNextControlFlow(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("digest" in err)) return false;
  const digest = (err as { digest?: unknown }).digest;
  return (
    typeof digest === "string" &&
    (digest.startsWith("NEXT_REDIRECT") || digest === "NEXT_NOT_FOUND")
  );
}

/**
 * Pull the message the operator actually saw off a 4xx/5xx response.
 *
 * Best effort and non-fatal: the row is worth writing even without it. The
 * response is cloned rather than read, because the original body still has to
 * reach the browser — reading it here would hand the console an empty reply.
 */
async function errorMessageOf(res: NextResponse): Promise<string | null> {
  try {
    const body = (await res.clone().json()) as { error?: unknown };
    return typeof body?.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * Wrap an admin route handler so that authorisation and audit logging both
 * happen whether or not the route remembers them.
 *
 * The returned function is the Next route handler; export it directly as POST.
 */
export function withAdminAudit<P extends Record<string, string> = Record<string, string>>(
  config: AdminAuditRouteConfig<P>,
  handler: (args: AdminAuditHandlerArgs<P>) => Promise<NextResponse>
): (req: NextRequest, ctx: RouteContext<P>) => Promise<NextResponse> {
  return async (req: NextRequest, ctx: RouteContext<P>) => {
    // FIRST, and outside every try below. requireAdmin redirects by throwing,
    // and that throw must escape this function untouched.
    const admin = await requireAdmin();

    // Only now is it safe to look at what was asked for.
    const params = ((await ctx?.params) ?? {}) as P;

    // Filled in as the handler runs; read once it has returned, so a fact
    // discovered late — the target's name, the amount that was actually
    // moved — still reaches the row.
    const row: RecordAdminActionInput = {
      adminUserId: admin.id,
      adminUsername: admin.username,
      action: config.action,
      targetType: config.targetType ?? null,
      targetId: config.targetIdParam ? (params[config.targetIdParam] ?? null) : null,
      ip: clientIp(req),
    };
    let meta: Record<string, unknown> | null = null;

    const audit: AdminAuditRecorder = {
      action: (action) => {
        row.action = action;
      },
      target: (targetId, label) => {
        row.targetId = targetId;
        if (label !== undefined) row.targetLabel = label;
      },
      label: (label) => {
        row.targetLabel = label ?? null;
      },
      reason: (reason) => {
        row.reason = reason ?? null;
      },
      meta: (patch) => {
        meta = { ...(meta ?? {}), ...patch };
      },
    };

    const write = async (outcome: "ok" | "error", errorMessage: string | null) => {
      await recordAdminAction({
        ...row,
        // Cast because Prisma's InputJsonValue does not accept `unknown` values,
        // and the alternative — forcing every caller to pre-serialise — would
        // make `audit.meta({ amountTetri })` awkward enough to skip.
        metadata: meta as RecordAdminActionInput["metadata"],
        outcome,
        errorMessage,
      });
    };

    let res: NextResponse;
    try {
      res = await handler({ req, admin, params, audit });
    } catch (err) {
      if (isNextControlFlow(err)) throw err;
      // The attempt happened and failed, so it is logged before the failure is
      // allowed to propagate — an unhandled 500 is precisely the event nobody
      // should have to reconstruct from memory afterwards.
      await write("error", err instanceof Error ? err.message : String(err));
      throw err;
    }

    // A 4xx is an attempt too. Most refusals in this console are deliberate
    // guards firing, and "who kept trying to do the thing the guard stops" is
    // the pattern an audit trail exists to make visible.
    const failed = res.status >= 400;
    await write(failed ? "error" : "ok", failed ? await errorMessageOf(res) : null);

    return res;
  };
}

/**
 * Put a tournament's name on the audit row.
 *
 * The name is worth one extra read because the row has to survive the thing it
 * describes. A cancelled event can be purged later, and "tournament
 * clx7f2k9m0001" tells an operator reading the trail next quarter nothing at
 * all, while "Friday Night ₾5 Knockout" tells them everything.
 *
 * Called for its side effect only, and it never throws or returns a decision:
 * an unknown id leaves the label unset and the route carries on to produce its
 * own 404 exactly as it did before. A label lookup must never be the reason an
 * operation behaves differently.
 */
export async function auditTournamentLabel(
  audit: AdminAuditRecorder,
  tournamentId: string
): Promise<void> {
  try {
    const t = await prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { name: true },
    });
    if (t) audit.label(t.name);
  } catch {
    // Best effort. The row is still worth writing without a name.
  }
}

/**
 * Put a bracket match's tournament and position on the audit row.
 *
 * A bare match id is the least readable target in the console, and matches are
 * deleted wholesale by a bracket reset — so unless the position is copied in
 * now, a forced result becomes unattributable the moment someone redraws.
 *
 * Same contract as auditTournamentLabel: side effect only, never throws, never
 * changes what the route returns.
 */
export async function auditBracketMatchLabel(
  audit: AdminAuditRecorder,
  bracketMatchId: string
): Promise<void> {
  try {
    const m = await prisma.bracketMatch.findUnique({
      where: { id: bracketMatchId },
      select: { round: true, slot: true, tournament: { select: { name: true } } },
    });
    if (m) audit.label(`${m.tournament.name} · round ${m.round}, slot ${m.slot}`);
  } catch {
    // Best effort.
  }
}
