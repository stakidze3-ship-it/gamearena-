/**
 * Catches hooks that sit below an early return.
 *
 * React requires every hook to run on every render, in the same order. A hook
 * placed after a conditional `return` runs on some renders and not others, and
 * React throws "Rendered fewer hooks than expected" — as a render error, so the
 * whole screen dies rather than degrading.
 *
 * This shipped once already: a useMemo below the `phase === "playing"` return in
 * the tournament screen meant that clicking Ready Up crashed the page and no
 * tournament match could be played at all. Typecheck cannot see it, and there
 * is no ESLint in this repo, so nothing was watching.
 *
 * Deliberately simple: track brace depth, and within a component function flag
 * any hook call at depth 1 that appears after a `return` at depth 1. That is
 * exactly the failing shape and nothing else.
 *
 *   npx tsx tools/check-hook-order.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["apps/web/src"];
const HOOK = /\b(use[A-Z]\w*)\s*\(/;
/** A component or custom hook — the only places the rule applies. */
const COMPONENT = /^\s*(?:export\s+)?(?:default\s+)?function\s+([A-Z]\w*|use[A-Z]\w*)\s*\(/;

interface Finding {
  file: string;
  line: number;
  hook: string;
  returnLine: number;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

function scan(file: string): Finding[] {
  const src = readFileSync(file, "utf8");
  if (!src.includes("use")) return [];
  const lines = src.split("\n");
  const findings: Finding[] = [];

  // Indentation, not brace depth. This codebase is Prettier-formatted with two
  // spaces, so a component's own statements sit at exactly two — which cleanly
  // separates them from returns inside callbacks (four or more), the false
  // positives that a depth counter cannot tell apart.
  const TOP = /^ {2}(?! )/;
  const TOP_RETURN = /^ {2}return\b/;
  const TOP_IF = /^ {2}if\b/;
  const NESTED_RETURN = /^ {4}(?! )return\b/;
  const TOP_HOOK = /^ {2}(?:(?:const|let|var)\s+[^=]+=\s*)?(use[A-Z]\w*)\s*\(/;
  const CLOSE = /^ {2}\}/;

  // A file holds several components. Without resetting at each declaration,
  // the first early return anywhere would condemn every hook below it in the
  // whole file — 51 false positives on a clean tree, which is how a checker
  // gets switched off.
  const DECL = /^(?:export\s+)?(?:default\s+)?function\s+(?:[A-Z]\w*|use[A-Z]\w*)\s*\(/;

  let earlyReturnLine = 0;
  let inTopIf = false;

  for (let i = 0; i < lines.length; i++) {
    const code = lines[i]!.replace(/\/\/.*$/, "");
    if (DECL.test(code)) {
      earlyReturnLine = 0;
      inTopIf = false;
      continue;
    }
    if (!TOP.test(code) && !NESTED_RETURN.test(code) && !CLOSE.test(code)) continue;

    if (TOP_IF.test(code)) inTopIf = true;
    else if (CLOSE.test(code)) inTopIf = false;

    // A bare top-level return, or one inside a top-level `if` — both end the
    // render before anything below them runs.
    if (earlyReturnLine === 0) {
      if (TOP_RETURN.test(code)) earlyReturnLine = i + 1;
      else if (inTopIf && NESTED_RETURN.test(code)) earlyReturnLine = i + 1;
    }

    const m = code.match(TOP_HOOK);
    if (m && earlyReturnLine > 0) {
      findings.push({ file, line: i + 1, hook: m[1]!, returnLine: earlyReturnLine });
    }
  }
  return findings;
}

const files = ROOTS.flatMap((r) => walk(r));
const findings = files.flatMap(scan);

console.log(`\nHOOK ORDER · ${files.length} files scanned\n`);
if (findings.length === 0) {
  console.log("  ✓ no hook sits below an early return\n");
  process.exit(0);
}
for (const f of findings) {
  console.log(`  ✗ ${f.file}:${f.line}`);
  console.log(`      ${f.hook}() runs after an early return on line ${f.returnLine}`);
  console.log("      React will throw \"Rendered fewer hooks than expected\" and kill the screen.\n");
}
console.log(`FAIL (${findings.length})\n`);
process.exit(1);
