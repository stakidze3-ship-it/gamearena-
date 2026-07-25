"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { multiplierBpsForScore, type CurvePoint } from "@gamearena/shared";
import { BarChart, Stat } from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const BUCKET = 200;
const BUCKETS = 9; // 0..1800+

export function CalibrationClient({
  gameKey,
  version,
  breakEvenScore: initialBE,
  zeroScore: initialZero,
  maxMultBps: initialMax,
  curve: initialCurve,
  scores,
}: {
  gameKey: string;
  version: number;
  breakEvenScore: number;
  zeroScore: number;
  maxMultBps: number;
  curve: CurvePoint[];
  scores: number[];
}) {
  const router = useRouter();
  const [breakEven, setBreakEven] = useState(initialBE);
  const [zero, setZero] = useState(initialZero);
  const [maxMult, setMaxMult] = useState(initialMax);
  const [curve, setCurve] = useState<CurvePoint[]>(initialCurve);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  // Score distribution histogram
  const hist = useMemo(() => {
    const b = Array.from({ length: BUCKETS }, (_, i) => ({
      label: i === BUCKETS - 1 ? `${(BUCKETS - 1) * BUCKET}+` : `${i * BUCKET}`,
      value: 0,
    }));
    for (const s of scores) {
      const idx = Math.min(BUCKETS - 1, Math.floor(s / BUCKET));
      b[idx]!.value++;
    }
    return b;
  }, [scores]);

  // Projected margin = 1 − E[multiplier] over the real score distribution.
  const margin = useMemo(() => {
    if (scores.length === 0) return null;
    const sorted = [...curve].sort((a, b) => a.score - b.score);
    const avgMult =
      scores.reduce((sum, s) => sum + multiplierBpsForScore(sorted, s, maxMult), 0) /
      scores.length /
      10_000;
    return Math.round((1 - avgMult) * 100);
  }, [curve, maxMult, scores]);

  function updatePoint(i: number, field: "score" | "multBps", value: number) {
    setCurve((c) => c.map((p, idx) => (idx === i ? { ...p, [field]: value } : p)));
    setSaved(null);
  }

  async function save() {
    setSaving(true);
    setSaved(null);
    const res = await fetch("/api/admin/calibration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameKey, breakEvenScore: breakEven, zeroScore: zero, maxMultBps: maxMult, curve }),
    });
    setSaving(false);
    if (res.ok) {
      const data = await res.json();
      setSaved(`Saved as v${data.version} — now live`);
      router.refresh();
    } else {
      setSaved("Save failed — check the values");
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <Card>
        <CardBody>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-2xs font-semibold uppercase tracking-wide text-muted">Real score distribution</h3>
            <span className="tnum text-xs text-muted">{scores.length} settled runs</span>
          </div>
          <BarChart data={hist} color="var(--color-gold)" />
          <p className="mt-3 text-xs leading-relaxed text-faint">
            Break-even sits at score {breakEven}. Bars left of it are house-positive runs; bars right
            pay out above the entry.
          </p>
        </CardBody>
      </Card>

      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Stat
            label="Projected margin"
            value={margin === null ? "—" : `${margin}%`}
            sub="over real scores"
            tone={margin !== null && margin >= 0 ? "gain" : "loss"}
          />
          <Stat label="Live version" value={`v${version}`} sub="active config" />
        </div>

        <Card>
          <CardBody>
            <h3 className="mb-3 text-2xs font-semibold uppercase tracking-wide text-muted">Curve</h3>
            <div className="grid gap-2 sm:grid-cols-3">
              <NumField label="Zero score" value={zero} onChange={setZero} />
              <NumField label="Break-even" value={breakEven} onChange={setBreakEven} />
              <NumField label="Max mult ×100" value={maxMult} onChange={setMaxMult} />
            </div>

            <div className="mt-4 space-y-2">
              <div className="grid grid-cols-2 gap-2 text-2xs uppercase tracking-wide text-muted">
                <span>Score</span>
                <span>Multiplier (bps · 10000 = 1×)</span>
              </div>
              {curve.map((p, i) => (
                <div key={i} className="grid grid-cols-2 gap-2">
                  <Input
                    type="number"
                    value={p.score}
                    onChange={(e) => updatePoint(i, "score", Number(e.target.value))}
                    className="tnum h-9"
                  />
                  <Input
                    type="number"
                    value={p.multBps}
                    onChange={(e) => updatePoint(i, "multBps", Number(e.target.value))}
                    className="tnum h-9"
                  />
                </div>
              ))}
            </div>

            <Button variant="primary" className="mt-4 w-full" loading={saving} onClick={save}>
              Save new version
            </Button>
            {saved && <p className="mt-2 text-center text-sm text-gold">{saved}</p>}
            <p className="mt-2 text-xs leading-relaxed text-faint">
              Saving publishes a new active version. The player-facing payout table reads the active
              config, so it updates immediately.
            </p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div>
      <p className="mb-1 text-2xs uppercase tracking-wide text-muted">{label}</p>
      <Input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} className="tnum h-9" />
    </div>
  );
}
