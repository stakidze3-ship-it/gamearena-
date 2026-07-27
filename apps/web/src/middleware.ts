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
  // Deliberately NO role check here.
  //
  // This used to redirect anyone whose token did not say ADMIN away from
  // /admin, and it was wrong twice over. The role is baked into the JWT at
  // sign-in, so the check reads a snapshot that can be hours stale: an account
  // promoted to admin kept being bounced until it happened to log in again,
  // with nothing on screen explaining why. And because middleware runs before
  // any page code, the admin layout never got the chance to offer an eligible
  // owner the button that would have granted them the role — so the Admin tab
  // in the top bar navigated nowhere and looked broken.
  //
  // Authorisation for /admin belongs where the live role can actually be read:
  // the admin layout is a server component, it queries the database on every
  // request, and it decides between the console, the claim screen and a
  // redirect. Middleware's job here is only "is there a session at all".
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
