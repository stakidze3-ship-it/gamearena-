/**
 * Turn a production stack trace back into real file:line.
 *
 * `productionBrowserSourceMaps` publishes the .map files, but it does NOT
 * de-minify `error.stack` — that string is produced by the JS engine and still
 * reads `page-f69357b.js:1:12688`. Browser devtools resolve it for a human
 * looking at the console; a crash report arriving in a log does not get that
 * for free, and a stack nobody can read is the reason a one-line render bug
 * survived several deploys.
 *
 * This closes that gap. Feed it a stack — from a crash report, a log line, or
 * the console — and it prints the original source file, line, column and the
 * actual line of code for every frame it can map.
 *
 *   pbpaste | npx tsx tools/resolve-stack.ts
 *   npx tsx tools/resolve-stack.ts --file crash.txt
 *   npx tsx tools/resolve-stack.ts --file crash.txt --base https://gamearena-iota.vercel.app
 *
 * --base fetches maps from a live deployment. Note that Vercel serves .map
 * files behind auth (403 on the public alias), so for THIS deployment the
 * practical route is a local `next build` of the same commit: chunk hashes will
 * differ, so the resolver falls back to matching a chunk by its route and name
 * prefix, which is enough to map a production frame to a source line.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WEB = join(process.cwd(), "apps/web");

interface SourceMap {
  version: number;
  sources: string[];
  sourcesContent?: (string | null)[];
  mappings: string;
  names: string[];
}

/** Base64-VLQ alphabet, in index order. */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decode one base64-VLQ segment list.
 *
 * Hand-rolled rather than pulling in `source-map`: the format is small, and a
 * diagnostic tool that needs a dependency install before it can be used in an
 * incident is a tool that does not get used.
 */
