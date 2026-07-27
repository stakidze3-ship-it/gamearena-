"use client";

import { useCallback, useEffect, useState } from "react";
import { formatSignedTetri, formatTetri } from "@gamearena/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Note, Panel, Stat, useAdminAction } from "../admin-primitives";

interface Players {
  total: number;
  online: number;
  newToday: number | null;
  bots: number;
}

interface Activity {
  activeMatches: number;
  openBracketMatches: number;
  tournamentsRunning: number;
  tournamentsScheduled: number;
}

interface Money {
  entryFeesTetri: number;
  entryFeesTodayTetri: number;
  entryFeesFromBotsTetri: number;
  prizePayoutsTetri: number;
  prizePayoutsTodayTetri: number;
  prizePayoutsToBotsTetri: number;
  netFromPlayersTetri: number;
  platformProfitTetri: number;
  revenueTodayTetri: number;
}

interface Health {
  server: { ok: boolean; instanceUptimeS: number };
  database: { ok: boolean; latencyMs: number };
  realtime: { configured: boolean; url: string | null; ok: boolean | null; error: string | null };
}

interface ErrorEntry {
  at: string;
  message: string;
  route?: string;
  source?: string;
}

interface Dashboard {
  generatedAt: string;
  todayStartedAt: string;
  paymentsEnabled: boolean;
  players: Players | null;
  activity: Activity | null;
  money: Money | null;
  health: Health;
  degradedReason: string | null;
  errors: ErrorEntry[];
  errorsCaptured: number;
  errorsCaveat: string;
}

/**
 * How often the dashboard re-reads itself.
 *
 * Slower than the System tab's 15s health poll on purpose: this request runs
 * ledger aggregates rather than counts, and a tab that an operator leaves open
 * all day should not hammer the database to keep a number that changes every
 * few minutes looking fresh. The manual Refresh button covers the moment when
 * an operator needs to see the effect of something they just did.
 */
const REFRESH_MS = 20_000;

/** Every unknown renders as this, never as 0 — see the null handling below. */
const UNKNOWN = "—";

/**
 * Render an amount without ever losing a minus sign.
 *
 * formatTetri() formats the ABSOLUTE value, so handing it a negative prints it
 * as a positive. On this panel that would invert the meaning of a figure an
 * operator makes decisions from — "players are ₾50 up" rendered as "players are
 * ₾50 down" — so anything below zero goes through the signed formatter instead.
 *
 * This is not theoretical. The all-time totals cannot go negative, but the
 * daily deltas can: cancelling a tournament today refunds entries that were
 * sold yesterday, which makes today's entry-fee movement negative. And the net
 * position is two-sided by design, because a guaranteed prize pool can pay out
 * more than its entries brought in.
 *
 * Positives are left unprefixed so the common case stays quiet.
 */
const money = (tetri: number | undefined) =>
  tetri === undefined ? UNKNOWN : tetri < 0 ? formatSignedTetri(tetri) : formatTetri(tetri);

/**
 * The operations dashboard.
 *
 * The console's first tab, and the one an operator looks at before deciding
 * whether anything needs doing. Its whole value is that it can be trusted at a
 * glance, which imposes two rules the rest of this file follows.
 *
 * FIRST, A BLANK IS NOT A ZERO. When the API cannot read something it sends
 * null, and every readout here renders that as a dash. "0 active matches" is a
 * statement that the platform is idle; a dash says nobody knows. During an
 * incident those are opposite instructions, and rendering `?? 0` would quietly
 * turn one into the other.
 *
 * SECOND, THE MONEY IS LABELLED FOR WHAT IT IS. PAYMENTS_ENABLED is off, so
 * none of these amounts are real currency — they are demo credits the treasury
 * minted. "Revenue today: ₾420" read as earnings would be a genuinely
 * expensive misunderstanding, so the panel states the position in full rather
 * than relying on the reader to remember the season is a demo.
 */
