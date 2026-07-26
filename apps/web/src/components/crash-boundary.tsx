"use client";

import React from "react";
import { reportCrash, setTelemetryContext, type TelemetryContext } from "@/lib/telemetry";

/**
 * An error boundary that records WHICH component threw.
 *
 * Next's app/error.tsx receives only `{ error, reset }` — no `errorInfo`, so no
 * component stack. That is the single most useful field when a screen dies
 * during render: it is the difference between "a hook order violation somewhere
 * in the tournament page" and the exact component and its ancestors.
 *
 * A class component is the only way to get it. `componentDidCatch` is handed
 * `errorInfo.componentStack` in production builds too, unlike the owner-stack
 * APIs which are development-only.
 *
 * Placed AROUND a screen rather than inside it, and given its ids as props, so
 * it needs no hooks of its own in the component it is watching. That matters
 * here: the crash it was written to catch was itself caused by a hook added in
 * the wrong place.
 */
interface Props {
  children: React.ReactNode;
  /** Which surface this is, e.g. "tournament" — the first thing you read in a report. */
  scope: string;
  /** Ids to attach to any report from this subtree. */
  context?: TelemetryContext;
  /** Shown instead of the children once something throws. */
  fallback?: React.ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class CrashBoundary extends React.Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidMount(): void {
    // Publish ids before anything can throw, so a crash on the very first
    // interaction still reports which tournament and player it happened to.
    setTelemetryContext({ scope: this.props.scope, ...this.props.context });
  }

  componentDidUpdate(prev: Props): void {
    if (prev.context !== this.props.context) {
      setTelemetryContext({ scope: this.props.scope, ...this.props.context });
    }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    const componentStack = errorInfo.componentStack ?? null;
    this.setState({ componentStack });
    setTelemetryContext({ scope: this.props.scope, ...this.props.context });
    reportCrash(error, "boundary", { componentStack });
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="mx-auto max-w-lg px-6 py-16 text-center">
            <h2 className="font-display text-xl font-bold tracking-tight">
              This screen failed to load
            </h2>
            <p className="mt-3 text-sm text-muted">
              Your account and balance are untouched — nothing was charged. The problem has been
              reported automatically.
            </p>
            <button
              type="button"
              onClick={() => this.setState({ error: null, componentStack: null })}
              className="mt-6 rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-ink"
            >
              Try again
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
