"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TBody, THead, Td, Th, Tr } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { Note, Panel, useAdminAction } from "../admin-primitives";

/**
 * The admin audit trail, read back.
 *
 * The trail was write-only until this screen existed: every wrapped route fed
 * it and nothing ever displayed a row. This is the only section of the console
 * that answers "what happened?" after the fact, and unlike every other tab it
 * is read by someone who already suspects something went wrong.
 *
 * That reader is the reason for three commitments here:
 *
 *   1. AN EMPTY RESULT NEVER LOOKS LIKE AN ANSWER. Coverage is incomplete —
 *      only routes wrapped in withAdminAudit write rows, and the wrapper is
 *      still being retrofitted across the console. "No rows" therefore means
 *      "nothing was recorded", which is a strictly weaker claim than "nothing
 *      happened", and the gap between those two sentences is the whole harm
 *      this panel exists to prevent. The caveat is pinned above the results and
 *      restated inside every empty state, because the operator who most needs
 *      it is the one skimming at 3am.
 *   2. REFUSED ATTEMPTS ARE AS VISIBLE AS SUCCESSFUL ONES. "Who tried to move
 *      ₾5,000 and was stopped" is the question an incident actually asks, and a
 *      trail that renders failures in the same grey as everything else answers
 *      it with a wall the eye slides off.
 *   3. THE SCREEN NEVER OVERSTATES ITS OWN REACH. The free-text box filters the
 *      rows already loaded, not the database, and it says so directly under the
 *      input — an operator who types a username, sees nothing and concludes
 *      that operator did nothing has been misled by their own tool.
 *
 * Nothing here mutates, and reading the trail deliberately writes no row of its
 * own: the endpoint behind this screen is not wrapped in withAdminAudit, so
 * paging through six pages of history does not push the evidence off the top of
 * the list with six fresh entries about the investigation.
 */

/** One row exactly as /api/admin/audit serves it. Dates arrive as JSON strings. */
interface AuditEntry {
  id: string;
  createdAt: string;
  adminUserId: string;
  adminUsername: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  reason: string | null;
  metadata: unknown;
  ip: string | null;
  outcome: string;
  errorMessage: string | null;
}

/** The filters the SERVER applies. Free text is not among them — see `search`. */
interface AppliedFilters {
  action: string | null;
  adminUserId: string | null;
  targetId: string | null;
  limit: number;
}

/**
 * The action families offered in the picker.
 *
 * Listed because they are the console's domains, NOT because every one of them
 * is wired to the audit wrapper — at the time of writing only the `user.*`
 * family writes rows at all, and the rest are being retrofitted. Selecting a
 * family with no coverage yet returns an empty page that means "not wired",
 * which is emphatically not "never happened". Offering them anyway is the right
 * call: the picker stays correct as the retrofit lands without anyone
 * remembering to edit this list, and the caveat below the results already tells
 * the operator how to read an empty one.
 *
 * Values are PREFIXES, because listAdminAudit matches on startsWith — "user."
 * pulls the whole family, "user.ban" narrows to one operation.
 */
const ACTION_FAMILIES: { value: string; label: string }[] = [
  { value: "", label: "All actions" },
  { value: "user.", label: "Users — everything (user.*)" },
  { value: "user.balance.", label: "Users — balance adjustments" },
  { value: "user.wallet.", label: "Users — wallet credits" },
  { value: "user.ban", label: "Users — bans" },
  { value: "user.freeze", label: "Users — freezes" },
  { value: "tournament.", label: "Tournaments (tournament.*)" },
  { value: "match.", label: "Matches (match.*)" },
  { value: "review.", label: "Review queue (review.*)" },
  { value: "config.", label: "Configuration (config.*)" },
  { value: "content.", label: "Announcements (content.*)" },
  { value: "liveops.", label: "Liveops (liveops.*)" },
  // Someone granting themselves the ability to move every balance on the
  // platform is the single most audit-worthy event there is, so it gets its own
  // filter rather than being buried under a broader family.
  { value: "admin.", label: "Admin role granted (admin.*)" },
];

/**
 * The caveat shown when the server has not supplied its own.
 *
 * The endpoint ships the authoritative wording in its payload, so the console
 * cannot drift from the truth of what the trail covers. But a failed or
 * in-flight request would otherwise render this panel with no caveat at all,
 * and "could not load" sitting above an empty table with nothing qualifying it
 * is the single most misleading state this screen can reach. So there is always
 * a caveat, even when there is nothing else.
 */
