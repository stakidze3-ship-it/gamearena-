"use client";

import { useEffect } from "react";

/**
 * Computes a coarse device fingerprint and reports it once per load. The
 * server records it and flags when one device backs multiple accounts
 * (one device = one account, with admin override). Best-effort + privacy-lite:
 * only a hash leaves the browser, never the raw attributes.
 */
export function DeviceProbe() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const parts = [
          navigator.userAgent,
          navigator.language,
          navigator.platform ?? "",
          `${screen.width}x${screen.height}x${screen.colorDepth}`,
          Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
          String(navigator.hardwareConcurrency ?? ""),
        ].join("|");
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts));
        const hash = Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        if (cancelled) return;
        await fetch("/api/device", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hash }),
        });
      } catch {
        /* fingerprinting is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
