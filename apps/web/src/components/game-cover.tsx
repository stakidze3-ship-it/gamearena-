import { useId } from "react";
import Image from "next/image";
import { cn } from "@/lib/cn";
import { LiveBadge } from "@/components/ui/live-badge";

/**
 * <GameCover game="block-blast" /> — rich key-art cover built as a layered
 * SVG/CSS composition. No image files: crisp at any size, zero loading,
 * themeable per game. New games register a palette + scene below.
 *
 * Layers (back→front): gradient bg → radial glow → far elements (blurred)
 * → near elements (float animation) → grain overlay → badge / lock (HTML).
 * Hover parallax + brightness comes from .ga-cover-* classes (globals.css);
 * the parent card supplies the `group` class.
 */

export type GameCoverProps = {
  game: string;
  live?: boolean;
  className?: string;
};

/**
 * Games with painted key art use an image cover; the rest fall back to the
 * procedural SVG scenes. The source PNG had card UI baked in (title, chips,
 * buttons, frame) — it's been physically cropped to the artwork band only
 * (see public/games), so a plain object-cover shows pure art at any size.
 * Our real LIVE badge overlays the top-right; `objectPos` biases the crop so
 * the composition's focal point stays centered.
 */
interface ImageCover {
  src: string;
  width: number;
  height: number;
  objectPos: string;
}

const IMAGE_COVERS: Record<string, ImageCover> = {
  "block-blast": {
    src: "/games/block-blast-cover.png",
    width: 1460,
    height: 556,
    objectPos: "50% 42%", // bias toward the glowing hero blocks
  },
  "bricks-breaker": {
    src: "/games/bricks-breaker-cover.png",
    width: 1536,
    height: 468,
    objectPos: "50% 50%", // shatter burst stays centered
  },
};

export function GameCover({ game, live = true, className }: GameCoverProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const Scene = SCENES[game] ?? BlockBlastScene;
  const accent = ACCENTS[game] ?? ACCENTS["block-blast"]!;
  const art = IMAGE_COVERS[game];

  return (
    <div
      // Aspect ~2.6:1 matches the artwork so object-cover shows ≥80% of it, and
      // the banner height scales with card width. Inline style (not a Tailwind
      // arbitrary class) so it always applies without a JIT rebuild.
      style={{ aspectRatio: "13 / 5" }}
      className={cn("relative w-full select-none overflow-hidden", className)}
      aria-hidden
    >
      {art ? (
        <>
          <Image
            src={art.src}
            width={art.width}
            height={art.height}
            alt=""
            loading="lazy"
            unoptimized
            className={cn(
              "ga-cover-svg absolute inset-0 h-full w-full object-cover",
              !live && "saturate-[.6]"
            )}
            style={{ objectPosition: art.objectPos }}
          />
          {/* blend the crop edge into the card background */}
          <div className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-b from-transparent to-surface" />
        </>
      ) : (
        <svg
          className={cn("ga-cover-svg absolute inset-0 h-full w-full", !live && "saturate-[.6]")}
          viewBox="0 0 640 240"
          preserveAspectRatio="xMidYMid slice"
        >
          <Scene uid={uid} />
          <GrainOverlay uid={uid} />
        </svg>
      )}

      <LiveBadge live={live} accent={accent} className="absolute right-3 top-3" />

      {!live && (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="absolute bottom-2.5 right-3 h-4 w-4 text-fg opacity-70"
          aria-hidden
        >
          <rect x="5" y="11" width="14" height="9" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
      )}
    </div>
  );
}

const ACCENTS: Record<string, string> = {
  "block-blast": "var(--color-violet)",
  "bricks-breaker": "var(--color-amber)",
};

const SCENES: Record<string, (p: { uid: string }) => React.ReactNode> = {
  "block-blast": BlockBlastScene,
  "bricks-breaker": BricksBreakerScene,
};

/* ── Shared pieces ─────────────────────────────────────────────────────── */

function GrainOverlay({ uid }: { uid: string }) {
  return (
    <>
      <filter id={`${uid}-grain`}>
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
        <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.6 0" />
      </filter>
      <rect width="640" height="240" filter={`url(#${uid}-grain)`} opacity="0.05" />
    </>
  );
}