export function DashboardSection() {
  const { busy, note, run } = useAdminAction();
  const [data, setData] = useState<Dashboard | null>(null);

  const load = useCallback(async () => {
    const res = await run("dashboard", "/api/admin/dashboard", undefined, "GET");
    if (res.ok) setData((res.data as unknown as Dashboard) ?? null);
  }, [run]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const players = data?.players ?? null;
  const activity = data?.activity ?? null;
  const m = data?.money ?? null;
  const health = data?.health ?? null;

  return (
    <div className="space-y-4">
      <Panel
        title="At a glance"
        hint={
          data
            ? `Refreshes every ${REFRESH_MS / 1000}s · read at ${new Date(
                data.generatedAt
              ).toLocaleTimeString()}`
            : "Loading…"
        }
        right={
          <Button size="sm" variant="ghost" loading={busy === "dashboard"} onClick={load}>
            Refresh
          </Button>
        }
      >
        {/*
          Failures only.
          *
          * These panels only READ, and useAdminAction reports every success —
          * so rendering the banner unconditionally parked a green "Done." under
          * the heading permanently, blinking on each poll. On a console where
          * green means "your money operation succeeded", a page that produces
          * one just by loading teaches an operator to ignore the colour.
        */}
        {note && !note.ok && <Note note={note} />}

        {data?.degradedReason && (
          <p className="mb-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            {data.degradedReason}
          </p>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Players" value={players?.total ?? UNKNOWN} />
          <Stat
            label="Online now"
            value={players?.online ?? UNKNOWN}
            // Somebody being online is not "good" or "bad", but zero players
            // online during a scheduled event is the first thing worth noticing.
            tone={players && players.online === 0 && activity?.tournamentsRunning ? "warn" : "default"}
          />
          <Stat label="New today" value={players?.newToday ?? UNKNOWN} />
          <Stat label="Active duels" value={activity?.activeMatches ?? UNKNOWN} />
          <Stat
            label="Live tournaments"
            value={activity?.tournamentsRunning ?? UNKNOWN}
            tone={activity && activity.tournamentsRunning > 0 ? "warn" : "default"}
          />
          <Stat label="Open bracket matches" value={activity?.openBracketMatches ?? UNKNOWN} />
        </div>

        <p className="mt-3 text-xs text-faint">
          Player counts exclude bots ({players?.bots ?? UNKNOWN} bot accounts exist). Online means
          seen in the last 5 minutes. &ldquo;Active duels&rdquo; are 1v1 matches waiting or in
          play; bracket matches inside a running tournament are counted separately.
          {activity?.tournamentsScheduled ? ` ${activity.tournamentsScheduled} scheduled.` : ""}
        </p>
      </Panel>

      <Panel
        title={data && !data.paymentsEnabled ? "Money — demo credit" : "Money"}
        hint="Every figure is read from the double-entry ledger, not from summed match columns."
      >
        {data && !data.paymentsEnabled && (
          <p className="mb-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            <span className="font-medium">This is not real money.</span> PAYMENTS_ENABLED is off on
            this deployment, so there are no deposits or withdrawals — every amount below is demo
            credit minted by the treasury. Nothing here has been earned or paid out in currency.
          </p>
        )}

        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Stat
            label="Revenue today"
            value={money(m?.revenueTodayTetri)}
            tone={m && m.revenueTodayTetri > 0 ? "good" : "default"}
          />
          <Stat
            label="Platform profit"
            value={money(m?.platformProfitTetri)}
            tone={m && m.platformProfitTetri > 0 ? "good" : "default"}
          />
          {/*
            Neutral on purpose.
            *
            * Green and red mean money into or out of the viewer's wallet. These
            * are lifetime aggregates for the platform, so painting fees green
            * and players' winnings red reads as "players winning is bad" — and
            * it fights the caption below, which says this pair is not profit.
          */}
          <Stat label="Entry fees (all time)" value={money(m?.entryFeesTetri)} />
          <Stat label="Prize payouts (all time)" value={money(m?.prizePayoutsTetri)} />
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Stat label="Entry fees today" value={money(m?.entryFeesTodayTetri)} />
          <Stat label="Payouts today" value={money(m?.prizePayoutsTodayTetri)} />
          <Stat label="Of fees, from bots" value={money(m?.entryFeesFromBotsTetri)} />
          <Stat label="Of payouts, to bots" value={money(m?.prizePayoutsToBotsTetri)} />
        </div>

        {/*
          The one place an operator can misread this screen badly, so it is spelled
          out rather than left to the field names. Each sentence answers a question
          somebody will otherwise answer wrongly in their head.
        */}
        <div className="mt-3 space-y-1.5 text-xs leading-relaxed text-faint">
          <p>
            <span className="text-muted">Revenue today</span> is the movement of the platform&rsquo;s
            rake account since{" "}
            {data ? new Date(data.todayStartedAt).toLocaleString() : "midnight"} (server time).{" "}
            <span className="text-muted">Platform profit</span> is that account&rsquo;s whole
            balance: the rake slice of every settled duel plus whatever a tournament pool did not
            pay out. Blitz margin is <span className="text-muted">not</span> included — blitz stakes
            and payouts move through the treasury, where they cannot be told apart from minted
            credit.
          </p>
          <p>
            <span className="text-muted">Entry fees</span> are what actually left player wallets on
            tournament and blitz entries, net of refunds — a released seat posts a reversing entry,
            so it cancels rather than double-counts.{" "}
            <span className="text-muted">Prize payouts</span> are what reached player wallets from
            tournament prizes and blitz payouts; stake refunds are excluded, because giving a
            stake back is not a win. Both legs of a 1v1 duel are excluded from this pair — the
            stake out and the winner&apos;s credit in — because counting only one of them made
            every settled duel read as pure outflow. What the platform keeps from duels is the
            rake figure above.
          </p>
          <p>
            Fees minus payouts is{" "}
            <span className="tabular-nums text-muted">{money(m?.netFromPlayersTetri)}</span>, which
            is <span className="text-muted">not</span> profit: it still holds stakes locked in the
            escrow of events that have not settled, and it counts bots on both sides. Bot money is
            minted before a fill and swept after, so it is a round trip, not demand.
          </p>
        </div>
      </Panel>

      <Panel title="Health" hint="Server, database and the realtime service.">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat
            label="Server"
            value={
              health ? `up · ${formatUptime(health.server.instanceUptimeS)}` : UNKNOWN
            }
            tone={health ? "good" : "default"}
          />
          <Stat
            label="Database"
            value={health ? (health.database.ok ? `${health.database.latencyMs}ms` : "down") : UNKNOWN}
            tone={health ? (health.database.ok ? "good" : "bad") : "default"}
          />
          <Stat
            label="Realtime"
            value={
              !health
                ? UNKNOWN
                : !health.realtime.configured
                  ? "not configured"
                  : health.realtime.ok
                    ? "up"
                    : "unreachable"
            }
            tone={
              !health
                ? "default"
                : !health.realtime.configured
                  ? "warn"
                  : health.realtime.ok
                    ? "good"
                    : "bad"
            }
          />
        </div>

        {health?.realtime.error && (
          <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            {health.realtime.error} Tournaments are unaffected — they run over HTTP.
          </p>
        )}

        <p className="mt-3 text-xs text-faint">
          &ldquo;Server&rdquo; only proves that the instance answering this request is alive, and
          the uptime is that instance&rsquo;s age — a small number after a deploy means a cold
          start, not an outage.
        </p>
      </Panel>

      <Panel
        title="Latest errors"
        hint={
          data && data.errorsCaptured > data.errors.length
            ? `Newest ${data.errors.length} of ${data.errorsCaptured} in this instance's buffer — the System tab has the rest.`
            : "Client crash reports and server exceptions from this instance."
        }
      >
        {!data ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : data.errors.length === 0 ? (
          <p className="text-sm text-muted">{data.errorsCaveat}</p>
        ) : (
          <>
            <div className="space-y-1.5">
              {data.errors.map((e, i) => (
                <div
                  key={`${e.at}-${i}`}
                  className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-2 text-faint">
                    <span className="font-mono">{new Date(e.at).toLocaleTimeString()}</span>
                    {e.route && <span className="font-mono">{e.route}</span>}
                    {e.source && <Badge tone="neutral">{e.source}</Badge>}
                  </div>
                  <p className="mt-1 break-words text-red-200">{e.message}</p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-faint">{data.errorsCaveat}</p>
          </>
        )}
      </Panel>
    </div>
  );
}

/** Compact instance age: "3m", "4h 12m", "2d 1h". */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
