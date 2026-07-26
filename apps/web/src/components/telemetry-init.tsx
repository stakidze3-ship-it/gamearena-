"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { installTelemetry, setTelemetryContext } from "@/lib/telemetry";

/**
 * Arms the global crash handlers for the whole app.
 *
 * Mounted once in the root layout. Renders nothing — it exists so that
 * `window.onerror`, unhandled promise rejections and failed requests are being
 * recorded from the first paint, including on screens that have no error
 * boundary of their own.
 */
export function TelemetryInit() {
  const pathname = usePathname();

  useEffect(() => {
    installTelemetry();
  }, []);

  useEffect(() => {
    setTelemetryContext({ route: pathname });
  }, [pathname]);

  return null;
}
