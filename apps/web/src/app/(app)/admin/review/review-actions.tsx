"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function ReviewActions({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"clear" | "suspend" | null>(null);

  async function act(action: "clear" | "suspend") {
    setBusy(action);
    await fetch("/api/admin/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseId, action }),
    });
    router.refresh();
    setBusy(null);
  }

  return (
    <div className="flex shrink-0 gap-2">
      <Button
        variant="secondary"
        size="sm"
        disabled={!!busy}
        loading={busy === "clear"}
        onClick={() => act("clear")}
      >
        Clear
      </Button>
      <Button
        variant="danger"
        size="sm"
        disabled={!!busy}
        loading={busy === "suspend"}
        onClick={() => act("suspend")}
      >
        Suspend
      </Button>
    </div>
  );
}
