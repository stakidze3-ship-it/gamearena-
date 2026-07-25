import type { Metadata } from "next";
import { prisma } from "@gamearena/db";
import { PageHeader } from "@/components/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { FlagToggle } from "./flags-client";

export const metadata: Metadata = { title: "Feature flags" };

const DESCRIPTIONS: Record<string, string> = {
  PAYMENTS_ENABLED: "Enable real deposits/withdrawals. Env PAYMENTS_ENABLED is the hard gate.",
  DEMO_MODE: "Demo season — demo credits only, bots allowed.",
  BOTS_ENABLED: "Allow labelled bot opponents (demo only).",
  TOURNAMENTS_ENABLED: "Show and run scheduled tournaments.",
};

export default async function FlagsPage() {
  const flags = await prisma.featureFlag.findMany({ orderBy: { key: "asc" } });
  const paymentsEnv = process.env.PAYMENTS_ENABLED === "true";

  return (
    <>
      <PageHeader
        title="Feature flags"
        subtitle="Soft toggles stored in the DB. Money-critical flags are also gated by env — env wins."
      />
      <Card>
        <div className="divide-y divide-border">
          {flags.map((f) => (
            <div key={f.key} className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="tnum font-mono text-sm font-medium">{f.key}</span>
                  {f.key === "PAYMENTS_ENABLED" && (
                    <Badge tone={paymentsEnv ? "gain" : "muted"}>env: {paymentsEnv ? "on" : "off"}</Badge>
                  )}
                </div>
                <p className="mt-0.5 text-[12px] text-muted">{DESCRIPTIONS[f.key] ?? "—"}</p>
              </div>
              <FlagToggle flagKey={f.key} enabled={f.enabled} />
            </div>
          ))}
        </div>
      </Card>
      <p className="mt-3 text-[12px] text-faint">
        Note: <span className="font-mono">PAYMENTS_ENABLED</span> stays hard-off until the env var is
        set too — the wallet deposit/withdraw buttons read the env, not just this flag.
      </p>
    </>
  );
}
