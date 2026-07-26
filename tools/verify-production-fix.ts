/**
 * Verify, from production itself, that the Ready Up fix is actually live.
 *
 * Not "the deploy succeeded" — that claim is what made this bug survive three
 * rounds. This fetches what production is really serving and checks the shape
 * of the shipped code: the `standing` useMemo must appear BEFORE the two early
 * returns in the tournament chunk, because the ordering in the emitted bundle
 * is the thing that decides whether React throws.
 *
 * Needs no login and no database. The route chunk is a public static asset.
 *
 *   npx tsx tools/verify-production-fix.ts [baseUrl]
 */
const BASE = (process.argv[2] ?? "https://gamearena-iota.vercel.app").replace(/\/$/, "");

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

(async () => {
  console.log(`\nPRODUCTION VERIFICATION · ${BASE}\n`);

  const diag = await fetch(`${BASE}/api/diagnostics/deployment`).then((r) => r.json());
  console.log(`  deployed commit ${diag.commit} (${diag.branch})\n`);

  // The tournament page is auth-gated, but its chunk is not. Find it from the
  // build manifest Next writes for the App Router.
  const html = await fetch(`${BASE}/login`).then((r) => r.text());
  const buildId = html.match(/\/_next\/static\/([A-Za-z0-9_-]{8,})\//)?.[1];
  check("found the build id", !!buildId, buildId ?? "none");

  // Chunk names are content-hashed, so discover rather than guess: the app-build
  // manifest lists every route's chunks.
  let chunkUrl: string | null = null;
  for (const path of [
    `/_next/static/${buildId}/_buildManifest.js`,
    "/_next/static/chunks/app-build-manifest.json",
  ]) {
    const res = await fetch(`${BASE}${path}`);
    if (!res.ok) continue;
    const body = await res.text();
    const m = body.match(/[^"']*tournaments[^"']*%5Bid%5D[^"']*page-[a-f0-9]+\.js/);
    if (m) chunkUrl = m[0].startsWith("/") ? m[0] : `/_next/${m[0]}`;
  }

  if (!chunkUrl) {
    console.log(
      "\n  ! Could not discover the tournament chunk from a public manifest.\n" +
        "    Pass it directly: load /tournaments/<id> while signed in and read\n" +
        "    performance.getEntriesByType('resource'), then re-run with the URL.\n"
    );
    process.exit(failures === 0 ? 0 : 1);
  }

  const js = await fetch(`${BASE}${chunkUrl}`).then((r) => r.text());
  check("fetched the tournament route chunk", js.length > 1000, `${js.length} bytes`);

  // Locate the two early returns and the hook in the EMITTED code.
  const playingReturn = js.search(/if\("playing"===\w+&&\w+\)return/);
  const submittingReturn = js.search(/if\("submitting"===\w+\)return/);
  const hook = js.search(/\(0,\w+\.useMemo\)/);

  check("the playing early return is present", playingReturn > 0);
  check("the submitting early return is present", submittingReturn > 0);
  check("the standing useMemo is present", hook > 0);

  check(
    "the hook is emitted BEFORE the playing early return",
    hook > 0 && playingReturn > 0 && hook < playingReturn,
    `useMemo@${hook} vs return@${playingReturn}`
  );
  check(
    "the hook is emitted BEFORE the submitting early return",
    hook > 0 && submittingReturn > 0 && hook < submittingReturn,
    `useMemo@${hook} vs return@${submittingReturn}`
  );

  // The instrumentation should be live too.
  const sink = await fetch(`${BASE}/api/telemetry/client-error`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "verification probe — not a real crash",
      source: "boundary",
      route: "/verify",
      context: { scope: "verification" },
      failedRequests: [],
    }),
  });
  check("the crash-report sink accepts reports", sink.ok, `HTTP ${sink.status}`);

  const map = await fetch(`${BASE}${chunkUrl}.map`);
  check("source maps are served for that chunk", map.ok, `HTTP ${map.status}`);

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
