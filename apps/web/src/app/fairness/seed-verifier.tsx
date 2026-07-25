"use client";

import { useEffect, useState } from "react";
import { IconCheck, IconX } from "@/components/icons";
import { Card, CardBody } from "@/components/ui/card";
import { Hint, Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/cn";

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function SeedVerifier() {
  const [seed, setSeed] = useState("444859");
  const [hash, setHash] = useState("");
  const [commit, setCommit] = useState("");

  useEffect(() => {
    let alive = true;
    if (seed.trim() === "") {
      setHash("");
      return;
    }
    sha256Hex(seed.trim()).then((h) => {
      if (alive) setHash(h);
    });
    return () => {
      alive = false;
    };
  }, [seed]);

  const commitTrimmed = commit.trim().toLowerCase();
  const match = commitTrimmed.length > 0 && hash.length > 0 && hash === commitTrimmed;
  const mismatch = commitTrimmed.length > 0 && hash.length > 0 && hash !== commitTrimmed;

  return (
    <Card>
      <CardBody className="space-y-5">
        <div>
          <Label htmlFor="seed">Revealed seed</Label>
          <Input
            id="seed"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="e.g. 444859"
            className="font-mono"
          />
          <Hint>Shown on your result screen after a match.</Hint>
        </div>

        <div>
          <Label htmlFor="commit">Committed hash (optional)</Label>
          <Input
            id="commit"
            value={commit}
            onChange={(e) => setCommit(e.target.value)}
            placeholder="Paste the hash shown before the match"
            className="font-mono"
          />
          <Hint>Compare against the pre-match commit.</Hint>
        </div>

        <div>
          <p className="text-2xs uppercase tracking-wider text-muted">
            sha256(&quot;{seed || "…"}&quot;)
          </p>
          <p className="mt-1.5 break-all font-mono text-sm text-gold">{hash || "—"}</p>
        </div>

        {commitTrimmed.length > 0 && (
          <div
            className={cn(
              "flex items-start gap-2 text-sm",
              match && "text-mint",
              mismatch && "text-coral"
            )}
          >
            {match ? (
              <IconCheck className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <IconX className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span>
              {match
                ? "Match — this seed produces the committed hash. The match was fair."
                : "No match — this seed does not produce that hash."}
            </span>
          </div>
        )}

        <p className="text-xs leading-relaxed text-faint">
          This runs entirely in your browser. The server commits{" "}
          <span className="font-mono">sha256(seed)</span> before the match and reveals the{" "}
          <span className="font-mono">seed</span> after — it cannot change the board once
          committed without the hash no longer matching.
        </p>
      </CardBody>
    </Card>
  );
}
