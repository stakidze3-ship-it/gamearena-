"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { STAKES_TETRI, formatTetriCompact, rakeBpsForStake } from "@gamearena/shared";
import type { BlockBlastInput } from "@gamearena/games";
import { BlockBlastBoard } from "@/components/games/block-blast-board";
import { ConfettiBurst } from "@/components/confetti";
import { IconChevronDown, IconChevronLeft, IconChevronRight } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Money } from "@/components/ui/money";
import { StakeSelector } from "@/components/ui/stake-selector";
import { cn } from "@/lib/cn";

type Phase = "idle" | "connecting" | "queued" | "countdown" | "playing" | "awaiting" | "result" | "error";

interface MatchInfo {
  matchId: string;
  seedHash: string;
  opponent: { username: string; isBot: boolean };
  stakeTetri: number;
  potTetri: number;
  rakeBps: number;
  durationS: number;
}

interface Result {
  youScore: number;
  oppScore: number;
  outcome: "win" | "loss" | "draw";
  stakeTetri: number;
  payoutTetri: number;
  rakeTetri: number;
  netTetri: number;
  seed: string;
}

interface ChatMsg {
  id: number;
  from: string;
  text: string;
  self: boolean;
}

export function MatchClient({
  gameKey,
  gameName,
  enabled,
  durationS,
  username,
  balanceTetri,
  excluded,
  challengeId,
  presetStake,
}: {
  gameKey: string;
  gameName: string;
  enabled: boolean;
  durationS: number;
  username: string;
  balanceTetri: number;
  excluded: boolean;
  challengeId?: string;
  presetStake?: number;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [stake, setStake] = useState<number>(
    presetStake && STAKES_TETRI.includes(presetStake as (typeof STAKES_TETRI)[number])
      ? presetStake
      : STAKES_TETRI[1]!
  );
  const [match, setMatch] = useState<MatchInfo | null>(null);
  const [seed, setSeed] = useState<string | null>(null);
  const [oppScore, setOppScore] = useState(0);
  const [countdown, setCountdown] = useState(3);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [chatDraft, setChatDraft] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const chatIdRef = useRef(0);
  const boardKeyRef = useRef(0);

  const canPlay = enabled && !excluded && gameKey === "block-blast";

  const cleanup = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const send = (msg: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const handleServer = useCallback(
    (msg: Record<string, unknown>) => {
      switch (msg.t) {
        case "queued":
          setPhase("queued");
          break;
        case "matched":
          setMatch(msg as unknown as MatchInfo);
          setOppScore(0);
          setChat([]);
          setCountdown(Math.ceil((msg.startInMs as number) / 1000));
          setPhase("countdown");
          break;
        case "start":
          setSeed(msg.seed as string);
          boardKeyRef.current++;
          setPhase("playing");
          break;
        case "oppScore":
          setOppScore(msg.score as number);
          break;
        case "chat":
          setChat((c) => [
            ...c,
            { id: chatIdRef.current++, from: msg.from as string, text: msg.text as string, self: !!msg.self },
          ]);
          break;
        case "result":
          setResult(msg as unknown as Result);
          setPhase("result");
          router.refresh();
          break;
        case "error":
          setError((msg.message as string) ?? "Something went wrong");
          setPhase("error");
          break;
      }
    },
    [router]
  );

  async function findMatch() {
    setError(null);
    setResult(null);
    setPhase("connecting");
    // Reuse an open socket (e.g. Play again); otherwise fetch a ticket + connect.
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      send({ t: "join", gameKey, stakeTetri: stake, challengeId });
      return;
    }
    const res = await fetch("/api/realtime/ticket", { method: "POST" });
    if (!res.ok) {
      setError("Could not authenticate for realtime play");
      setPhase("error");
      return;
    }
    const { token, wsUrl } = await res.json();
    const ws = new WebSocket(`${wsUrl}/ws?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;
    ws.onopen = () => send({ t: "join", gameKey, stakeTetri: stake, challengeId });
    ws.onmessage = (e) => {
      try {
        handleServer(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    ws.onerror = () => {
      setError("Realtime connection failed — is the match service running?");
      setPhase("error");
    };
    ws.onclose = () => {
      wsRef.current = null;
    };
  }

  // Countdown ticker
  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown <= 0) return;
    const id = setTimeout(() => setCountdown((n) => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(id);
  }, [phase, countdown]);

  // A challenge link auto-joins its private room.
  useEffect(() => {
    if (challengeId) void findMatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stable identities: the board keys its clock/effects off these, so they must
  // not change on every re-render (opponent-score updates re-render this often).
  const handleInput = useCallback((input: BlockBlastInput) => {
    send({ t: "input", input });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBoardEnd = useCallback(() => {
    setPhase("awaiting"); // server settles authoritatively
  }, []);

  function sendChat() {
    const text = chatDraft.trim();
    if (!text) return;
    send({ t: "chat", text });
    setChatDraft("");
  }

  function leaveToIdle() {
    send({ t: "leave" });
    setMatch(null);
    setSeed(null);
    setResult(null);
    setPhase("idle");
  }

  // ── Playing / awaiting result ──
  if ((phase === "playing" && seed && match) || (phase === "awaiting" && match)) {
    return (
      <div className="mx-auto max-w-lg">
        <OpponentPanel match={match} oppScore={oppScore} you={username} />
        {phase === "playing" && seed ? (
          <BlockBlastBoard
            key={boardKeyRef.current}
            seed={seed}
            durationS={durationS}
            onEnd={handleBoardEnd}
            onInput={handleInput}
          />
        ) : (
          <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-gold" />
            <p className="text-sm text-muted">Server is scoring the match…</p>
          </div>
        )}
        <ChatPanel chat={chat} draft={chatDraft} setDraft={setChatDraft} onSend={sendChat} />
      </div>
    );
  }

  // ── Countdown ──
  if (phase === "countdown" && match) {
    return (
      <div className="mx-auto max-w-lg">
        <OpponentPanel match={match} oppScore={0} you={username} />
        <div className="flex flex-col items-center py-16 text-center">
          <p className="text-sm text-muted">Match found — get ready</p>
          <p key={countdown} className="ga-charge tnum mt-2 font-display text-5xl font-bold text-gold">
            {countdown || "GO"}
          </p>
          <p className="mt-6 text-xs text-faint">
            Both players get the identical seed. Commit hash{" "}
            <span className="font-mono">{match.seedHash.slice(0, 10)}…</span>
          </p>
        </div>
      </div>
    );
  }

  // ── Queued / connecting ──
  if (phase === "connecting" || phase === "queued") {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center py-24 text-center">
        <div className="h-9 w-9 animate-spin rounded-full border-2 border-border border-t-gold" />
        <p className="mt-6 text-base text-muted">
          {phase === "connecting"
            ? "Connecting…"
            : challengeId
              ? "Waiting for your opponent to join the challenge…"
              : "Searching for a rated opponent near your stake…"}
        </p>
        <div className="mt-8 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={leaveToIdle}>
            Cancel
          </Button>
          {!challengeId && (
            <Link
              href={`/blitz/${gameKey}`}
              onClick={() => send({ t: "leave" })}
              className={buttonClasses({ variant: "ghost", size: "sm" })}
            >
              Play Blitz instead
              <IconChevronRight className="h-4 w-4" />
            </Link>
          )}
        </div>
      </div>
    );
  }

  // ── Result ──
  if (phase === "result" && result) {
    const won = result.outcome === "win";
    const draw = result.outcome === "draw";
    return (
      <div className="relative mx-auto max-w-lg py-8 text-center">
        {won && <ConfettiBurst />}
        <Badge tone={won ? "gain" : draw ? "neutral" : "loss"}>
          {won ? "You won" : draw ? "Draw" : "You lost"}
        </Badge>

        <div className="mt-8 flex items-center justify-center gap-6">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted">You</p>
            <p className="tnum font-display text-5xl font-bold">{result.youScore}</p>
          </div>
          <span className="text-xl font-light text-faint">:</span>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted">
              {match?.opponent.username ?? "Opponent"}
            </p>
            <p className="tnum font-display text-5xl font-bold text-muted">{result.oppScore}</p>
          </div>
        </div>

        <div className="mt-10">
          <p className="text-2xs uppercase tracking-wider text-muted">Net</p>
          <Money tetri={result.netTetri} signed className="font-display text-2xl font-bold" />
        </div>

        <div className="mx-auto mt-4 max-w-xs space-y-1 text-sm">
          <Row label="Stake" value={<Money tetri={-result.stakeTetri} signed />} />
          {!draw && (
            <Row
              label={won ? "Payout (pot − rake)" : "Payout"}
              value={<Money tetri={won ? result.payoutTetri : 0} signed />}
            />
          )}
          {draw && <Row label="Refunded (draw)" value={<Money tetri={result.stakeTetri} signed />} />}
        </div>

        <p className="tnum mt-6 font-mono text-xs text-faint">
          Seed #{result.seed}
          {match && <span> → {match.seedHash.slice(0, 10)}…</span>}
        </p>

        <div className="mt-10 flex flex-col gap-2 sm:flex-row sm:justify-center">
          {canPlay && (
            <Button variant="primary" onClick={findMatch}>
              Play again
            </Button>
          )}
          <Link href="/lobby" className={buttonClasses({ variant: "ghost" })}>
            Back to lobby
          </Link>
        </div>
      </div>
    );
  }

  // ── Idle / error ──
  return (
    <div className="mx-auto max-w-lg">
      <Link
        href="/lobby"
        className="inline-flex items-center gap-1 text-sm text-muted transition-colors duration-150 hover:text-fg"
      >
        <IconChevronLeft className="h-4 w-4" />
        Lobby
      </Link>

      <div className="mt-10 space-y-10">
        <div className="text-center">
          <p className="text-2xs uppercase tracking-wider text-muted">
            {gameName} · 1v1
          </p>
          <h1 className="mt-2 font-display text-xl font-bold tracking-tight md:text-2xl">
            Choose your stake
          </h1>
        </div>

        <div>
          <StakeSelector
            options={STAKES_TETRI}
            value={stake}
            onChange={setStake}
            className="grid-cols-4"
          />
          <p className="mt-3 text-center text-xs text-muted">
            Balance <Money tetri={balanceTetri} className="text-fg-secondary" />
          </p>
        </div>

        <div>
          {error && <p className="mb-3 text-center text-sm text-loss">{error}</p>}
          <Button
            variant="primary"
            size="lg"
            className="h-14 w-full text-md"
            disabled={!canPlay || balanceTetri < stake}
            onClick={findMatch}
          >
            {balanceTetri < stake ? "Not enough credits" : `Find ${formatTetriCompact(stake)} match`}
          </Button>
          <p className="mt-3 text-center text-xs text-faint">
            Winner takes {formatTetriCompact(stake * 2)} pot minus{" "}
            {(rakeBpsForStake(stake) / 100).toFixed(rakeBpsForStake(stake) % 100 ? 1 : 0)}% rake · {durationS}s
          </p>
        </div>

        <details className="group rounded-lg border border-border bg-surface">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-muted transition-colors duration-150 hover:text-fg [&::-webkit-details-marker]:hidden">
            How a 1v1 works
            <IconChevronDown className="h-4 w-4 transition-transform duration-150 group-open:rotate-180" />
          </summary>
          <div className="border-t border-border px-4 py-3 text-sm text-muted">
            <ol className="space-y-2">
              {[
                "Both stakes lock into escrow before anyone sees a piece.",
                "You and your opponent get the identical seed — same pieces, same board.",
                "You stream inputs; the server keeps its own engine and computes both scores.",
                "Highest score takes the pot minus rake. A draw refunds both stakes.",
              ].map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className="tnum text-gold">{i + 1}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
            {excluded && (
              <p className="mt-3">
                <span className="font-medium text-loss">Self-exclusion active</span> — play is disabled.
              </p>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

function OpponentPanel({
  match,
  oppScore,
  you,
}: {
  match: MatchInfo;
  oppScore: number;
  you: string;
}) {
  return (
    <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
      <div>
        <p className="text-2xs uppercase tracking-wider text-muted">You</p>
        <p className="text-sm font-semibold">{you}</p>
      </div>
      <span className="tnum rounded-full border border-gold/30 px-3 py-1 text-xs font-semibold text-gold">
        {formatTetriCompact(match.stakeTetri)} · pot {formatTetriCompact(match.potTetri)}
      </span>
      <div className="text-right">
        <p className="flex items-center justify-end gap-1.5 text-2xs uppercase tracking-wider text-muted">
          {match.opponent.isBot && <Badge tone="muted">Bot</Badge>}
          {match.opponent.username}
        </p>
        <p className="tnum text-sm font-semibold text-fg-secondary">
          score <span className="text-fg">{oppScore}</span>
        </p>
      </div>
    </div>
  );
}

function ChatPanel({
  chat,
  draft,
  setDraft,
  onSend,
}: {
  chat: ChatMsg[];
  draft: string;
  setDraft: (s: string) => void;
  onSend: () => void;
}) {
  return (
    <Card className="mt-4">
      <div className="max-h-28 space-y-1 overflow-y-auto px-4 py-3 text-sm">
        {chat.length === 0 ? (
          <p className="text-sm text-faint">Say hi to your opponent…</p>
        ) : (
          chat.map((m) => (
            <p key={m.id}>
              <span className={cn("font-medium", m.self ? "text-gold" : "text-fg-secondary")}>{m.from}:</span>{" "}
              <span className="text-muted">{m.text}</span>
            </p>
          ))
        )}
      </div>
      <div className="flex gap-2 border-t border-border p-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSend()}
          maxLength={200}
          placeholder="Message…"
          className="flex-1"
        />
        <Button onClick={onSend}>Send</Button>
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      {value}
    </div>
  );
}
