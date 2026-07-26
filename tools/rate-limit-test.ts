/**
 * Rate limiting on the auth endpoints.
 *
 * Four things must hold together, and the last two are what make a limiter
 * safe to ship rather than a new way to lock out customers:
 *   1. a brute-force run against one account is stopped
 *   2. a fresh account/IP is unaffected while that is happening
 *   3. a successful sign-in clears the failures before it
 *   4. registration cannot be used as an unlimited ₾5 faucet
 *
 *   npx tsx --env-file=.env tools/rate-limit-test.ts
 */
import { prisma } from "@gamearena/db";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** Distinct forwarded IPs so each scenario gets its own bucket. */
function post(path: string, body: unknown, ip: string) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

(async () => {
  console.log("\nAUTH RATE LIMITING\n");
  // Start from a clean slate so repeat runs are meaningful.
  await prisma.rateLimit.deleteMany({});

  // ── 1. Brute force one account ──
  {
    const ip = "203.0.113.10";
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await post("/api/auth/login", { identifier: "nino@demo.ge", password: `wrong${i}` }, ip);
      codes.push(res.status);
    }
    const blocked = codes.filter((c) => c === 429).length;
    const firstBlockAt = codes.indexOf(429) + 1;
    console.log(`  attempts: ${codes.join(",")}`);
    check("a brute-force run gets cut off", blocked > 0, `${blocked} of 14 refused, first at attempt ${firstBlockAt}`);
    check("but not on the very first attempt", firstBlockAt > 1, `first 429 at ${firstBlockAt}`);

    const res = await post("/api/auth/login", { identifier: "nino@demo.ge", password: "wrong" }, ip);
    check("the 429 carries Retry-After", !!res.headers.get("retry-after"), res.headers.get("retry-after") ?? "missing");
  }

  // ── 2. A different person is unaffected ──
  {
    const res = await post(
      "/api/auth/login",
      { identifier: "mariam@demo.ge", password: "demo1234" },
      "198.51.100.77"
    );
    check("an unrelated user can still sign in", res.status === 200, `HTTP ${res.status}`);
  }

  // ── 3. Success clears prior failures ──
  {
    const ip = "203.0.113.20";
    for (let i = 0; i < 5; i++) {
      await post("/api/auth/login", { identifier: "beka@demo.ge", password: "nope" }, ip);
    }
    const good = await post("/api/auth/login", { identifier: "beka@demo.ge", password: "demo1234" }, ip);
    check("a correct password still works after some typos", good.status === 200, `HTTP ${good.status}`);

    // …and those failures are forgotten, so the next honest slip is not fatal.
    const after: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await post("/api/auth/login", { identifier: "beka@demo.ge", password: "nope" }, ip);
      after.push(r.status);
    }
    check(
      "the counter reset on success",
      after.every((c) => c === 401),
      `${after.join(",")} (all 401 means the window restarted)`
    );
  }

  // ── 4. Registration faucet ──
  {
    const ip = "203.0.113.30";
    const codes: number[] = [];
    for (let i = 0; i < 9; i++) {
      const tag = `rl${Date.now().toString(36)}${i}`;
      const res = await post(
        "/api/auth/register",
        { email: `${tag}@example.com`, username: tag, password: "testpass123" },
        ip
      );
      codes.push(res.status);
    }
    const created = codes.filter((c) => c === 200).length;
    const refused = codes.filter((c) => c === 429).length;
    console.log(`  registrations: ${codes.join(",")}`);
    check("signup is capped per IP", refused > 0, `${created} created, ${refused} refused`);
    check("but a few are allowed through", created >= 3, `${created} created`);
  }

  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