function decodeVlq(segment: string): number[] {
  const out: number[] = [];
  let shift = 0;
  let value = 0;
  for (const ch of segment) {
    const digit = B64.indexOf(ch);
    if (digit < 0) throw new Error(`bad VLQ char ${ch}`);
    const cont = digit & 32;
    value += (digit & 31) << shift;
    if (cont) {
      shift += 5;
    } else {
      const negative = value & 1;
      value >>= 1;
      out.push(negative ? (value === 0 ? -0x80000000 : -value) : value);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

interface Mapping {
  genLine: number;
  genCol: number;
  srcIndex: number;
  srcLine: number;
  srcCol: number;
}

function parseMappings(map: SourceMap): Mapping[] {
  const all: Mapping[] = [];
  let srcIndex = 0;
  let srcLine = 0;
  let srcCol = 0;
  map.mappings.split(";").forEach((lineStr, genLine) => {
    let genCol = 0;
    if (!lineStr) return;
    for (const seg of lineStr.split(",")) {
      if (!seg) continue;
      const f = decodeVlq(seg);
      genCol += f[0]!;
      if (f.length >= 4) {
        srcIndex += f[1]!;
        srcLine += f[2]!;
        srcCol += f[3]!;
        all.push({ genLine, genCol, srcIndex, srcLine, srcCol });
      }
    }
  });
  return all;
}

/** Nearest mapping at or before (line, col) — how a stack frame resolves. */
function lookup(mappings: Mapping[], line: number, col: number): Mapping | null {
  let best: Mapping | null = null;
  for (const m of mappings) {
    if (m.genLine !== line - 1) continue;
    if (m.genCol > col - 1) continue;
    if (!best || m.genCol > best.genCol) best = m;
  }
  return best;
}

const cache = new Map<string, { map: SourceMap; mappings: Mapping[] } | null>();

async function loadMap(chunkPath: string, base: string | null) {
  if (cache.has(chunkPath)) return cache.get(chunkPath)!;
  let raw: string | null = null;
  if (base) {
    try {
      const res = await fetch(`${base}${chunkPath}.map`);
      if (res.ok) raw = await res.text();
    } catch {
      /* fall through to the local build */
    }
  }
  if (!raw) {
    const rel = decodeURIComponent(chunkPath).replace(/^\/_next\//, "");
    const local = join(WEB, ".next", rel);
    if (existsSync(`${local}.map`)) {
      raw = readFileSync(`${local}.map`, "utf8");
    } else {
      // Fall back to the same chunk from a different build.
      //
      // Vercel serves .map files behind auth — a production stack cannot fetch
      // its own map, and a local rebuild of the same commit gets a different
      // content hash anyway (the commit sha is baked into the bundle). Matching
      // on the route path and the name before the hash resolves a production
      // frame against a local build of the same code, which is the only way
      // this works in practice.
      const dir = join(WEB, ".next", rel.replace(/\/[^/]+$/, ""));
      const base = rel.replace(/^.*\//, "").replace(/-[a-f0-9]{8,}\.js$/, "");
      if (existsSync(dir)) {
        const hit = readdirSync(dir).find(
          (f) => f.endsWith(".js.map") && f.startsWith(`${base}-`)
        );
        if (hit) {
          console.log(`  · ${rel} not built here; using ${hit}`);
          raw = readFileSync(join(dir, hit), "utf8");
        }
      }
    }
  }
  if (!raw) {
    cache.set(chunkPath, null);
    return null;
  }
  const map = JSON.parse(raw) as SourceMap;
  const entry = { map, mappings: parseMappings(map) };
  cache.set(chunkPath, entry);
  return entry;
}

/**
 * `at fn (http://host/_next/static/chunks/x.js:1:2)` and the anonymous variant.
 *
 * The URL part must allow parentheses: App Router route groups put them in the
 * path — `/chunks/app/(app)/tournaments/…` — so a charset that stops at `)`
 * truncates every frame in exactly the files worth resolving. Anchoring on the
 * trailing `:line:col` instead makes the parens harmless.
 */
const FRAME = /at\s+(?:(.+?)\s+)?\(?((?:https?:\/\/|\/_next\/)\S+?):(\d+):(\d+)\)?\s*$/;

(async () => {
  const argv = process.argv.slice(2);
  const fileArg = argv.indexOf("--file");
  const baseArg = argv.indexOf("--base");
  const base = baseArg >= 0 ? argv[baseArg + 1]!.replace(/\/$/, "") : null;
  const input =
    fileArg >= 0 ? readFileSync(argv[fileArg + 1]!, "utf8") : readFileSync(0, "utf8");

  console.log(`\nRESOLVED STACK${base ? ` · maps from ${base}` : " · maps from apps/web/.next"}\n`);

  let mapped = 0;
  let total = 0;
  for (const line of input.split("\n")) {
    const m = line.match(FRAME);
    if (!m) continue;
    total++;
    const [, fnName, urlRaw, lineNo, colNo] = m;
    const path = urlRaw!.startsWith("http") ? new URL(urlRaw!).pathname : urlRaw!;
    const entry = await loadMap(path, base);
    if (!entry) {
      console.log(`  ?  ${fnName ?? "(anonymous)"}  ${path}:${lineNo}:${colNo}  [no source map]`);
      continue;
    }
    const hit = lookup(entry.mappings, Number(lineNo), Number(colNo));
    if (!hit) {
      console.log(`  ?  ${fnName ?? "(anonymous)"}  ${path}:${lineNo}:${colNo}  [unmapped]`);
      continue;
    }
    mapped++;
    const src = (entry.map.sources[hit.srcIndex] ?? "?").replace(/^webpack:\/\/(_N_E)?\//, "");
    const content = entry.map.sourcesContent?.[hit.srcIndex];
    const code = content ? content.split("\n")[hit.srcLine]?.trim() : undefined;
    console.log(`  →  ${fnName ?? "(anonymous)"}`);
    console.log(`     ${src}:${hit.srcLine + 1}:${hit.srcCol + 1}`);
    if (code) console.log(`     | ${code.slice(0, 140)}`);
  }
  console.log(`\n  ${mapped}/${total} frames resolved\n`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
