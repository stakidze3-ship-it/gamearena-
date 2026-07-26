"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BLOCK_BLAST_RULES_LATEST,
  BlockBlastEngine,
  GRID,
  type BlockBlastInput,
  type BlockBlastRulesVersion,
  type Shape,
} from "@gamearena/games";
import { Button } from "@/components/ui/button";
import { IconVolume, IconVolumeOff } from "@/components/icons";
import { cn } from "@/lib/cn";
import {
  resolvePlacement,
  snapOrigin,
  type Aim,
  type BoardGeometry,
  type Placement,
} from "@/lib/block-blast-placement";
import { initMuted, playClear, playGameOver, playPlace, setMuted } from "@/lib/sound";

/**
 * Playable Block Blast board. Runs the SAME shared engine the server uses,
 * so what you see is exactly what the server will recompute. It records the
 * raw input log ({t, slot, r, c}) and hands it to `onEnd` — the client's own
 * score is display-only and never trusted for money.
 *
 * Interaction is real drag-and-drop (like Block Blast): grab any of the three
 * pieces and drag it onto the grid. The piece floats above the finger and a
 * ghost shows where it lands (green = fits, red = blocked).
 */

const BLOCK_COLORS = ["#8f84f5", "#4cc3f7", "#2fd9a4", "#ffb84d", "#ff7b7b", "#c98cff"];

export interface BlockBlastResult {
  inputs: BlockBlastInput[];
  clientScore: number;
}

/** Everything about a drag that never changes while it runs. */
interface DragMeta {
  slot: number;
  shape: Shape;
  touch: boolean;
  cell: number;
  lift: number;
}

/** Where the piece would land. Only this drives a React render. */
type Snap = Placement;

/** Live pointer state, kept out of React so moves never re-render. */
interface DragLive {
  meta: DragMeta;
  rect: DOMRect;
  px: number;
  py: number;
  snap: Snap | null;
}


