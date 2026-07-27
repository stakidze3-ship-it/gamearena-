import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";

/**
 * Admin-only: find an account by username or email.
 *
 * The entry point to every other user tool — an operator has a name from a
 * support message, not a cuid. Substring rather than exact match, because the
 * name in the message is usually typed from memory and half right.
 *
 * Two deliberate limits:
 *
 *   · The result count is capped. A one-character query matches most of the
 *     table, and an admin console that tries to render the whole user base is
 *     an admin console that times out during the incident it was opened for.
 *     When the cap is hit the response says so, so a missing account reads as
 *     "narrow your search" rather than "this player does not exist".
 *   · An empty query is refused rather than treated as "everyone". Listing the
 *     entire user base by accident is not a useful default.
 *
 * Bots are included on purpose: an operator chasing a stuck bracket needs to be
 * able to look one up. They are flagged so they cannot be mistaken for players.
 */
export const dynamic = "force-dynamic";

/** Enough to find the right person among near-identical names; short of a data dump. */
const MAX_RESULTS = 25;

const querySchema = z.object({
  q: z.string().trim().min(1, "Enter a username or email to search for.").max(120),
});

export async function GET(req: NextRequest) {
  await requireAdmin();

  const parsed = querySchema.safeParse({ q: req.nextUrl.searchParams.get("q") ?? "" });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid search" },
      { status: 400 }
    );
  }
  const needle = parsed.data.q.toLowerCase();

  const users = await prisma.user.findMany({
    where: {
      OR: [
        // usernameLower is maintained by the register route, so a plain
        // contains on it is already case-insensitive and can use the index.
        { usernameLower: { contains: needle } },
        // Emails are stored lowercased too, but seeded and imported rows are
        // not guaranteed to be, and an operator pasting an address from a
        // support ticket should not have to care.
        { email: { contains: needle, mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      username: true,
      email: true,
      role: true,
      isBot: true,
      suspendedAt: true,
      lastSeenAt: true,
      createdAt: true,
    },
    // Most recently active first: the account an operator is looking for is
    // almost always one that has just done something.
    orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
    take: MAX_RESULTS + 1, // one extra, purely to detect that there are more
  });

  const capped = users.length > MAX_RESULTS;
  const page = capped ? users.slice(0, MAX_RESULTS) : users;

  // Balances in one query rather than one per row. The cash account is created
  // lazily on a user's first ledger posting, so an account with no row has
  // genuinely never held money — zero, not missing.
  const balances = page.length
    ? await prisma.account.findMany({
        where: { type: "USER_CASH", userId: { in: page.map((u) => u.id) } },
        select: { userId: true, balanceTetri: true },
      })
    : [];
  const balanceByUserId = new Map(balances.map((a) => [a.userId, a.balanceTetri]));

  return NextResponse.json({
    ok: true,
    users: page.map((user) => ({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      // One field, one meaning: whether this account can sign in. See the note
      // on /api/admin/users/[id]/ban — freeze and ban are the same state.
      status: user.suspendedAt ? "BANNED" : "ACTIVE",
      isBot: user.isBot,
      balanceTetri: balanceByUserId.get(user.id) ?? 0,
      lastSeenAt: user.lastSeenAt,
      createdAt: user.createdAt,
    })),
    capped,
    message: capped
      ? `Showing the first ${MAX_RESULTS} matches — narrow the search to see the rest.`
      : `${page.length} ${page.length === 1 ? "account" : "accounts"} matched.`,
  });
}
