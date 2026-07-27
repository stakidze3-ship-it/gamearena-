"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { TournamentsSection, type AdminTournamentRow } from "./sections/tournaments-section";
import { UsersSection } from "./sections/users-section";
import { MatchesSection } from "./sections/matches-section";
import { SystemSection } from "./sections/system-section";

/**
 * The admin console.
 *
 * One page, four sections, no separation between "testing" and "administration"
 * — that split was the problem it replaced. An operator filling a bracket with
 * bots and an operator refunding a player are the same person doing the same
 * job, and making them navigate different areas of the product to do it meant
 * the testing tools got treated as a toy while the real tools stayed hidden.
 *
 * Sections are client-side tabs rather than routes. Switching between them
 * during an incident should not cost a page load, and the tournament list is
 * already loaded by the server component above.
 */
const SECTIONS = [
  { key: "tournaments", label: "Tournaments" },
  { key: "users", label: "Users" },
  { key: "matches", label: "Matches" },
  { key: "system", label: "System" },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

export function AdminConsole({
  tournaments,
  operator,
}: {
  tournaments: AdminTournamentRow[];
  operator: string;
}) {
  const [section, setSection] = useState<SectionKey>("tournaments");

  const liveRunning = tournaments.filter((t) => t.status === "RUNNING" && !t.isTest).length;

  return (
    <div>
      <header className="mb-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight">Admin console</h1>
          <p className="text-xs text-muted">
            signed in as <span className="text-fg">{operator}</span>
          </p>
        </div>
        <p className="mt-1 text-sm text-muted">
          Every control here acts on live data.
          {liveRunning > 0 && (
            <span className="text-amber-300">
              {" "}
              {liveRunning} live tournament{liveRunning === 1 ? " is" : "s are"} running right now.
            </span>
          )}
        </p>
      </header>

      <nav className="mb-5 overflow-x-auto">
        <div className="flex gap-1 whitespace-nowrap border-b border-border">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSection(s.key)}
              className={cn(
                "-mb-px border-b-2 px-3.5 py-2 text-sm transition-colors duration-150",
                section === s.key
                  ? "border-gold font-medium text-fg"
                  : "border-transparent text-muted hover:text-fg"
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </nav>

      {section === "tournaments" && <TournamentsSection rows={tournaments} />}
      {section === "users" && <UsersSection />}
      {section === "matches" && <MatchesSection />}
      {section === "system" && <SystemSection />}
    </div>
  );
}
