import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@gamearena/db";
import { requireAdmin } from "@/lib/auth";

/**
 * Admin-only: everything the console needs about one account, in one read.
 *
 * One request rather than five, because every one of these panels is opened at
 * the same moment — an operator picks a name out of the search results and
 * wants the whole picture. Splitting it would trade a single round trip for
 * five and a half-rendered screen.
 *
 * What "the whole picture" means here is decided by the questions support
 * actually gets asked:
 *
 *   · "Where did my money go?" → the wallet history, read from the ledger
 *     entries against this player's own cash account. The signed amount is the
 *     movement on THEIR account, not the transaction total, so a match payout
 *     reads as what they received rather than what the escrow moved.
 *   · "I played my round and it says I forfeited" → recent bracket matches,
 *     with whether each side actually took their run.
 *   · "Why can't I log in?" → the access state, and the responsible-gaming and
 *     payout flags that are easy to forget are set.
 *
 * Read-only. Everything that changes an account is a POST on a child route, so
 * a refresh or a prefetch can never move money.
 */
export const dynamic = "force-dynamic";

/** Deep enough to see a pattern, short enough to stay one screen. */
const RECENT_TRANSACTIONS = 20;
const RECENT_MATCHES = 10;
const RECENT_TOURNAMENTS = 10;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      username: true,
      email: true,
      role: true,
      isBot: true,
      kycStatus: true,
      suspendedAt: true,
      payoutHold: true,
      selfExcludedUntil: true,
      lastSeenAt: true,
      createdAt: true,
    },
  });
  if (!user) {
    return NextResponse.json({ error: "No account with that id" }, { status: 404 });
  }

  // Both money accounts in one query. Cash and vault are separate economies —
  // vault credits are not spendable stake — so they are reported separately
  // rather than summed into a single misleading "balance".
  const accounts = await prisma.account.findMany({
    where: { userId: id, type: { in: ["USER_CASH", "USER_VAULT"] } },
    select: { id: true, type: true, balanceTetri: true },
  });
  const cash = accounts.find((a) => a.type === "USER_CASH");
  const vault = accounts.find((a) => a.type === "USER_VAULT");

  // Filtered by accountId rather than by a relation, so this uses the
  // [accountId, createdAt] index instead of scanning the entry table.
  const entries = cash
    ? await prisma.ledgerEntry.findMany({
        where: { accountId: cash.id },
        select: {
          id: true,
          amountTetri: true,
          createdAt: true,
          tx: { select: { id: true, kind: true, memo: true, refType: true, refId: true } },
        },
        orderBy: { createdAt: "desc" },
        take: RECENT_TRANSACTIONS,
      })
    : [];

  const [tournamentEntries, duels, bracketMatches] = await Promise.all([
    prisma.tournamentEntry.findMany({
      where: { userId: id },
      select: {
        tournamentId: true,
        rank: true,
        prizeTetri: true,
        bestScore: true,
        joinedAt: true,
        tournament: { select: { name: true, status: true, entryTetri: true, startsAt: true } },
      },
      orderBy: { joinedAt: "desc" },
      take: RECENT_TOURNAMENTS,
    }),
    prisma.matchPlayer.findMany({
      where: { userId: id },
      select: {
        serverScore: true,
        flagged: true,
        match: {
          select: {
            id: true,
            status: true,
            stakeTetri: true,
            potTetri: true,
            winnerUserId: true,
            isDraw: true,
            createdAt: true,
            endedAt: true,
            game: { select: { key: true, name: true } },
            players: { select: { userId: true, user: { select: { username: true } } } },
          },
        },
      },
      orderBy: { match: { createdAt: "desc" } },
      take: RECENT_MATCHES,
    }),
    prisma.bracketMatch.findMany({
      where: { OR: [{ aUserId: id }, { bUserId: id }] },
      select: {
        id: true,
        tournamentId: true,
        round: true,
        status: true,
        aUserId: true,
        bUserId: true,
        aScore: true,
        bScore: true,
        aPlayed: true,
        bPlayed: true,
        winnerUserId: true,
        openedAt: true,
        finishedAt: true,
        tournament: { select: { name: true } },
      },
      // Rounds that never opened have no clock and belong at the bottom.
      orderBy: [{ openedAt: { sort: "desc", nulls: "last" } }],
      take: RECENT_MATCHES,
    }),
  ]);

  return NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      // The single access state. Freeze and ban write the same column — see the
      // note on /api/admin/users/[id]/ban.
      status: user.suspendedAt ? "BANNED" : "ACTIVE",
      isBot: user.isBot,
      balanceTetri: cash?.balanceTetri ?? 0,
      vaultTetri: vault?.balanceTetri ?? 0,
      lastSeenAt: user.lastSeenAt,
      createdAt: user.createdAt,

      // Flags that block things without blocking sign-in, and are therefore the
      // ones an operator forgets to check when a player says "it won't let me".
      kycStatus: user.kycStatus,
      payoutHold: user.payoutHold,
      selfExcludedUntil: user.selfExcludedUntil,
      suspendedAt: user.suspendedAt,
      frozen: user.suspendedAt !== null,

      transactions: entries.map((entry) => ({
        // The ENTRY id, not the transaction id: one transaction can post two
        // entries to the same account, and a duplicated key would drop a row
        // from the rendered list.
        id: entry.id,
        txId: entry.tx.id,
        kind: entry.tx.kind,
        amountTetri: entry.amountTetri,
        memo: entry.tx.memo,
        refType: entry.tx.refType,
        refId: entry.tx.refId,
        at: entry.createdAt,
      })),

      tournaments: tournamentEntries.map((entry) => ({
        id: entry.tournamentId,
        name: entry.tournament.name,
        status: entry.tournament.status,
        rank: entry.rank,
        prizeTetri: entry.prizeTetri,
        bestScore: entry.bestScore,
        entryTetri: entry.tournament.entryTetri,
        joinedAt: entry.joinedAt,
      })),

      matches: duels.map((row) => {
        const opponent = row.match.players.find((p) => p.userId !== id);
        return {
          id: row.match.id,
          game: row.match.game.name,
          gameKey: row.match.game.key,
          status: row.match.status,
          stakeTetri: row.match.stakeTetri,
          potTetri: row.match.potTetri,
          score: row.serverScore,
          opponent: opponent?.user.username ?? null,
          // null while the match is unsettled — "not decided yet" is a
          // different thing from "lost", and collapsing them lies.
          won: row.match.winnerUserId ? row.match.winnerUserId === id : null,
          isDraw: row.match.isDraw,
          flagged: row.flagged,
          at: row.match.endedAt ?? row.match.createdAt,
        };
      }),

      bracketMatches: bracketMatches.map((match) => {
        const isA = match.aUserId === id;
        return {
          id: match.id,
          tournamentId: match.tournamentId,
          tournamentName: match.tournament.name,
          round: match.round,
          status: match.status,
          score: isA ? match.aScore : match.bScore,
          opponentScore: isA ? match.bScore : match.aScore,
          // The answer to "I definitely played" — this is the flag the
          // forfeit path reads, so it is the one worth showing.
          played: isA ? match.aPlayed : match.bPlayed,
          opponentPlayed: isA ? match.bPlayed : match.aPlayed,
          won: match.winnerUserId ? match.winnerUserId === id : null,
          openedAt: match.openedAt,
          finishedAt: match.finishedAt,
        };
      }),
    },
    message: `Loaded ${user.username}.`,
  });
}
