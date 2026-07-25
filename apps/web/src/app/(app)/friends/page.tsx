import type { Metadata } from "next";
import { prisma } from "@gamearena/db";
import { formatTetriCompact } from "@gamearena/shared";
import { PageHeader } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { List, ListRow } from "@/components/ui/list-row";
import { requireUser } from "@/lib/auth";
import {
  AddFriendButton,
  ChallengeControl,
  FriendSearch,
  PlayChallenge,
  RespondChallenge,
  RespondFriend,
} from "./friends-actions";

export const metadata: Metadata = { title: "Friends" };

export default async function FriendsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const me = await requireUser();

  const [outgoing, incoming, challengesIn, challengesOut, myMatches] = await Promise.all([
    prisma.friendship.findMany({
      where: { userId: me.id },
      include: { friend: { select: { id: true, username: true } } },
    }),
    prisma.friendship.findMany({
      where: { friendId: me.id },
      include: { user: { select: { id: true, username: true } } },
    }),
    prisma.challenge.findMany({
      where: { toUserId: me.id, status: "PENDING", expiresAt: { gt: new Date() } },
      include: { from: { select: { username: true } }, },
    }),
    prisma.challenge.findMany({
      where: { fromUserId: me.id, status: { in: ["PENDING", "ACCEPTED"] }, expiresAt: { gt: new Date() } },
      include: { to: { select: { username: true } } },
    }),
    prisma.match.findMany({
      where: { status: "SETTLED", players: { some: { userId: me.id } } },
      select: { winnerUserId: true, isDraw: true, players: { select: { userId: true } } },
    }),
  ]);

  // Accepted friends (both directions) + pending requests.
  const acceptedFriends = [
    ...outgoing.filter((f) => f.status === "ACCEPTED").map((f) => f.friend),
    ...incoming.filter((f) => f.status === "ACCEPTED").map((f) => f.user),
  ];
  const pendingIncoming = incoming.filter((f) => f.status === "PENDING");
  const pendingOutgoing = outgoing.filter((f) => f.status === "PENDING");

  // Head-to-head tally per opponent from my settled matches.
  const h2h = new Map<string, { w: number; l: number; d: number }>();
  for (const m of myMatches) {
    const opp = m.players.find((p) => p.userId !== me.id);
    if (!opp) continue;
    const rec = h2h.get(opp.userId) ?? { w: 0, l: 0, d: 0 };
    if (m.isDraw) rec.d++;
    else if (m.winnerUserId === me.id) rec.w++;
    else rec.l++;
    h2h.set(opp.userId, rec);
  }

  const gameKeyMap = new Map<string, string>();
  const games = await prisma.game.findMany({ select: { id: true, key: true } });
  for (const g of games) gameKeyMap.set(g.id, g.key);

  // Search results (exclude self, bots, existing relations).
  const relatedIds = new Set([
    me.id,
    ...acceptedFriends.map((f) => f.id),
    ...pendingIncoming.map((f) => f.user.id),
    ...pendingOutgoing.map((f) => f.friend.id),
  ]);
  const searchResults = q
    ? (
        await prisma.user.findMany({
          where: { usernameLower: { contains: q.toLowerCase() }, isBot: false },
          select: { id: true, username: true },
          take: 8,
        })
      ).filter((u) => !relatedIds.has(u.id))
    : [];

  return (
    <div className="mx-auto w-full max-w-xl space-y-10">
      <PageHeader title="Friends" subtitle="Add players, challenge them to a duel." />

      {/* ── Add a friend — the action ── */}
      <section>
        <FriendSearch initialQuery={q ?? ""} />
        {q && searchResults.length === 0 && (
          <p className="mt-4 text-sm text-muted">No new players match “{q}”.</p>
        )}
        {searchResults.length > 0 && (
          <Card className="mt-4">
            <List>
              {searchResults.map((u) => (
                <ListRow key={u.id}>
                  <span className="truncate text-sm font-medium">{u.username}</span>
                  <AddFriendButton username={u.username} />
                </ListRow>
              ))}
            </List>
          </Card>
        )}
      </section>

      {/* ── Pending requests ── */}
      {(pendingIncoming.length > 0 || challengesIn.length > 0) && (
        <section>
          <h2 className="mb-3 text-base font-semibold tracking-tight">Requests</h2>
          <Card>
            <List>
              {pendingIncoming.map((f) => (
                <ListRow key={f.id}>
                  <span className="min-w-0 truncate text-sm">
                    <span className="font-medium">{f.user.username}</span>{" "}
                    <span className="text-muted">wants to be friends</span>
                  </span>
                  <RespondFriend friendshipId={f.id} />
                </ListRow>
              ))}
              {challengesIn.map((c) => (
                <ListRow key={c.id}>
                  <span className="min-w-0 truncate text-sm">
                    <span className="font-medium">{c.from.username}</span>{" "}
                    <span className="text-muted">challenged you ·</span>{" "}
                    <span className="tnum">{formatTetriCompact(c.stakeTetri)}</span>
                  </span>
                  <RespondChallenge
                    challengeId={c.id}
                    gameKey={gameKeyMap.get(c.gameId) ?? "block-blast"}
                    stakeTetri={c.stakeTetri}
                  />
                </ListRow>
              ))}
            </List>
          </Card>
        </section>
      )}

      {/* ── Sent ── */}
      {(pendingOutgoing.length > 0 || challengesOut.length > 0) && (
        <section>
          <h2 className="mb-3 text-base font-semibold tracking-tight">Sent</h2>
          <div className="space-y-2 text-sm text-muted">
            {pendingOutgoing.map((f) => (
              <p key={f.id}>Friend request to {f.friend.username} — pending</p>
            ))}
            {challengesOut.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3">
                <span>
                  Challenge to {c.to.username} ·{" "}
                  <span className="tnum">{formatTetriCompact(c.stakeTetri)}</span> —{" "}
                  {c.status === "ACCEPTED" ? <span className="text-gold">accepted</span> : "pending"}
                </span>
                {c.status === "ACCEPTED" && (
                  <PlayChallenge
                    challengeId={c.id}
                    gameKey={gameKeyMap.get(c.gameId) ?? "block-blast"}
                    stakeTetri={c.stakeTetri}
                  />
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Friends + head-to-head ── */}
      <section>
        <h2 className="mb-3 text-base font-semibold tracking-tight">
          Your friends {acceptedFriends.length > 0 && `(${acceptedFriends.length})`}
        </h2>
        <Card>
          <List>
            {acceptedFriends.length === 0 && (
              <p className="px-5 py-8 text-center text-sm text-muted">
                No friends yet — search above and send a request.
              </p>
            )}
            {acceptedFriends.map((f) => {
              const rec = h2h.get(f.id);
              return (
                <ListRow key={f.id} size="comfortable" className="flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{f.username}</p>
                    <p className="tnum mt-0.5 text-xs text-muted">
                      {rec
                        ? `${rec.w}W · ${rec.l}L${rec.d > 0 ? ` · ${rec.d}D` : ""}`
                        : "No matches yet"}
                    </p>
                  </div>
                  <ChallengeControl toUsername={f.username} />
                </ListRow>
              );
            })}
          </List>
        </Card>
      </section>
    </div>
  );
}
