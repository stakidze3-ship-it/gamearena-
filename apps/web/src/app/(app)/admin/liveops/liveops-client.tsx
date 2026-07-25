"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Switch } from "@/components/ui/input";
import { Card, CardBody } from "@/components/ui/card";

async function post(body: unknown): Promise<boolean> {
  const res = await fetch("/api/admin/liveops", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

export function CreateTournament() {
  const router = useRouter();
  const [f, setF] = useState({
    name: "Friday Night Cup",
    entryLari: 5,
    guaranteeLari: 50,
    capacity: 32,
    startsInHours: 0,
    durationMin: 15,
    prizes: "top3",
  });
  const [msg, setMsg] = useState("");

  async function submit() {
    const ok = await post({ type: "tournament", gameKey: "block-blast", ...f, prizes: f.prizes as string });
    setMsg(ok ? "Created ✓" : "Failed");
    if (ok) router.refresh();
  }

  return (
    <Card>
      <CardBody>
        <h3 className="mb-3 text-base font-semibold tracking-tight">Create tournament</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Name">
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
          </div>
          <Field label="Entry (₾)">
            <Input type="number" value={f.entryLari} onChange={(e) => setF({ ...f, entryLari: +e.target.value })} className="tnum" />
          </Field>
          <Field label="Guarantee (₾)">
            <Input type="number" value={f.guaranteeLari} onChange={(e) => setF({ ...f, guaranteeLari: +e.target.value })} className="tnum" />
          </Field>
          <Field label="Capacity">
            <Input type="number" value={f.capacity} onChange={(e) => setF({ ...f, capacity: +e.target.value })} className="tnum" />
          </Field>
          <Field label="Starts in (hours)">
            <Input type="number" value={f.startsInHours} onChange={(e) => setF({ ...f, startsInHours: +e.target.value })} className="tnum" />
          </Field>
          <Field label="Duration (min)">
            <Input type="number" value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: +e.target.value })} className="tnum" />
          </Field>
          <Field label="Prizes">
            <Select value={f.prizes} onChange={(e) => setF({ ...f, prizes: e.target.value })}>
              <option value="winner">Winner takes all</option>
              <option value="top2">Top 2 (60/40)</option>
              <option value="top3">Top 3 (50/30/20)</option>
            </Select>
          </Field>
        </div>
        <Button variant="secondary" className="mt-4 w-full" onClick={submit}>Create</Button>
        {msg && <p className="mt-2 text-center text-sm text-gold">{msg}</p>}
      </CardBody>
    </Card>
  );
}

export function PostAnnouncement() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState("");
  async function submit() {
    const ok = await post({ type: "announcement", title, body });
    setMsg(ok ? "Posted ✓" : "Failed");
    if (ok) {
      setTitle("");
      setBody("");
      router.refresh();
    }
  }
  return (
    <Card>
      <CardBody>
        <h3 className="mb-1 text-base font-semibold tracking-tight">Post announcement</h3>
        <p className="mb-3 text-xs text-muted">Shows as a banner on the home lobby.</p>
        <div className="space-y-3">
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Weekend rake-free happy hour!" />
          </Field>
          <Field label="Body">
            <Input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Every match this Saturday runs rake-free." />
          </Field>
        </div>
        <Button variant="secondary" className="mt-4 w-full" onClick={submit} disabled={!title || !body}>Post</Button>
        {msg && <p className="mt-2 text-center text-sm text-gold">{msg}</p>}
      </CardBody>
    </Card>
  );
}

export function ScheduleHappyHour() {
  const router = useRouter();
  const [f, setF] = useState({ name: "Rake-free hour", startsInHours: 0, durationMin: 60, rakeDiscountPct: 100 });
  const [msg, setMsg] = useState("");
  async function submit() {
    const ok = await post({ type: "happyHour", ...f });
    setMsg(ok ? "Scheduled ✓" : "Failed");
    if (ok) router.refresh();
  }
  return (
    <Card>
      <CardBody>
        <h3 className="mb-1 text-base font-semibold tracking-tight">Schedule happy hour</h3>
        <p className="mb-3 text-xs text-muted">Applies a rake discount to 1v1 matches in the window.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Name">
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
          </div>
          <Field label="Starts in (hours)">
            <Input type="number" value={f.startsInHours} onChange={(e) => setF({ ...f, startsInHours: +e.target.value })} className="tnum" />
          </Field>
          <Field label="Duration (min)">
            <Input type="number" value={f.durationMin} onChange={(e) => setF({ ...f, durationMin: +e.target.value })} className="tnum" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Rake discount (%)">
              <Input type="number" value={f.rakeDiscountPct} onChange={(e) => setF({ ...f, rakeDiscountPct: +e.target.value })} className="tnum" />
            </Field>
          </div>
        </div>
        <Button variant="secondary" className="mt-4 w-full" onClick={submit}>Schedule</Button>
        {msg && <p className="mt-2 text-center text-sm text-gold">{msg}</p>}
      </CardBody>
    </Card>
  );
}

export function AnnouncementToggle({ id, active }: { id: string; active: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(active);
  async function toggle() {
    setOn(!on);
    await fetch("/api/admin/announcements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, active: !on }),
    });
    router.refresh();
  }
  return <Switch checked={on} onCheckedChange={toggle} aria-label={on ? "Hide announcement" : "Show announcement"} />;
}