/** Glossy rounded cube with top highlight, bottom shade and drop shadow. */
function Cube({
  x,
  y,
  s,
  fill,
  rot = 0,
  shadow,
  opacity = 1,
  blur,
}: {
  x: number;
  y: number;
  s: number;
  fill: string;
  rot?: number;
  shadow?: string;
  opacity?: number;
  blur?: string;
}) {
  const r = s * 0.24;
  return (
    <g
      transform={`translate(${x} ${y}) rotate(${rot} ${s / 2} ${s / 2})`}
      opacity={opacity}
      filter={blur}
    >
      <rect width={s} height={s} rx={r} fill={fill} filter={shadow} />
      {/* glossy top light */}
      <rect x={s * 0.09} y={s * 0.07} width={s * 0.82} height={s * 0.38} rx={r * 0.8} fill="#fff" opacity="0.30" />
      {/* bottom depth shade */}
      <rect x={s * 0.09} y={s * 0.62} width={s * 0.82} height={s * 0.30} rx={r * 0.7} fill="#000" opacity="0.14" />
      {/* crisp edge */}
      <rect width={s} height={s} rx={r} fill="none" stroke="#fff" strokeOpacity="0.14" strokeWidth="1.5" />
    </g>
  );
}

/* ── Block Blast: violet identity ──────────────────────────────────────── */

function BlockBlastScene({ uid }: { uid: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${uid}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4A3BD8" />
          <stop offset="0.55" stopColor="#2C2185" />
          <stop offset="1" stopColor="#1B1458" />
        </linearGradient>
        <radialGradient id={`${uid}-glow`} cx="0.28" cy="0.42" r="0.55">
          <stop offset="0" stopColor="#9D8CFF" stopOpacity="0.55" />
          <stop offset="1" stopColor="#9D8CFF" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${uid}-violet`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#A79AFF" />
          <stop offset="1" stopColor="#6C5CE7" />
        </linearGradient>
        <linearGradient id={`${uid}-magenta`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F49BF2" />
          <stop offset="1" stopColor="#C33FD4" />
        </linearGradient>
        <linearGradient id={`${uid}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9BE0FF" />
          <stop offset="1" stopColor="#38A8E8" />
        </linearGradient>
        <linearGradient id={`${uid}-mint`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8BF3CE" />
          <stop offset="1" stopColor="#10C08A" />
        </linearGradient>
        <filter id={`${uid}-drop`} x="-40%" y="-40%" width="180%" height="200%">
          <feDropShadow dx="0" dy="9" stdDeviation="9" floodColor="#0A0630" floodOpacity="0.45" />
        </filter>
        <filter id={`${uid}-soft`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2" />
        </filter>
        <filter id={`${uid}-burst`} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
      </defs>

      <rect width="640" height="240" fill={`url(#${uid}-bg)`} />
      <rect width="640" height="240" fill={`url(#${uid}-glow)`} />

      {/* faint board rows, bottom-left */}
      <g opacity="0.5">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <rect key={`a${i}`} x={86 + i * 40} y={178} width={34} height={34} rx={8} fill="#fff" opacity="0.06" />
        ))}
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <rect key={`b${i}`} x={86 + i * 40} y={216} width={34} height={34} rx={8} fill="#fff" opacity="0.04" />
        ))}
      </g>

      {/* row mid-clear: hot cells + glow + particles */}
      <g className="ga-cover-far">
        <rect x={166} y={178} width={154} height={34} rx={8} fill="#CFC5FF" opacity="0.8" filter={`url(#${uid}-burst)`} />
        <rect x={166} y={178} width={34} height={34} rx={8} fill="#FFFFFF" opacity="0.95" />
        <rect x={206} y={178} width={34} height={34} rx={8} fill="#F2EEFF" opacity="0.95" />
        <rect x={246} y={178} width={34} height={34} rx={8} fill="#FFFFFF" opacity="0.9" />
        <rect x={286} y={178} width={34} height={34} rx={8} fill="#E9E3FF" opacity="0.85" />
        {/* sparks */}
        <rect x={150} y={170} width={16} height={2.5} rx={1.25} fill="#fff" opacity="0.85" transform="rotate(-24 158 171)" />
        <rect x={318} y={166} width={14} height={2.5} rx={1.25} fill="#fff" opacity="0.8" transform="rotate(18 325 167)" />
        <rect x={230} y={160} width={12} height={2.5} rx={1.25} fill="#CFC5FF" opacity="0.9" transform="rotate(40 236 161)" />
        {/* particles */}
        <circle cx={158} cy={158} r={3} fill="#fff" opacity="0.9" />
        <circle cx={196} cy={148} r={2} fill="#CFC5FF" opacity="0.8" />
        <circle cx={262} cy={142} r={2.6} fill="#fff" opacity="0.75" />
        <circle cx={306} cy={152} r={2} fill="#E5DEFF" opacity="0.85" />
        <circle cx={338} cy={172} r={2.4} fill="#fff" opacity="0.7" />
        <circle cx={128} cy={176} r={2} fill="#CFC5FF" opacity="0.7" />
      </g>

      {/* far cubes — smaller, blurred */}
      <g className="ga-cover-far">
        <Cube x={140} y={44} s={26} rot={-18} fill={`url(#${uid}-mint)`} blur={`url(#${uid}-soft)`} opacity={0.75} />
        <Cube x={508} y={34} s={22} rot={24} fill={`url(#${uid}-magenta)`} blur={`url(#${uid}-soft)`} opacity={0.7} />
        <Cube x={586} y={132} s={24} rot={-12} fill={`url(#${uid}-sky)`} blur={`url(#${uid}-soft)`} opacity={0.6} />
      </g>

      {/* mid cubes */}
      <g className="ga-float-b">
        <Cube x={236} y={34} s={38} rot={-10} fill={`url(#${uid}-violet)`} shadow={`url(#${uid}-drop)`} />
        <Cube x={420} y={52} s={42} rot={12} fill={`url(#${uid}-sky)`} shadow={`url(#${uid}-drop)`} />
      </g>

      {/* near cubes — the hero cluster */}
      <g className="ga-float-a">
        <Cube x={306} y={84} s={66} rot={-8} fill={`url(#${uid}-violet)`} shadow={`url(#${uid}-drop)`} />
        <Cube x={452} y={108} s={54} rot={14} fill={`url(#${uid}-magenta)`} shadow={`url(#${uid}-drop)`} />
        <Cube x={176} y={98} s={48} rot={9} fill={`url(#${uid}-mint)`} shadow={`url(#${uid}-drop)`} />
      </g>
    </>
  );
}

