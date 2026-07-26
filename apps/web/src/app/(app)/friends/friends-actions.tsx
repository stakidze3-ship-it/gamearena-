"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { STAKES_TETRI } from "@gamearena/shared";
import { IconCheck, IconChevronRight, IconX } from "@/components/icons";
import { Button, buttonClasses } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StakeSelector } from "@/components/ui/stake-selector";

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}

export function FriendSearch({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initialQuery);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        router.push(`/friends?q=${encodeURIComponent(q.trim())}`);
      }}
      className="flex gap-2"
    >
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search players by username" />
      <Button type="submit" variant="secondary">Search</Button>
    </form>
  );
}

export function AddFriendButton({ username }: { username: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "sent" | "error">("idle");
  const [msg, setMsg] = useState("");
  async function add() {
    const { ok, data } = await post("/api/friends/request", { username });
    if (ok) {
      setState("sent");
      router.refresh();
    } else {
      setState("error");
      setMsg(data.error ?? "Failed");
    }
  }
  if (state === "sent") return <span className="text-sm text-muted">Request sent</span>;
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="secondary" onClick={add}>Add friend</Button>
      {state === "error" && <span className="text-xs text-loss">{msg}</span>}
    </div>
  );
}

export function RespondFriend({ friendshipId }: { friendshipId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function respond(accept: boolean) {
    setBusy(true);
    await post("/api/friends/respond", { friendshipId, accept });
    router.refresh();
  }
  return (
    <div className="flex shrink-0 gap-2">
      <Button size="icon-sm" variant="primary" aria-label="Accept" disabled={busy} onClick={() => respond(true)}>
        <IconCheck className="h-4 w-4" />
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="Decline" disabled={busy} onClick={() => respond(false)}>
        <IconX className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function ChallengeControl({ toUsername }: { toUsername: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [stake, setStake] = useState<number>(STAKES_TETRI[1]!);
  const [sent, setSent] = useState(false);
  async function send() {
    const { ok } = await post("/api/challenges/create", { toUsername, gameKey: "block-blast", stakeTetri: stake });
    if (ok) {
      setSent(true);
      router.refresh();
    }
  }
  if (sent) return <span className="text-sm text-gold">Challenge sent</span>;
  if (!open) return <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Challenge</Button>;
  return (
    <div className="flex w-full items-center gap-2">
      <StakeSelector
        options={STAKES_TETRI}
        value={stake}
        onChange={setStake}
        className="flex-1 grid-flow-col"
      />
      <Button variant="primary" onClick={send}>Send</Button>
    </div>
  );
}

export function RespondChallenge({
  challengeId,
  gameKey,
  stakeTetri,
}: {
  challengeId: string;
  gameKey: string;
  stakeTetri: number;
}) {
  const router = useRouter();
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function respond(accept: boolean) {
    setError(null);
    const res = await post("/api/challenges/respond", { challengeId, accept });
    if (!res.ok) {
      // Most often "you can't afford this stake". Showing it here keeps the
      // challenge open instead of sending the player to a match they cannot
      // fund, where they would dead-end and strand the challenger too.
      setError((res.data as { error?: string }).error ?? "Could not respond to the challenge");
      return;
    }
    if (accept) setAccepted(true);
    router.refresh();
  }
  if (accepted) {
    return (
      <Link
        href={`/match/${gameKey}?challenge=${challengeId}&stake=${stakeTetri}`}
        className={buttonClasses({ variant: "primary", size: "sm" })}
      >
        Play now
        <IconChevronRight className="h-3.5 w-3.5" />
      </Link>
    );
  }
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button size="icon-sm" variant="primary" aria-label="Accept" onClick={() => respond(true)}>
          <IconCheck className="h-4 w-4" />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Decline" onClick={() => respond(false)}>
          <IconX className="h-4 w-4" />
        </Button>
      </div>
      {error && <p className="max-w-[16rem] text-right text-2xs text-loss">{error}</p>}
    </div>
  );
}

export function PlayChallenge({
  challengeId,
  gameKey,
  stakeTetri,
}: {
  challengeId: string;
  gameKey: string;
  stakeTetri: number;
}) {
  return (
    <Link
      href={`/match/${gameKey}?challenge=${challengeId}&stake=${stakeTetri}`}
      className={buttonClasses({ variant: "primary", size: "sm" })}
    >
      Play now
      <IconChevronRight className="h-3.5 w-3.5" />
    </Link>
  );
}
