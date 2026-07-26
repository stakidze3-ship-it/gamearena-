/**
 * Fixed-window rate limiting, shared across instances.
 *
 * Credential stuffing and signup-bonus farming both come down to "how many
 * times per minute can one caller try". Without a limit the answer is
 * unbounded, and an in-process counter answers it wrongly on serverless: it
 * resets on cold start and counts separately per instance.
 *
 * The whole decision is ONE statement. A read-then-write version would let two
 * simultaneous attempts both see a stale window and both be allowed — exactly
 * the flaw that made ledger idempotency unsafe. `INSERT … ON CONFLICT DO
 * UPDATE` with the window comparison inline is decided by Postgres under the
 * row lock, so concurrent callers serialise and the count is always true.
 */

import { prisma } from "./client";

export interface RateLimitRule {
  /** Bucket name — appears in the key, so buckets never collide. */
  bucket: string;
  /** Attempts allowed inside one window. */
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Attempts used in the current window, including this one. */
  used: number;
  limit: number;
  /** Seconds until the window resets — for a Retry-After header. */
  retryAfterSeconds: number;
}

/**
 * Count this attempt and say whether it is allowed.
 *
 * Fails OPEN. If the limiter itself errors the request proceeds: a database
 * hiccup must not lock every player out of signing in. The limiter is a brake
 * on abuse, not an authorisation check — the real gates are elsewhere.
 */
export async function consumeRateLimit(
  rule: RateLimitRule,
  subject: string
): Promise<RateLimitResult> {
  const key = `${rule.bucket}:${subject}`;
  try {
    const rows = await prisma.$queryRaw<{ count: number; window_start: Date }[]>`
      INSERT INTO "RateLimit" ("key", "count", "windowStart")
      VALUES (${key}, 1, (now() AT TIME ZONE 'UTC'))
      ON CONFLICT ("key") DO UPDATE SET
        -- Inside the window: increment. Past it: start a fresh window at 1.
        "count" = CASE
          WHEN "RateLimit"."windowStart" > (now() AT TIME ZONE 'UTC') - make_interval(secs => ${rule.windowSeconds}::double precision)
          THEN "RateLimit"."count" + 1
          ELSE 1
        END,
        "windowStart" = CASE
          WHEN "RateLimit"."windowStart" > (now() AT TIME ZONE 'UTC') - make_interval(secs => ${rule.windowSeconds}::double precision)
          THEN "RateLimit"."windowStart"
          ELSE (now() AT TIME ZONE 'UTC')
        END
      RETURNING "count", "windowStart" AS window_start
    `;
    const row = rows[0];
    if (!row) return { allowed: true, used: 0, limit: rule.limit, retryAfterSeconds: 0 };

    const used = Number(row.count);
    const elapsed = (Date.now() - new Date(row.window_start).getTime()) / 1000;
    return {
      allowed: used <= rule.limit,
      used,
      limit: rule.limit,
      retryAfterSeconds: Math.max(1, Math.ceil(rule.windowSeconds - elapsed)),
    };
  } catch {
    return { allowed: true, used: 0, limit: rule.limit, retryAfterSeconds: 0 };
  }
}

/**
 * Forget a subject's attempts — called after a SUCCESSFUL sign-in.
 *
 * Without this, someone who mistypes their password a few times and then gets
 * it right still carries those failures for the rest of the window, and a
 * later genuine attempt can be refused. Only failures should accumulate.
 */
export async function resetRateLimit(bucket: string, subject: string): Promise<void> {
  await prisma.rateLimit.deleteMany({ where: { key: `${bucket}:${subject}` } }).catch(() => {});
}

/** Drop windows that can no longer matter. Cheap and indexed. */
export async function sweepRateLimits(maxAgeSeconds = 3600): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeSeconds * 1000);
  const { count } = await prisma.rateLimit
    .deleteMany({ where: { windowStart: { lt: cutoff } } })
    .catch(() => ({ count: 0 }));
  return count;
}

/**
 * The rules.
 *
 * Login is limited per (IP, account) rather than per IP alone: a household or
 * office behind one address must not lock each other out, while an attacker
 * grinding one account is stopped. A looser per-IP ceiling then catches
 * spraying across many accounts.
 */
export const RATE_LIMITS = {
  loginPerAccount: { bucket: "login:acct", limit: 8, windowSeconds: 15 * 60 },
  loginPerIp: { bucket: "login:ip", limit: 40, windowSeconds: 15 * 60 },
  registerPerIp: { bucket: "register:ip", limit: 6, windowSeconds: 60 * 60 },
} satisfies Record<string, RateLimitRule>;
