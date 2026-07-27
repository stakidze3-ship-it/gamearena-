"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * Shared machinery for the admin console.
 *
 * Every control on this page fires a privileged mutation against live data, so
 * the same three things matter everywhere: the operator must know what a button
 * will do before pressing it, a request in flight must not be fired twice, and
 * the result — especially a failure — must be visible rather than swallowed.
 * These primitives exist so no individual section reinvents that, inconsistently.
 */

export interface ActionResult {
  ok: boolean;
  text: string;
  /** Machine-readable code from the API, when it sent one. */
  code?: string;
  data?: Record<string, unknown>;
}

/**
 * POST to an admin endpoint, tracking which action is in flight.
 *
 * Keyed by a caller-supplied id rather than a single boolean: this page has
 * dozens of buttons and a global "busy" flag would grey out all of them while
 * one tournament refreshes.
 */
export function useAdminAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<ActionResult | null>(null);

  const run = useCallback(
    async (
      key: string,
      url: string,
      body?: unknown,
      method: "POST" | "GET" = "POST"
    ): Promise<ActionResult> => {
      setBusy(key);
      setNote(null);
      try {
        const res = await fetch(url, {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => ({}));
        const result: ActionResult = res.ok
          ? { ok: true, text: typeof data.message === "string" ? data.message : "Done.", data }
          : {
              ok: false,
              text: typeof data.error === "string" ? data.error : `Request failed (${res.status})`,
              code: typeof data.code === "string" ? data.code : undefined,
              data,
            };
        setNote(result);
        return result;
      } catch (err) {
        // A network failure must not look like a success, and must not throw
        // into the error boundary and take the whole console down mid-incident.
        const result: ActionResult = {
          ok: false,
          text: err instanceof Error ? err.message : "Network error",
        };
        setNote(result);
        return result;
      } finally {
        setBusy(null);
      }
    },
    []
  );

  return { busy, note, setNote, run };
}

/** Inline result banner. Red for failures — this is one of the few non-money uses of it. */
export function Note({ note }: { note: ActionResult | null }) {
  if (!note) return null;
  return (
    <div
      className={cn(
        "mt-3 rounded-lg border px-3 py-2 text-sm",
        note.ok
          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200"
          : "border-red-500/25 bg-red-500/10 text-red-200"
      )}
    >
      {note.text}
    </div>
  );
}

export interface ConfirmSpec {
  title: string;
  /** What will happen, in plain language. */
  body: React.ReactNode;
  /** Consequences an operator must not discover afterwards. */
  consequences?: string[];
  confirmLabel: string;
  /** Require typing this exact string. Reserved for the genuinely irreversible. */
  typeToConfirm?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

/**
 * Modal confirmation for destructive or money-moving actions.
 *
 * Deliberately not a `window.confirm`: the consequences that matter here —
 * "bots will compete for a real ₾160 prize pool" — need more than one line, and
 * the most dangerous actions need the operator to type the tournament name so a
 * misclick cannot cost real money.
 */
export function ConfirmDialog({
  spec,
  onClose,
}: {
  spec: ConfirmSpec | null;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);

  if (!spec) return null;
  const locked = !!spec.typeToConfirm && typed.trim() !== spec.typeToConfirm;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={spec.title}
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-elev-3">
        <h3
          className={cn(
            "font-display text-lg font-bold tracking-tight",
            spec.danger ? "text-red-300" : "text-fg"
          )}
        >
          {spec.title}
        </h3>

        <div className="mt-2 text-sm text-muted">{spec.body}</div>

        {spec.consequences && spec.consequences.length > 0 && (
          <ul className="mt-3 space-y-1.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-100">
            {spec.consequences.map((c) => (
              <li key={c} className="flex gap-2">
                <span aria-hidden className="text-amber-400">
                  •
                </span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        )}

        {spec.typeToConfirm && (
          <label className="mt-4 block text-xs text-muted">
            Type <span className="font-mono text-fg">{spec.typeToConfirm}</span> to confirm
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-bg px-2.5 py-2 font-mono text-sm text-fg outline-none focus:border-gold"
            />
          </label>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setTyped("");
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={working}
            disabled={locked || working}
            className={spec.danger ? "bg-red-500 text-white hover:bg-red-400" : undefined}
            onClick={async () => {
              setWorking(true);
              try {
                await spec.onConfirm();
              } finally {
                setWorking(false);
                setTyped("");
                onClose();
              }
            }}
          >
            {spec.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A labelled group of controls. Keeps the four sections visually consistent. */
export function Panel({
  title,
  hint,
  children,
  right,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">{title}</h3>
          {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
        </div>
        {right}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** One key/value readout. The console is mostly these. */
export function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "good" | "bad" | "warn";
}) {
  return (
    <div className="rounded-xl border border-border bg-bg px-3.5 py-3">
      <div className="text-2xs uppercase tracking-wider text-faint">{label}</div>
      <div
        className={cn(
          "mt-1 font-display text-lg font-semibold tabular-nums",
          tone === "good" && "text-emerald-300",
          tone === "bad" && "text-red-300",
          tone === "warn" && "text-amber-300"
        )}
      >
        {value}
      </div>
    </div>
  );
}