const FALLBACK_CAVEAT =
  "Coverage is not complete. This trail only contains actions taken through admin routes that " +
  "are wired to the audit wrapper, the wrapper is still being retrofitted, and a row can fail " +
  "to write without failing the operation it describes. Anything done directly against the " +
  "database or by a script never appears here at all. THE ABSENCE OF A ROW IS NOT EVIDENCE " +
  "THAT AN ACTION DID NOT HAPPEN — corroborate against the ledger and the deployment logs.";

const fieldClass =
  "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg outline-none focus:border-gold";

/**
 * Timestamps are UTC, matching the server log and the ledger explorer rather
 * than the operator's own clock.
 *
 * An investigation cross-references this trail against deployment logs stamped
 * in UTC, and rendering local time here would mean an action logged at
 * "26 Jul 23:30" appearing under a different date than the exception it caused
 * — correct in two timezones at once and impossible to reconcile.
 */
function formatUtcDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    year: "2-digit",
  });
}

function formatUtcTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Render metadata for the expanded panel.
 *
 * Wrapped because the column is typed `unknown` and a row written by an older
 * build can hold anything at all — including a value with a cycle in it, which
 * would throw out of JSON.stringify and take the whole console down with it
 * mid-incident. A row that cannot be pretty-printed still says more than a
 * blank screen, so the raw value is shown instead of nothing.
 */
function formatMetadata(metadata: unknown): string {
  try {
    return JSON.stringify(metadata, null, 2) ?? String(metadata);
  } catch {
    return String(metadata);
  }
}

/**
 * Does this row match the operator's free text?
 *
 * Deliberately spans the operator, the target and the stated reason, because
 * the person typing does not know which field holds the word they remember —
 * "kutaisi_kid" could be the admin who acted or the player acted upon, and
 * making them pick the right column first is making them already know the
 * answer.
 */
