# GameArena

Skill-based real-money gaming platform. 1v1 casual games for real stakes — provably fair by
construction: identical deterministic seeds, server-side score computation, atomic escrow
settlement, and a double-entry ledger where every tetri is accounted for.

**Launch mode: demo credits only.** Every signup gets ₾5 in demo credits. The full
wallet/escrow/rake engine runs underneath; real payments sit behind `PAYMENTS_ENABLED=false`.

## Stack

- **Web** — Next.js 15 (App Router) · TypeScript · Tailwind v4 (`apps/web`)
- **Realtime** — Node WebSocket service for live matches (`apps/realtime`)
- **DB** — Postgres via Prisma (`packages/db`), Redis for matchmaking/presence (Phase 3+)
- **Shared** — money math (integer tetri), stake/rake/payout-curve logic (`packages/shared`)
- Auth: email/password + username, JWT (HS256) in an httpOnly cookie

## Getting started

```bash
# prerequisites: Postgres 17 + Redis running locally
#   brew services start postgresql@17 redis
#   createdb gamearena

cp .env.example .env          # fill in JWT_SECRET etc. (repo ships a dev .env already)
npm install
npm run db:generate           # prisma client
npm run db:migrate            # apply migrations
npm run db:seed               # 20 demo users, bot, admin, matches, blitz history
npm run dev                   # web + realtime concurrently
```

| Login | Password |
| --- | --- |
| `giorgi@demo.ge` … `gega@demo.ge` (20 demo users) | `demo1234` |
| `admin@gamearena.ge` | `admin1234` |

`npm run dev` runs the web app **and** the realtime WebSocket service (`:4001`) together — the
latter is required for 1v1 Quick Match. Health check: `curl localhost:4001/health`.

**Notable routes:** `/lobby` `/blitz/block-blast` `/match/block-blast` (1v1) `/tournaments`
`/vault` `/friends` `/rankings` · `/fairness` (public verifier) · `/admin` (metrics, review
queue, Blitz calibration, liveops, users, feature flags).

## Money invariants

All money is **integer tetri** (₾1 = 100 tetri). Every movement goes through
`postTransaction()` in `packages/db/src/ledger.ts`, which enforces:

1. every transaction balances to zero (double-entry),
2. user/escrow accounts never go negative (`SYS_TREASURY` is the mint and goes negative by design),
3. cached balances update atomically with their entries,
4. idempotency keys make settlements retry-safe.

Audit anytime:

```bash
npm run ledger:check
# ✓ Global zero-sum: all entries sum to ₾0.00
# ✓ Per-tx zero-sum · ✓ cache consistency · ✓ no negative balances
```

Match settlement (`settleMatchIn`) empties escrow to winner + rake in **one** ledger
transaction; `payout + rake === pot` exactly (rake rounds down, remainder to the winner).

Rake by stake: ₾1 → 15% · ₾5/₾10 → 12.5% · ₾25 → 10%.

## Phase status

- [x] **Phase 1** — monorepo, design system (near-black/gold, Inter + Noto Sans Georgian,
      tabular money), auth, full DB schema, wallet + double-entry ledger, responsible-gaming
      controls, seed world, `ledger:check`
- [x] **Phase 2** — deterministic Block Blast engine (`@gamearena/games`, shared client/server),
      playable board, practice mode, and the Blitz money cycle (server re-simulates inputs to
      compute the authoritative score, then settles through the ledger)
- [x] **Phase 3** — realtime 1v1 over WebSocket: escrow lock, seed commit/reveal, per-player
      server-side engines that validate streamed inputs, atomic escrow settlement (winner + rake,
      or refund on a draw), demo bot opponents, and the live match screen (opponent panel, live
      scores, chat)
- [x] **Phase 4** — Glicko-2 per-game rating applied on settlement, rating-aware matchmaking
      (±150 window + newcomer protection), the match replay viewer (re-simulates both input logs
      from the seed), anti-cheat signals (input-timing, win-rate anomaly, device fingerprint) that
      open review cases + hold payouts, and the admin review queue with clear/suspend actions
- [x] **Phase 5** — tournaments (register → escrow → shared-seed run → leaderboard → prize
      settlement with guarantee top-up), rankings (global Glicko-2 / weekly season / friends),
      friends + challenges (private WS rooms) + head-to-head, the vault (95%-EV provably-fair
      opens with a reveal animation, paid in vault credits), and referral rewards
- [x] **Phase 6** — admin (metrics dashboard, Blitz calibration with live score-distribution +
      versioned curves, liveops: create tournaments / announcements / rake-free happy hours,
      feature flags, users), public Fairness page with an in-browser seed→hash verifier, plus a
      polish + docs pass. **All six phases complete.**

## Layout

```
apps/
  web/        Next.js app (UI + API routes)
  realtime/   WebSocket match service (Phase 3)
packages/
  shared/     tetri money math, stakes/rake, blitz curves — no runtime deps
  games/      deterministic game engines (Game SDK, seeded RNG, Block Blast) —
              shared by client (render) and server (score validation), pure TS
  db/         Prisma schema, ledger engine, money ops, seed, ledger-check
```

## Provably fair, server-authoritative scoring

The client renders Block Blast with the engine in `@gamearena/games` and records only the
raw input log (`{t, slot, row, col}`) — never a score. On submit, the server replays that
log through the **same** engine (`simulate()`) to compute the authoritative score; the
client's number is display-only. A tampered client cannot inflate a score without valid
placements that actually achieve it. Every match seed is committed by SHA-256 hash before
play and revealed after.

Notes: demo-economy amounts fit comfortably in Postgres `Int`; move ledger amounts to
`BIGINT` before real-money launch. Bots are permitted only in demo mode and always labeled.
