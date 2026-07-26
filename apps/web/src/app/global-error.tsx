"use client";

import { useEffect } from "react";
import { reportCrash } from "@/lib/telemetry";

/**
 * Last-resort boundary.
 *
 * app/error.tsx sits inside the root layout, so a throw in the layout itself —
 * or in anything above it — never reaches it and the user gets Next's bare
 * "Application error: a client-side exception has occurred" with nothing
 * logged. This catches that case, which is otherwise the single hardest crash
 * to diagnose because it leaves no trace anywhere.
 *
 * It replaces the whole document, so it has to render its own <html> and <body>
 * and cannot rely on the app's fonts, providers or stylesheet. The styles are
 * inline for that reason.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportCrash(error, "global-error", { digest: error.digest ?? null });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: 24,
          textAlign: "center",
          background: "#0A0B0F",
          color: "#F5F5F7",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Something went wrong</h1>
        <p style={{ maxWidth: 380, fontSize: 14, color: "#9A9AA5", margin: 0 }}>
          The app failed to start. Your account and balance are untouched — nothing was charged.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: 12,
            border: 0,
            borderRadius: 10,
            padding: "10px 18px",
            fontSize: 14,
            fontWeight: 600,
            background: "#E9B949",
            color: "#0A0B0F",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
        {error.digest && (
          <p style={{ marginTop: 24, fontSize: 11, color: "#6A6A75", fontFamily: "monospace" }}>
            Reference {error.digest}
          </p>
        )}
      </body>
    </html>
  );
}
