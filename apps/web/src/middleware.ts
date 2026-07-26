import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

/**
 * Paths that require a session.
 *
 * A path missing from this list still gets protected by its page's
 * requireUser(), so nothing leaks — but that redirect is a bare /login with no
 * `next`, so the user lands on the lobby after signing in instead of the page
 * they asked for. That matters most for exactly the links people share:
 * a replay, or the testing console.
 */
const PROTECTED = [
  "/lobby",
  "/blitz",
  "/tournaments",
  "/rankings",
  "/wallet",
  "/vault",
  "/friends",
  "/profile",
  "/admin",
  "/match",
  "/replay",
  "/testing",
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const needsAuth = PROTECTED.some((p) => pathname.startsWith(p));
  if (!needsAuth) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (!session) {
    const url = new URL("/login", req.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  if (pathname.startsWith("/admin") && session.rl !== "ADMIN") {
    return NextResponse.redirect(new URL("/lobby", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
