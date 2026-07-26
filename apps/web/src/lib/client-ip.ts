import type { NextRequest } from "next/server";

/**
 * The caller's IP, as far as it can be trusted.
 *
 * On Vercel the platform sets x-vercel-forwarded-for and overwrites it on every
 * request, so a client cannot forge it. x-forwarded-for is a fallback for other
 * hosts and for local development; its LAST entry is the one appended by the
 * nearest proxy, and taking the first would let a caller prepend whatever they
 * liked and rotate their own rate-limit bucket at will.
 */
export function clientIp(req: NextRequest): string {
  const vercel = req.headers.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",").pop()!.trim();

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",").pop()!.trim();

  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
