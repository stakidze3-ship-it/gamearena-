/**
 * Tiny Web Audio synth for game feedback — no audio files, no deps.
 * The clear sound climbs a pentatonic ladder with the combo streak: the higher
 * the combo, the higher, louder and richer the sound.
 *
 * Browsers block audio until a user gesture; the context is created lazily on
 * the first placement (which is always a pointer interaction).
 */

let ctx: AudioContext | null = null;
let muted = false;

const MUTE_KEY = "ga.muted";

export function initMuted(): boolean {
  if (typeof window !== "undefined") muted = window.localStorage.getItem(MUTE_KEY) === "1";
  return muted;
}

export function setMuted(m: boolean): void {
  muted = m;
  if (typeof window !== "undefined") window.localStorage.setItem(MUTE_KEY, m ? "1" : "0");
}

function audio(): AudioContext | null {
  if (typeof window === "undefined" || muted) return null;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx) ctx = new Ctor();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(
  freq: number,
  durMs: number,
  type: OscillatorType = "sine",
  peak = 0.15,
  delayMs = 0
): void {
  const c = audio();
  if (!c) return;
  const t0 = c.currentTime + delayMs / 1000;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + durMs / 1000 + 0.02);
}

/** Soft thud when a piece lands. */
export function playPlace(): void {
  tone(200, 70, "triangle", 0.07);
}

// C5 D5 E5 G5 A5 C6 D6 E6 — pentatonic, always pleasant however far it climbs.
const LADDER = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51];

/** Line-clear sound — pitch, volume and harmonics all rise with the combo. */
export function playClear(lines: number, combo: number): void {
  const step = Math.min(LADDER.length - 1, Math.max(0, combo - 1));
  const base = LADDER[step]!;
  const peak = Math.min(0.3, 0.12 + combo * 0.028);
  const dur = 200 + combo * 35;

  tone(base, dur, "sine", peak);
  tone(base * 1.5, dur * 0.8, "sine", peak * 0.5, 28); // fifth
  if (lines >= 2) tone(base * 2, dur * 0.7, "triangle", peak * 0.5, 55); // multi-line sparkle
  if (combo >= 3) tone(base * 2.5, dur * 0.6, "sine", peak * 0.45, 85); // high-combo shimmer
  if (combo >= 5) tone(base * 3, dur * 0.5, "triangle", peak * 0.4, 115); // fever
}

/** Low fall when the board jams. */
export function playGameOver(): void {
  tone(196, 380, "sine", 0.1);
  tone(147, 460, "sine", 0.09, 110);
}
