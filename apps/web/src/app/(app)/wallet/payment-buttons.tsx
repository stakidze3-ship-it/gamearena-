"use client";

import { Button } from "@/components/ui/button";

export function PaymentButtons({
  paymentsEnabled,
  kycStatus,
}: {
  paymentsEnabled: boolean;
  kycStatus: "NONE" | "PENDING" | "VERIFIED";
}) {
  const withdrawBlocked = !paymentsEnabled || kycStatus !== "VERIFIED";
  return (
    <div className="mt-6 flex gap-2">
      <div className="relative flex-1">
        <Button variant="primary" className="w-full" disabled={!paymentsEnabled}>
          Deposit
        </Button>
        {!paymentsEnabled && <ComingSoon />}
      </div>
      <div className="relative flex-1">
        <Button
          variant="secondary"
          className="w-full"
          disabled={withdrawBlocked}
          title={
            paymentsEnabled && kycStatus !== "VERIFIED"
              ? "Withdrawals require verified KYC"
              : undefined
          }
        >
          Withdraw
        </Button>
        {!paymentsEnabled && <ComingSoon />}
      </div>
    </div>
  );
}

function ComingSoon() {
  return (
    <span className="pointer-events-none absolute -top-2 right-2 rounded-md border border-border bg-overlay px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-muted shadow-elev-1">
      Coming soon
    </span>
  );
}