/* ── Bricks Breaker: amber identity ────────────────────────────────────── */

function Brick({
  x,
  y,
  s = 56,
  fill,
  num,
  ink = "#7A4A00",
  rot = 0,
  shadow,
  opacity = 1,
  blur,
}: {
  x: number;
  y: number;
  s?: number;
  fill: string;
  num?: number;
  ink?: string;
  rot?: number;
  shadow?: string;
  opacity?: number;
  blur?: string;
}) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rot} ${s / 2} ${s / 2})`} opacity={opacity} filter={blur}>
      <rect width={s} height={s} rx={s * 0.2} fill={fill} filter={shadow} />
      <rect x={s * 0.08} y={s * 0.06} width={s * 0.84} height={s * 0.4} rx={s * 0.16} fill="#fff" opacity="0.28" />
      <rect width={s} height={s} rx={s * 0.2} fill="none" stroke="#fff" strokeOpacity="0.18" strokeWidth="1.5" />
      {num !== undefined && (
        <text
          x={s / 2}
          y={s / 2 + s * 0.13}
          textAnchor="middle"
          fontSize={s * 0.42}
          fontWeight="800"
          fill={ink}
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {num}
        </text>
      )}
    </g>
  );
}

function BricksBreakerScene({ uid }: { uid: string }) {
  return (
    <>
      <defs>
        <linearGradient id={`${uid}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFB020" />
          <stop offset="0.55" stopColor="#F07A12" />
          <stop offset="1" stopColor="#D14E08" />
        </linearGradient>
        <radialGradient id={`${uid}-glow`} cx="0.78" cy="0.16" r="0.5">
          <stop offset="0" stopColor="#FFE9B0" stopOpacity="0.75" />
          <stop offset="1" stopColor="#FFE9B0" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${uid}-ball`} cx="0.35" cy="0.3" r="0.9">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.75" stopColor="#F2F1F7" />
          <stop offset="1" stopColor="#D9D8E4" />
        </radialGradient>
        <filter id={`${uid}-drop`} x="-40%" y="-40%" width="180%" height="200%">
          <feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#6B2A00" floodOpacity="0.4" />
        </filter>
        <filter id={`${uid}-soft`} x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2" />
        </filter>
        <filter id={`${uid}-flash`} x="-120%" y="-120%" width="340%" height="340%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
      </defs>

      <rect width="640" height="240" fill={`url(#${uid}-bg)`} />
      <rect width="640" height="240" fill={`url(#${uid}-glow)`} />

      {/* far bricks, blurred */}
      <g className="ga-cover-far">
        <Brick x={352} y={22} s={34} fill="#FF9D8A" blur={`url(#${uid}-soft)`} opacity={0.55} rot={-8} />
        <Brick x={286} y={48} s={28} fill="#FFCF70" blur={`url(#${uid}-soft)`} opacity={0.5} rot={10} />
      </g>

      {/* dotted launch trajectory */}
      <path
        d="M 60 216 Q 300 40 505 95"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray="0.1 17"
        opacity="0.85"
      />

      {/* brick wall, right — kept clear of the status badge zone */}
      <g className="ga-cover-near">
        <Brick x={402} y={46} fill="#FFC24D" num={34} shadow={`url(#${uid}-drop)`} rot={-2} />
        <Brick x={468} y={54} fill="#FF7B6B" num={12} ink="#FFFFFF" shadow={`url(#${uid}-drop)`} rot={3} />
        <Brick x={534} y={46} fill="#FFF7EE" num={61} ink="#C2410C" shadow={`url(#${uid}-drop)`} rot={-1} />
        <Brick x={536} y={112} fill="#FFC24D" num={27} shadow={`url(#${uid}-drop)`} rot={2} />
      </g>

      {/* impact flash + brick mid-shatter */}
      <g className="ga-float-b">
        <circle cx={472} cy={112} r={15} fill="#FFF6D8" filter={`url(#${uid}-flash)`} opacity="0.9" />
        {/* fragments */}
        <rect x={452} y={118} width={20} height={16} rx={5} fill="#FF9A45" transform="rotate(-24 462 126)" filter={`url(#${uid}-drop)`} />
        <rect x={480} y={124} width={16} height={13} rx={4} fill="#FFB86B" transform="rotate(28 488 130)" />
        <rect x={436} y={140} width={13} height={11} rx={3.5} fill="#FF8A3D" transform="rotate(-42 442 145)" />
        <rect x={470} y={148} width={10} height={9} rx={3} fill="#FFCE8F" transform="rotate(50 475 152)" />
        <rect x={498} y={142} width={8} height={7} rx={2.5} fill="#FFDCA8" transform="rotate(-30 502 145)" />
        {/* particles */}
        <circle cx={444} cy={112} r={2.6} fill="#fff" opacity="0.9" />
        <circle cx={490} cy={100} r={2} fill="#FFEBC4" opacity="0.9" />
        <circle cx={508} cy={126} r={2.4} fill="#fff" opacity="0.75" />
        <circle cx={462} cy={162} r={2} fill="#FFE0A6" opacity="0.8" />
        <circle cx={430} cy={128} r={1.8} fill="#fff" opacity="0.7" />
      </g>

      {/* glossy balls along the arc */}
      <g className="ga-float-a">
        {[
          { cx: 200, cy: 131, r: 15 },
          { cx: 335, cy: 88, r: 12 },
          { cx: 443, cy: 84, r: 10 },
        ].map((b, i) => (
          <g key={i}>
            <circle cx={b.cx} cy={b.cy} r={b.r} fill={`url(#${uid}-ball)`} filter={`url(#${uid}-drop)`} />
            <circle cx={b.cx - b.r * 0.32} cy={b.cy - b.r * 0.38} r={b.r * 0.26} fill="#fff" opacity="0.95" />
          </g>
        ))}
      </g>

      {/* launcher hint, bottom-left */}
      <g opacity="0.9">
        <circle cx={60} cy={216} r={17} fill="#FFF7EE" filter={`url(#${uid}-drop)`} />
        <circle cx={54} cy={210} r={4.5} fill="#fff" />
      </g>
    </>
  );
}