function matchesSearch(entry: AuditEntry, needle: string): boolean {
  const haystack = [
    entry.adminUsername,
    entry.action,
    entry.targetLabel,
    entry.targetId,
    entry.targetType,
    entry.reason,
    entry.ip,
    entry.errorMessage,
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ")
    .toLowerCase();

  return haystack.includes(needle);
}

export function AuditSection() {
  const { busy, note, run } = useAdminAction();

  /**
   * The filters the SERVER runs. Every one of them is set by a discrete
   * control — a picker, or a click on a row — never by typing, so there is no
   * need for the draft/applied split the ledger explorer carries. A select
   * fires once; a search box fires on every keystroke, and that is the only
   * reason that screen needs two copies of its filter state.
   */
  const [action, setAction] = useState("");
  const [adminUserId, setAdminUserId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);

  /**
   * Free text, applied IN THE BROWSER over the rows already fetched.
   *
   * listAdminAudit has no text search — it filters on an exact admin id, an
   * exact target id and an action prefix, and nothing else. Rather than pretend
   * otherwise, this narrows what is on screen and says so under the input. The
   * distinction matters enormously: a server-side search that returns nothing
   * means the trail holds nothing, while this returning nothing only means the
   * fifty rows currently loaded hold nothing.
   */
  const [search, setSearch] = useState("");

  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [applied, setApplied] = useState<AppliedFilters | null>(null);
  const [caveat, setCaveat] = useState<string | null>(null);

  /**
   * Which rows the operator has opened. Keyed by row id rather than by index,
   * so appending a page cannot re-point an expansion at whichever entry happens
   * to land in that slot — an audit screen showing one row's metadata under
   * another row's heading would be worse than showing none.
   */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (action) params.set("action", action);
    if (adminUserId) params.set("adminUserId", adminUserId);
    if (targetId) params.set("targetId", targetId);
    return params.toString();
  }, [action, adminUserId, targetId]);

  /**
   * Fetch a page. `append` distinguishes "Load more" from a fresh filter:
   * appending keeps the rows already read, so paging deeper into history does
   * not throw away what the operator has already scrolled past.
   */
  const load = useCallback(
    async (nextCursor: string | null, append: boolean) => {
      const params = new URLSearchParams(query);
      if (nextCursor) params.set("cursor", nextCursor);

      const res = await run(
        append ? "more" : "load",
        `/api/admin/audit?${params.toString()}`,
        undefined,
        "GET"
      );
      if (!res.ok) return;

      const data = res.data as unknown as {
        entries?: AuditEntry[];
        nextCursor?: string | null;
        appliedFilters?: AppliedFilters;
        caveat?: string;
      };
      const entries = data.entries ?? [];

      setRows((prev) => (append && prev ? [...prev, ...entries] : entries));
      setCursor(data.nextCursor ?? null);
      setApplied(data.appliedFilters ?? null);
      if (typeof data.caveat === "string") setCaveat(data.caveat);
    },
    [query, run]
  );

  // Runs on mount and again whenever the server-side filters change, since
  // `query` is the only thing `load` closes over. Changing a filter is
  // therefore the single trigger for a refetch, with no second effect to keep
  // in step with the first.
  useEffect(() => {
    void load(null, false);
  }, [load]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /**
   * Drill down to one operator, one target or one exact action.
   *
   * These reset the cursor implicitly by going through the same state that
   * `query` is built from, so a narrowed filter always starts from the newest
   * matching row rather than resuming from a cursor that belonged to the
   * previous, wider result set — which would silently skip everything between
   * the top of the trail and wherever the old page happened to stop.
   */
  const filterToAdmin = useCallback((entry: AuditEntry) => {
    setAdminUserId(entry.adminUserId);
  }, []);

  const filterToTarget = useCallback((entry: AuditEntry) => {
    if (entry.targetId) setTargetId(entry.targetId);
  }, []);

  const clearAll = useCallback(() => {
    setAction("");
    setAdminUserId(null);
    setTargetId(null);
    setSearch("");
  }, []);

  const needle = search.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!rows) return null;
    if (!needle) return rows;
    return rows.filter((entry) => matchesSearch(entry, needle));
  }, [rows, needle]);

  /** How many of the loaded rows are refusals — the number an incident wants. */
  const failedCount = useMemo(
    () => (visible ?? []).filter((e) => e.outcome === "error").length,
    [visible]
  );

  const hasServerFilter = Boolean(action || adminUserId || targetId);

  return (
    <div className="space-y-4">
      <Panel
        title="Admin audit trail"
        hint="Every recorded admin action, newest first — who did what, to whom, and whether it worked."
        right={
          <Button
            size="sm"
            variant="ghost"
            loading={busy === "load"}
            onClick={() => load(null, false)}
          >
            Refresh
          </Button>
        }
      >
        {/*
          THE CAVEAT, PINNED ABOVE THE RESULTS AND NEVER CONDITIONAL.
          *
          * Same reasoning as the error-buffer note on the System tab: the panel
          * cannot state a limitation it has not been told about, so the wording
          * comes from the endpoint and falls back to a local copy when the
          * request has not landed. It sits above the table rather than under it
          * because an operator who scrolls a long result set to the bottom has
          * already drawn their conclusion by the time they get there.
        */}
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-100">
          <span className="font-medium">This trail is not a complete record.</span>{" "}
          {caveat ?? FALLBACK_CAVEAT}
        </div>

        {/* Failures only. These panels only READ, and useAdminAction reports
            every success — so an unconditional banner would park a permanent
            green "Done." under the heading, which on a console where green
            means "your money operation succeeded" teaches the operator to
            ignore the colour. */}
        {note && !note.ok && <Note note={note} />}

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-muted">
            Action family
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className={`mt-1 ${fieldClass}`}
            >
              {ACTION_FAMILIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-2xs text-faint">
              Matched as a prefix, so a family returns everything beneath it.
            </span>
          </label>

          <label className="text-xs text-muted">
            Find admin or target
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="username, target, reason, IP…"
              className={`mt-1 ${fieldClass}`}
            />
            {/*
              The scope of this box, stated where it is used rather than in a
              help page nobody opens. An operator who types a name, sees an
              empty table and concludes that operator did nothing has been
              misled by their own tool — the box only ever sees rows already
              pulled from the server.
            */}
            <span className="mt-1 block text-2xs text-faint">
              Filters the {rows?.length ?? 0} row{rows?.length === 1 ? "" : "s"} loaded below, not
              the whole trail. Load more to widen it.
            </span>
          </label>
        </div>

        {/*
          The filters actually in force, echoed back by the server rather than
          rendered from local state. Local state is the one version of the truth
          that cannot be wrong about what the query did, which is precisely why
          it must not be the version on screen.
        */}
        {(hasServerFilter || needle) && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-2xs uppercase tracking-wider text-faint">Filtered by</span>

            {applied?.action && (
              <FilterChip label={`action ${applied.action}*`} onClear={() => setAction("")} />
            )}
            {applied?.adminUserId && (
              <FilterChip
                label={`admin ${applied.adminUserId.slice(-8).toUpperCase()}`}
                onClear={() => setAdminUserId(null)}
              />
            )}
            {applied?.targetId && (
              <FilterChip
                label={`target ${applied.targetId.slice(-8).toUpperCase()}`}
                onClear={() => setTargetId(null)}
              />
            )}
            {needle && (
              <FilterChip label={`text “${search.trim()}”`} onClear={() => setSearch("")} />
            )}

            <button
              type="button"
              onClick={clearAll}
              className="text-2xs uppercase tracking-wider text-faint hover:text-gold"
            >
              clear all
            </button>
          </div>
        )}
      </Panel>

      <Panel
        title="Recorded actions"
        hint={
          visible === null
            ? undefined
            : `${visible.length} shown${
                needle && rows ? ` of ${rows.length} loaded` : ""
              }${cursor ? " — more available" : ""}${
                failedCount > 0
                  ? ` · ${failedCount} refused or failed`
                  : ""
              }.`
        }
      >
        {visible === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : visible.length === 0 ? (
          /*
            THE EMPTY STATE IS WHERE THE HARM HAPPENS.
            *
            * "No rows" and "nothing happened" are different sentences, and an
            * operator conflating them during an investigation reaches a
            * conclusion the data does not support. So this state never says
            * "nothing found" and stops — it says what was actually searched,
            * and what that search could not have seen.
          */
          <div className="rounded-xl border border-border bg-bg px-4 py-6 text-center">
            <p className="text-sm text-muted">
              No recorded actions match {hasServerFilter || needle ? "these filters" : "this view"}.
            </p>
            <p className="mx-auto mt-2 max-w-xl text-xs leading-relaxed text-faint">
              That means nothing was <span className="text-muted">recorded</span> — which is a
              weaker statement than nothing having happened. An action taken through a route not
              yet wired to the audit wrapper, an action whose row failed to write, and an action
              performed directly against the database all look exactly like this.
              {needle && (
                <>
                  {" "}
                  This view is also narrowed by your text filter, which only sees the{" "}
                  {rows?.length ?? 0} row{rows?.length === 1 ? "" : "s"} loaded so far.
                </>
              )}
            </p>
          </div>
        ) : (
          <>
            {/*
              The scroll container is the table's own, never the page body. The
              shared <Table> primitive is not used here for exactly that reason:
              its shell is overflow-hidden, which would clip these columns on a
              phone rather than let them scroll. The cell primitives underneath
              are the shared ones, so the styling still matches every other
              table in the product.
            */}
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[960px] text-sm">
                <THead>
                  <Tr>
                    <Th className="whitespace-nowrap">When (UTC)</Th>
                    <Th>Admin</Th>
                    <Th>Action</Th>
                    <Th>Target</Th>
                    <Th>Reason</Th>
                    <Th>Outcome</Th>
                    <Th className="w-px" />
                  </Tr>
                </THead>
                <TBody>
                  {visible.map((entry) => {
                    const failed = entry.outcome === "error";
                    const isOpen = expanded.has(entry.id);
                    const hasDetail =
                      (entry.metadata !== null && entry.metadata !== undefined) ||
                      Boolean(entry.errorMessage);

                    return [
                      /*
                        Refusals are tinted AMBER, not red. Red is reserved for
                        money leaving an account, and — more to the point — most
                        failures in this trail are a guard firing correctly
                        rather than a system fault. "Operator tried to move
                        ₾5,000 and was stopped" is the console working, and
                        painting it the same colour as a crash would teach an
                        investigator to read every blocked attempt as an outage.
                        Amber is the console's existing "look closer" colour and
                        that is exactly the instruction here.
                      */
                      <Tr key={entry.id} className={cn(failed && "bg-amber-500/5")}>
                        <Td className="whitespace-nowrap align-top text-xs text-muted">
                          <div className="tnum">{formatUtcDate(entry.createdAt)}</div>
                          <div className="tnum text-faint">{formatUtcTime(entry.createdAt)}</div>
                        </Td>

                        {/* The operator and where they acted from. The IP lives
                            with the admin rather than in a column of its own
                            because it is a property of the person, and an
                            eighth column would push the table wider for a value
                            that is usually read only once a name looks wrong. */}
                        <Td className="align-top">
                          <button
                            type="button"
                            onClick={() => filterToAdmin(entry)}
                            className="text-left text-fg hover:text-gold"
                            title="Show only this operator's actions"
                          >
                            {entry.adminUsername}
                          </button>
                          <div className="tnum text-2xs text-faint">{entry.ip ?? "ip unknown"}</div>
                        </Td>

                        <Td className="align-top">
                          <button
                            type="button"
                            onClick={() => setAction(entry.action)}
                            className="text-left font-mono text-xs text-fg-secondary hover:text-gold"
                            title="Show only this action"
                          >
                            {entry.action}
                          </button>
                        </Td>

                        {/* The denormalised label first, because it is the only
                            part of the target that still reads true after a
                            rename or a deletion. The id is kept beneath it in
                            faint text for cross-referencing against the ledger. */}
                        <Td className="align-top">
                          {entry.targetLabel ? (
                            <div className="max-w-[16rem] truncate text-fg-secondary">
                              {entry.targetLabel}
                            </div>
                          ) : (
                            <div className="text-faint">—</div>
                          )}
                          {entry.targetId && (
                            <button
                              type="button"
                              onClick={() => filterToTarget(entry)}
                              className="tnum text-2xs text-faint hover:text-gold"
                              title="Show everything ever done to this target"
                            >
                              {entry.targetType ?? "target"}{" "}
                              {entry.targetId.slice(-8).toUpperCase()}
                            </button>
                          )}
                        </Td>

                        <Td className="align-top text-xs text-muted">
                          {entry.reason ? (
                            <span className="block max-w-[18rem]">{entry.reason}</span>
                          ) : (
                            <span className="text-faint">no reason given</span>
                          )}
                        </Td>

                        <Td className="align-top">
                          <Badge tone={failed ? "amber" : "muted"}>
                            {failed ? "refused" : "ok"}
                          </Badge>
                          {/* The message the operator actually saw, so a
                              refusal explains itself without an expansion. */}
                          {failed && entry.errorMessage && (
                            <p className="mt-1 max-w-[16rem] text-2xs leading-snug text-amber-200/90">
                              {entry.errorMessage}
                            </p>
                          )}
                        </Td>

                        <Td className="align-top text-right">
                          {hasDetail ? (
                            <button
                              type="button"
                              onClick={() => toggleExpanded(entry.id)}
                              aria-expanded={isOpen}
                              className="whitespace-nowrap text-2xs uppercase tracking-wider text-faint hover:text-gold"
                            >
                              {isOpen ? "hide" : "details"}
                            </button>
                          ) : (
                            /* No button when there is nothing behind it — an
                               expander that opens onto an empty box teaches the
                               operator that expanding is not worth doing. */
                            <span className="text-2xs text-faint">—</span>
                          )}
                        </Td>
                      </Tr>,

                      isOpen ? (
                        <Tr key={`${entry.id}-detail`} className={cn(failed && "bg-amber-500/5")}>
                          <Td colSpan={7} className="align-top">
                            <div className="space-y-2 text-xs">
                              {entry.errorMessage && (
                                <div>
                                  <div className="text-2xs uppercase tracking-wider text-faint">
                                    Error message
                                  </div>
                                  <p className="mt-0.5 text-amber-200/90">{entry.errorMessage}</p>
                                </div>
                              )}

                              <div>
                                <div className="text-2xs uppercase tracking-wider text-faint">
                                  Metadata
                                </div>
                                {entry.metadata === null || entry.metadata === undefined ? (
                                  <p className="mt-0.5 text-faint">
                                    None recorded. The route logged no operation-specific detail.
                                  </p>
                                ) : (
                                  /* Its own scroll container: a long
                                     idempotency reference must not widen the
                                     table it sits inside. */
                                  <pre className="mt-0.5 max-h-64 overflow-auto rounded-lg border border-border bg-bg px-3 py-2 font-mono text-2xs leading-relaxed text-fg-secondary">
                                    {formatMetadata(entry.metadata)}
                                  </pre>
                                )}
                              </div>

                              {/* The full identifiers, unabbreviated. This is
                                  the row an investigator copies out to
                                  cross-reference against the ledger, and a
                                  truncated id cannot be pasted into anything. */}
                              <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-faint">
                                <span className="tnum">entry {entry.id}</span>
                                <span className="tnum">admin {entry.adminUserId}</span>
                                {entry.targetId && (
                                  <span className="tnum">
                                    {entry.targetType ?? "target"} {entry.targetId}
                                  </span>
                                )}
                              </div>
                            </div>
                          </Td>
                        </Tr>
                      ) : null,
                    ];
                  })}
                </TBody>
              </table>
            </div>

            {cursor && (
              <div className="mt-3 flex justify-center">
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === "more"}
                  onClick={() => load(cursor, true)}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

/** One active filter, with the means to remove it. */
function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-2xs text-fg-secondary">
      <span className="tnum">{label}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Remove filter ${label}`}
        className="text-faint hover:text-gold"
      >
        ×
      </button>
    </span>
  );
}
