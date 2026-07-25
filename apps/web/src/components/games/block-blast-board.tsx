"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BlockBlastEngine, GRID, type BlockBlastInput, type Shape } from "@gamearena/games";
import { Button } from "@/components/ui/button";
import { IconVolume, IconVolumeOff } from "@/components/icons";
import { cn } from "@/lib/cn";
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

interface DragState {
  slot: number;
  shape: Shape;
  px: number;
  py: number;
  origin: { r: number; c: number } | null;
  valid: boolean;
  rect: DOMRect;
  touch: boolean;
}

export function BlockBlastBoard({
  seed,
  durationS,
  onEnd,
  onInput,
}: {
  seed: string;
  durationS: number;
  onEnd: (result: BlockBlastResult) => void;
  /** Fires on every legal placement — used to stream inputs live in 1v1. */
  onInput?: (input: BlockBlastInput) => void;
}) {
  const engineRef = useRef<BlockBlastEngine | null>(null);
  if (!engineRef.current) engineRef.current = new BlockBlastEngine(seed);

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
  const [drag, setDrag] = useState<DragState | null>(null);
  const [mute, setMute] = useState(false);
  useEffect(() => setMute(initMuted()), []);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<{ px: number; py: number } | null>(null);

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
  // Forgiving placement: snap to the nearest cell and CLAMP so the whole piece
  // always fits on the board — just drag it roughly where you want. On a mouse
  // the piece sits right under the cursor (no lift); on touch it floats above
  // the finger so you can see it. The board rect is measured once per drag and
  // moves are coalesced to one update per frame (rAF) to keep it smooth.
  const originFrom = useCallback(
    (shape: Shape, px: number, py: number, rect: DOMRect, touch: boolean) => {
      const pad = 8; // p-2
      const gap = 4; // gap-1
      const pitch = (rect.width - 2 * pad + gap) / GRID; // cell centre-to-centre
      const lift = touch ? pitch * 0.9 : 0;
      const sx = px - rect.left - pad;
      const sy = py - lift - rect.top - pad;
      if (sx < -pitch || sx > rect.width || sy < -pitch * 2 || sy > rect.height + pitch) return null;
      const centerC = Math.floor(sx / pitch);
      const centerR = Math.floor(sy / pitch);
      const r = Math.max(0, Math.min(GRID - shape.h, centerR - Math.floor(shape.h / 2)));
      const c = Math.max(0, Math.min(GRID - shape.w, centerC - Math.floor(shape.w / 2)));
      return { r, c };
    },
    []
  );

  const applyMove = useCallback(() => {
    rafRef.current = null;
    const d = dragRef.current;
    const p = pendingRef.current;
    if (!d || !p) return;
    const origin = originFrom(d.shape, p.px, p.py, d.rect, d.touch);
    const valid = origin ? engineRef.current!.previewFits(d.slot, origin.r, origin.c) : false;
    const next = { ...d, px: p.px, py: p.py, origin, valid };
    dragRef.current = next;
    setDrag(next);
  }, [originFrom]);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragRef.current) return;
      pendingRef.current = { px: e.clientX, py: e.clientY };
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(applyMove);
    },
    [applyMove]
  );

  const onPointerUp = useCallback(() => {
    const d = dragRef.current;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (d) {
      // Drop at the exact release position (may be newer than the last frame).
      const p = pendingRef.current ?? { px: d.px, py: d.py };
      const origin = originFrom(d.shape, p.px, p.py, d.rect, d.touch);
      if (origin && engineRef.current!.previewFits(d.slot, origin.r, origin.c)) {
        placeRef.current(origin.r, origin.c, d.slot);
      }
    }
    pendingRef.current = null;
    dragRef.current = null;
    setDrag(null);
  }, [onPointerMove, originFrom]);

  const startDrag = useCallback(
    (e: React.PointerEvent, slot: number, shape: Shape) => {
      if (dragRef.current || endedRef.current) return;
      e.preventDefault();
      const board = boardRef.current;
      if (!board) return;
      const rect = board.getBoundingClientRect();
      const touch = e.pointerType === "touch";
      const origin = originFrom(shape, e.clientX, e.clientY, rect, touch);
      const valid = origin ? engineRef.current!.previewFits(slot, origin.r, origin.c) : false;
      const d = { slot, shape, px: e.clientX, py: e.clientY, origin, valid, rect, touch };
      dragRef.current = d;
      setDrag(d);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [originFrom, onPointerMove, onPointerUp]
  );

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  // Ghost footprint for the current drag
  const ghost = new Set<number>();
  if (drag?.origin) {
    for (const [dr, dc] of drag.shape.cells) {
      const rr = drag.origin.r + dr;
      const cc = drag.origin.c + dc;
      if (rr >= 0 && cc >= 0 && rr < GRID && cc < GRID) ghost.add(rr * GRID + cc);
    }
  }

  // Rows/columns this drop would complete — they light up before you release.
  const willClear = new Set<number>();
  if (drag?.origin && drag.valid) {
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
  // Cell size for the floating piece — from the drag's cached rect (no reflow).
  const cellSize = drag ? drag.rect.width / GRID : 44;
  const floatLift = drag?.touch ? cellSize * 0.9 : 0;

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
              <span className="animate-pulse rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-bold text-gold">
                🔥 COMBO ×{state.combo}
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
        <div ref={boardRef} className="grid aspect-square grid-cols-8 gap-1 rounded-2xl border border-border bg-surface p-2">
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
                  "relative rounded-md transition-colors duration-100",
                  !color && !isGhost && !isFlash && "bg-bg",
                  isFlash && "ga-clearing",
                  isGhost && !isFlash && (drag?.valid ? "bg-gold/40" : "bg-loss/30"),
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
      <div className="mt-4 grid grid-cols-3 gap-3">
        {state.hand.map((shape, slot) => {
          const dragging = drag?.slot === slot;
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

      {/* Floating piece — under the cursor (mouse) or above the finger (touch) */}
      {drag && (
        <div
          className="pointer-events-none fixed z-50"
          style={{ left: drag.px, top: drag.py - floatLift, transform: "translate(-50%, -50%)" }}
        >
          <PieceGlyph shape={drag.shape} color={BLOCK_COLORS[drag.slot % BLOCK_COLORS.length]!} unit={cellSize} gap={4} />
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