export function BlockBlastBoard({
  seed,
  durationS,
  rulesVersion = BLOCK_BLAST_RULES_LATEST,
  onEnd,
  onInput,
}: {
  seed: string;
  durationS: number;
  /** Scoring rules for this run — must match what the server stored. */
  rulesVersion?: BlockBlastRulesVersion;
  onEnd: (result: BlockBlastResult) => void;
  /** Fires on every legal placement — used to stream inputs live in 1v1. */
  onInput?: (input: BlockBlastInput) => void;
}) {
  const engineRef = useRef<BlockBlastEngine | null>(null);
  if (!engineRef.current) engineRef.current = new BlockBlastEngine(seed, rulesVersion);

  const startRef = useRef(0);
  const inputsRef = useRef<BlockBlastInput[]>([]);
  const colorRef = useRef<(string | null)[]>(new Array(GRID * GRID).fill(null));
  const colorCounterRef = useRef(0);
  const endedRef = useRef(false);
  const boardRef = useRef<HTMLDivElement>(null);

  const [state, setState] = useState(() => engineRef.current!.getState());
  const [remaining, setRemaining] = useState(durationS);
  const [flash, setFlash] = useState<number[]>([]);
  const [comboText, setComboText] = useState<string | null>(null);
  const [dragMeta, setDragMeta] = useState<DragMeta | null>(null);
  const [snap, setSnap] = useState<Snap | null>(null);
  const [mute, setMute] = useState(false);
  useEffect(() => setMute(initMuted()), []);
  const liveRef = useRef<DragLive | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<{ px: number; py: number } | null>(null);
  /** The floating piece, moved by writing transform directly — never via state. */
  const floatRef = useRef<HTMLDivElement>(null);
  /** The hand tray — releasing a piece over it cancels the drag. */
  const trayRef = useRef<HTMLDivElement>(null);

  const finish = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    onEnd({ inputs: inputsRef.current, clientScore: engineRef.current!.getScore() });
  }, [onEnd]);

  // Latest finish, reachable from the clock without making it a dependency.
  const finishRef = useRef(finish);
  finishRef.current = finish;

  // Clock — starts ONCE per board mount. It must not depend on `finish`/`onEnd`:
  // in a 1v1 the parent re-renders on every opponent-score update, which would
  // otherwise restart this interval and reset the start time (freezing the timer
  // at ~60). The board is remounted (via key) for each new game, so a fresh
  // mount is the only time the clock should (re)start.
  useEffect(() => {
    startRef.current = performance.now();
    const id = setInterval(() => {
      const elapsed = (performance.now() - startRef.current) / 1000;
      const rem = Math.max(0, durationS - elapsed);
      setRemaining(rem);
      if (rem <= 0) {
        clearInterval(id);
        finishRef.current();
      }
    }, 100);
    return () => clearInterval(id);
  }, [durationS]);

  const place = useCallback(
    (r: number, c: number, slot: number) => {
      const eng = engineRef.current!;
      if (endedRef.current || eng.isOver()) return;
      const shape = eng.getState().hand[slot];
      if (!shape || !eng.previewFits(slot, r, c)) return;

      const t = Math.round(performance.now() - startRef.current);
      if (t > durationS * 1000) return finish();

      const input = { t, s: slot, r, c };
      if (!eng.applyInput(input)) return;
      inputsRef.current.push(input);
      onInput?.(input);

      const color = BLOCK_COLORS[colorCounterRef.current % BLOCK_COLORS.length]!;
      colorCounterRef.current++;
      for (const [dr, dc] of shape.cells) colorRef.current[(r + dr) * GRID + (c + dc)] = color;

      const ns = eng.getState();
      if (ns.lastCleared.length) {
        for (const idx of ns.lastCleared) colorRef.current[idx] = null;
        setFlash(ns.lastCleared);
        window.setTimeout(() => setFlash([]), 430);
        playClear(ns.lastClearLines, ns.combo);
        // Combo streak takes priority over the simultaneous-clear callout.
        if (ns.combo >= 2) {
          setComboText(`COMBO ×${ns.combo}`);
          window.setTimeout(() => setComboText(null), 850);
        } else if (ns.lastClearLines >= 2) {
          setComboText(`${ns.lastClearLines}× CLEAR!`);
          window.setTimeout(() => setComboText(null), 700);
        }
      } else {
        playPlace();
      }
      setState(ns);
      if (ns.over) {
        playGameOver();
        window.setTimeout(finish, 250);
      }
    },
    [durationS, finish, onInput]
  );
  const placeRef = useRef(place);
  placeRef.current = place;

  // ── Drag & drop ──
  //
  // The piece is centred on the pointer and snapped to the nearest cell, with a
  // one-cell tolerance at the edges and a one-cell assist search when the exact
  // target is blocked. On a mouse the piece sits under the cursor; on touch it
  // floats above the finger so it is not hidden by the hand.
  //
  // Nothing here touches React state per frame — see onPointerMove.

  const geometryFrom = useCallback(
    (rect: DOMRect): BoardGeometry => ({ left: rect.left, top: rect.top, width: rect.width, pad: 8, gap: 4 }),
    []
  );

  const originFrom = useCallback(
    (shape: Shape, px: number, py: number, rect: DOMRect, lift: number) =>
      snapOrigin(shape, px, py, geometryFrom(rect), lift),
    [geometryFrom]
  );

  const resolveSnap = useCallback((slot: number, shape: Shape, aim: Aim): Snap => {
    const eng = engineRef.current!;
    return resolvePlacement(shape, aim, (r, c) => eng.previewFits(slot, r, c));
  }, []);

  /** Move the floating piece without React — a style write, not a render. */
  const paintFloat = useCallback((px: number, py: number, lift: number) => {
    const el = floatRef.current;
    if (!el) return;
    // translate3d keeps this on the compositor. The old version animated left/top,
    // which forces layout on every frame of every drag.
    el.style.transform = `translate3d(${px}px, ${py - lift}px, 0) translate(-50%, -50%)`;
  }, []);

  const applyMove = useCallback(() => {
    rafRef.current = null;
    const live = liveRef.current;
    const p = pendingRef.current;
    if (!live || !p) return;
    live.px = p.px;
    live.py = p.py;

    paintFloat(p.px, p.py, live.meta.lift);

    const aim = originFrom(live.meta.shape, p.px, p.py, live.rect, live.meta.lift);
    const next = aim ? resolveSnap(live.meta.slot, live.meta.shape, aim) : null;

    // The grid only needs to re-render when the landing square or its legality
    // actually changes — a few times a second, not sixty.
    const prev = live.snap;
    const same =
      (prev === null && next === null) ||
      (prev !== null && next !== null && prev.r === next.r && prev.c === next.c && prev.valid === next.valid);
    live.snap = next;
    if (!same) setSnap(next);
  }, [originFrom, paintFloat, resolveSnap]);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!liveRef.current) return;
      // Coalesced events give every intermediate sample the browser buffered,
      // so a fast flick resolves against where the pointer really went.
      const last = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents().at(-1) ?? e : e;
      pendingRef.current = { px: last.clientX, py: last.clientY };
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(applyMove);
    },
    [applyMove]
  );

  const endDrag = useCallback(() => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange);
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    pendingRef.current = null;
    liveRef.current = null;
    setDragMeta(null);
    setSnap(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      const live = liveRef.current;
      if (live) {
        // Resolve at the exact release point — it can be newer than the last frame.
        const px = e.clientX ?? live.px;
        const py = e.clientY ?? live.py;
        // Dropping a piece back on the tray means "never mind". Without this,
        // a change of heart still counts as a move, because the edge tolerance
        // can reach the bottom row from just above the tray.
        const tray = trayRef.current?.getBoundingClientRect();
        const overTray =
          !!tray && px >= tray.left && px <= tray.right && py >= tray.top && py <= tray.bottom;
        if (!overTray) {
          const aim = originFrom(live.meta.shape, px, py, live.rect, live.meta.lift);
          const target = aim ? resolveSnap(live.meta.slot, live.meta.shape, aim) : null;
          if (target?.valid) placeRef.current(target.r, target.c, live.meta.slot);
        }
      }
      endDrag();
    },
    [endDrag, originFrom, resolveSnap]
  );

  /** A scroll or resize mid-drag invalidates the cached board rect. */
  const onViewportChange = useCallback(() => {
    const live = liveRef.current;
    const board = boardRef.current;
    if (!live || !board) return;
    live.rect = board.getBoundingClientRect();
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(applyMove);
  }, [applyMove]);

  const startDrag = useCallback(
    (e: React.PointerEvent, slot: number, shape: Shape) => {
      if (liveRef.current || endedRef.current) return;
      e.preventDefault();
      const board = boardRef.current;
      if (!board) return;
      const rect = board.getBoundingClientRect();
      const touch = e.pointerType === "touch";
      const pad = 8;
      const gap = 4;
      const pitch = (rect.width - 2 * pad + gap) / GRID;
      const meta: DragMeta = { slot, shape, touch, cell: pitch - gap, lift: touch ? pitch * 0.9 : 0 };

      const aim = originFrom(shape, e.clientX, e.clientY, rect, meta.lift);
      const first = aim ? resolveSnap(slot, shape, aim) : null;
      liveRef.current = { meta, rect, px: e.clientX, py: e.clientY, snap: first };
      pendingRef.current = { px: e.clientX, py: e.clientY };
      setDragMeta(meta);
      setSnap(first);

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      window.addEventListener("scroll", onViewportChange, true);
      window.addEventListener("resize", onViewportChange);
    },
    [originFrom, resolveSnap, onPointerMove, onPointerUp, onViewportChange]
  );

  // Place the floating piece at the pointer on the very first frame, so grabbing
  // a piece shows it immediately rather than only once the pointer moves.
  useEffect(() => {
    const live = liveRef.current;
    if (dragMeta && live) paintFloat(live.px, live.py, dragMeta.lift);
  }, [dragMeta, paintFloat]);

  useEffect(() => endDrag, [endDrag]);

  // Ghost footprint for the current drag
  const ghost = new Set<number>();
  if (dragMeta && snap) {
    for (const [dr, dc] of dragMeta.shape.cells) {
      const rr = snap.r + dr;
      const cc = snap.c + dc;
      if (rr >= 0 && cc >= 0 && rr < GRID && cc < GRID) ghost.add(rr * GRID + cc);
    }
  }

  // Rows/columns this drop would complete — they light up before you release.
  const willClear = new Set<number>();
  if (snap?.valid) {
    const g = state.grid.slice();
    for (const idx of ghost) g[idx] = true;
    for (let i = 0; i < GRID; i++) {
      let rowFull = true;
      let colFull = true;
      for (let j = 0; j < GRID; j++) {
        if (!g[i * GRID + j]) rowFull = false;
        if (!g[j * GRID + i]) colFull = false;
      }
      if (rowFull) for (let j = 0; j < GRID; j++) willClear.add(i * GRID + j);
      if (colFull) for (let j = 0; j < GRID; j++) willClear.add(j * GRID + i);
    }
  }
  const pct = (remaining / durationS) * 100;
  const low = remaining <= 10;

  return (
    <div className="mx-auto w-full max-w-[440px]">
      {/* Score + timer */}
      <div className="mb-3 flex items-end justify-between">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-[12px] font-medium uppercase tracking-wider text-muted">Score</p>
            {state.combo >= 2 && (
              // Shows what the streak is actually worth, and dims when a dry
              // placement has spent a life — so the risk is legible before the
              // streak dies rather than only after.
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[11px] font-bold transition-opacity duration-150",
                  state.comboLives === 0
                    ? "bg-gold/10 text-gold/60"
                    : "animate-pulse bg-gold/15 text-gold"
                )}
                title={
                  state.comboLives === 0
                    ? "One more placement without a clear ends the streak"
                    : `${state.comboLives} placement${state.comboLives === 1 ? "" : "s"} of slack left`
                }
              >
                COMBO ×{state.combo} · {state.comboMult.toFixed(1)}× pts
              </span>
            )}
          </div>
          <p className="tnum text-4xl font-bold leading-none">{state.score}</p>
        </div>
        <div className="text-right">
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                const next = !mute;
                setMute(next);
                setMuted(next);
              }}
              title={mute ? "Unmute" : "Mute"}
              aria-label={mute ? "Unmute" : "Mute"}
            >
              {mute ? <IconVolumeOff className="h-4 w-4" /> : <IconVolume className="h-4 w-4" />}
            </Button>
            <p className="text-[12px] font-medium uppercase tracking-wider text-muted">Time</p>
          </div>
          <p className={cn("tnum text-4xl font-bold leading-none", low && "text-loss")}>
            {Math.ceil(remaining)}
          </p>
        </div>
      </div>
      <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-surface">
        <div
          className={cn("h-full rounded-full transition-[width] duration-100 ease-linear", low ? "bg-loss" : "bg-gold")}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Board */}
      <div className="relative">
        <div
          ref={boardRef}
          className="grid aspect-square touch-none grid-cols-8 gap-1 rounded-2xl border border-border bg-surface p-2"
        >
          {Array.from({ length: GRID * GRID }, (_, idx) => {
            const r = Math.floor(idx / GRID);
            const c = idx % GRID;
            const color = colorRef.current[idx];
            const isGhost = ghost.has(idx);
            const isFlash = flash.includes(idx);
            const isWillClear = !isFlash && willClear.has(idx);
            return (
              <div
                key={idx}
                data-cell={`${r}-${c}`}
                className={cn(
                  "relative rounded-md",
                  // The ghost must appear the instant the target cell changes.
                  // A colour transition here reads as input lag, because it is.
                  isGhost ? "transition-none" : "transition-colors duration-100",
                  !color && !isGhost && !isFlash && "bg-bg",
                  isFlash && "ga-clearing",
                  isGhost && !isFlash && (snap?.valid ? "bg-gold/40" : "bg-loss/30"),
                  isWillClear && "ga-will-clear"
                )}
                style={color && !isFlash ? { backgroundColor: color } : undefined}
              >
                {color && !isFlash && (
                  <span className="absolute inset-x-0 top-0 h-1/3 rounded-t-md bg-white/25" />
                )}
              </div>
            );
          })}
        </div>

        {comboText && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="animate-pulse rounded-full bg-gold px-4 py-1.5 text-sm font-bold text-bg shadow-lg">
              {comboText}
            </span>
          </div>
        )}
        {state.over && (
          <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-bg/70 backdrop-blur-sm">
            <span className="text-sm font-semibold text-muted">Board stuck — nice run!</span>
          </div>
        )}
      </div>

      {/* Hand tray — drag any piece onto the board */}
      <div ref={trayRef} className="mt-4 grid grid-cols-3 gap-3">
        {state.hand.map((shape, slot) => {
          const dragging = dragMeta?.slot === slot;
          return (
            <div
              key={slot}
              onPointerDown={(e) => shape && startDrag(e, slot, shape)}
              className={cn(
                "flex h-24 touch-none items-center justify-center rounded-xl border transition-colors duration-150",
                shape == null
                  ? "border-border/50 bg-bg/40"
                  : dragging
                    ? "border-gold/40 bg-gold/[0.03] opacity-30"
                    : "cursor-grab border-border bg-surface hover:border-border-strong active:cursor-grabbing"
              )}
            >
              {shape && <PieceGlyph shape={shape} color={BLOCK_COLORS[slot % BLOCK_COLORS.length]!} unit={15} />}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-center text-[13px] text-muted">
        Drag any piece onto the board. Fill a full row or column to clear it.
      </p>

      {/* Floating piece — under the cursor (mouse) or above the finger (touch).
          Positioned at the origin and moved only by transform, so a drag never
          triggers layout. */}
      {dragMeta && (
        <div
          ref={floatRef}
          className="pointer-events-none fixed left-0 top-0 z-50 will-change-transform"
        >
          <PieceGlyph
            shape={dragMeta.shape}
            color={BLOCK_COLORS[dragMeta.slot % BLOCK_COLORS.length]!}
            unit={dragMeta.cell}
            gap={4}
          />
        </div>
      )}
    </div>
  );
}

function PieceGlyph({
  shape,
  color,
  unit,
  gap = 3,
}: {
  shape: Shape;
  color: string;
  unit: number;
  gap?: number;
}) {
  return (
    <div
      className="grid"
      style={{
        gap,
        gridTemplateColumns: `repeat(${shape.w}, ${unit}px)`,
        gridTemplateRows: `repeat(${shape.h}, ${unit}px)`,
      }}
    >
      {Array.from({ length: shape.w * shape.h }, (_, i) => {
        const r = Math.floor(i / shape.w);
        const c = i % shape.w;
        const on = shape.cells.some(([dr, dc]) => dr === r && dc === c);
        return (
          <div key={i} className="relative rounded-md" style={on ? { backgroundColor: color } : undefined}>
            {on && <span className="absolute inset-x-0 top-0 h-1/3 rounded-t-md bg-white/25" />}
          </div>
        );
      })}
    </div>
  );
}
