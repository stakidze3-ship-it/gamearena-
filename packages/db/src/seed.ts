/**
 * Seed: games + blitz configs, feature flags, vault tiers, admin, bot,
 * 20 demo users, and two weeks of realistic match/blitz history — every
 * tetri of it posted through the real ledger engine (so ledger:check
 * passes on a fresh seed).
 *
 * Deterministic: uses a fixed PRNG seed so reseeding reproduces the same world.
 * Logins: all demo users have password "demo1234"; admin is "admin1234".
 */
import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_BLITZ_CURVE, blitzPayoutTetri, lariToTetri, rakeBpsForStake, STAKES_TETRI } from "@gamearena/shared";
import { prisma } from "./client";
import { AccountKeys, postTransactionIn } from "./ledger";
import { grantSignupCredit, grantSignupVaultCredit, lockStakeIn, settleMatchIn } from "./money-ops";
import { hashPassword } from "./password";

// ── Deterministic PRNG (mulberry32) ────────────────────────────────────────
let prngState = 0x6a75_7374;
function rand(): number {
  prngState |= 0;
  prngState = (prngState + 0x6d2b79f5) | 0;
  let t = Math.imul(prngState ^ (prngState >>> 15), 1 | prngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const newSeed = () => String(randInt(100_000, 999_999));

const DEMO_USERS = [
  { username: "giorgi_t", email: "giorgi@demo.ge" },
  { username: "nino_k", email: "nino@demo.ge" },
  { username: "luka_b", email: "luka@demo.ge" },
  { username: "mariam_g", email: "mariam@demo.ge" },
  { username: "dato_m", email: "dato@demo.ge" },
  { username: "ana_ch", email: "ana@demo.ge" },
  { username: "levan_x", email: "levan@demo.ge" },
  { username: "salome_j", email: "salome@demo.ge" },
  { username: "irakli_77", email: "irakli@demo.ge" },
  { username: "tamar_i", email: "tamar@demo.ge" },
  { username: "nika_v", email: "nika@demo.ge" },
  { username: "elene_r", email: "elene@demo.ge" },
  { username: "sandro_k", email: "sandro@demo.ge" },
  { username: "natia_ts", email: "natia@demo.ge" },
  { username: "beka_a", email: "beka@demo.ge" },
  { username: "keti_m", email: "keti@demo.ge" },
  { username: "zura_g", email: "zura@demo.ge" },
  { username: "ლიკა", email: "lika@demo.ge" }, // Georgian-script usernames must work
  { username: "გეგა", email: "gega@demo.ge" },
  { username: "თornike", email: "tornike@demo.ge" },
] as const;

async function main() {
  console.log("Seeding GameArena…");

  // ── Games ──
  const blockBlast = await prisma.game.upsert({
    where: { key: "block-blast" },
    update: {},
    create: {
      key: "block-blast",
      name: "Block Blast",
      tagline: "Place pieces, clear lines, score in 60 seconds",
      durationS: 60,
    },
  });
  const bricks = await prisma.game.upsert({
    where: { key: "bricks-breaker" },
    update: {},
    create: {
      key: "bricks-breaker",
      name: "Bricks Breaker",
      tagline: "Aim, launch, break — 90 seconds on the clock",
      durationS: 90,
      enabled: false, // ships in Phase 2+
    },
  });

  // ── Blitz configs (v1, active) ──
  for (const g of [blockBlast, bricks]) {
    await prisma.blitzConfig.upsert({
      where: { gameId_version: { gameId: g.id, version: 1 } },
      update: {},
      create: {
        gameId: g.id,
        version: 1,
        breakEvenScore: 800,
        zeroScore: 400,
        curve: DEFAULT_BLITZ_CURVE as unknown as object[],
        maxMultBps: 25_000,
        active: true,
      },
    });
  }

  // ── Feature flags ──
  const flags: [string, boolean][] = [
    ["PAYMENTS_ENABLED", false],
    ["DEMO_MODE", true],
    ["BOTS_ENABLED", true],
    ["TOURNAMENTS_ENABLED", true],
  ];
  for (const [key, enabled] of flags) {
    await prisma.featureFlag.upsert({ where: { key }, update: {}, create: { key, enabled } });
  }

  // ── Vault tiers ──
  const vaultTiers = [
    { key: "bronze-20", name: "Bronze Vault", priceLari: 20 },
    { key: "silver-50", name: "Silver Vault", priceLari: 50 },
    { key: "gold-100", name: "Gold Vault", priceLari: 100 },
    { key: "platinum-250", name: "Platinum Vault", priceLari: 250 },
    { key: "diamond-500", name: "Diamond Vault", priceLari: 500 },
    { key: "royal-1000", name: "Royal Vault", priceLari: 1000 },
  ];
  for (const t of vaultTiers) {
    const price = lariToTetri(t.priceLari);
    await prisma.vaultTier.upsert({
      where: { key: t.key },
      update: {},
      create: {
        key: t.key,
        name: t.name,
        priceTetri: price,
        // Transparent prize table, EV = 95% of price (5% house edge).
        prizeTable: [
          { prizeTetri: 0, weightBps: 3000, label: "0×" },
          { prizeTetri: Math.round(price * 0.5), weightBps: 3000, label: "0.5×" },
          { prizeTetri: price, weightBps: 2500, label: "1×" },
          { prizeTetri: price * 2, weightBps: 1000, label: "2×" },
          { prizeTetri: price * 4, weightBps: 350, label: "4×" },
          { prizeTetri: price * 10, weightBps: 130, label: "10×" },
          { prizeTetri: price * 40, weightBps: 20, label: "40×" },
        ],
      },
    });
  }

  // ── Users ──
  const demoHash = await hashPassword("demo1234");
  const adminHash = await hashPassword("admin1234");

  const admin = await prisma.user.upsert({
    where: { email: "admin@gamearena.ge" },
    update: {},
    create: {
      email: "admin@gamearena.ge",
      username: "arena_admin",
      usernameLower: "arena_admin",
      passwordHash: adminHash,
      role: "ADMIN",
      kycStatus: "VERIFIED",
      referralCode: "ADMIN000",
    },
  });

  const bot = await prisma.user.upsert({
    where: { email: "bot@gamearena.ge" },
    update: {},
    create: {
      email: "bot@gamearena.ge",
      username: "ARENA_BOT",
      usernameLower: "arena_bot",
      passwordHash: await hashPassword(randomUUID()), // unloginable
      isBot: true,
      referralCode: "BOT00000",
    },
  });

  const users: { id: string; username: string }[] = [];
  for (const [i, u] of DEMO_USERS.entries()) {
    const created = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email,
        username: u.username,
        usernameLower: u.username.toLowerCase(),
        passwordHash: demoHash,
        referralCode: `DEMO${String(i + 1).padStart(4, "0")}`,
        createdAt: new Date(Date.now() - randInt(3, 21) * 86_400_000),
      },
    });
    users.push({ id: created.id, username: created.username });
  }

  // ── Signup credits (₾5 cash + ₾50 vault, minted, dated to signup) ──
  for (const u of [...users, { id: admin.id }, { id: bot.id }]) {
    const record = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    await grantSignupCredit(u.id, record.createdAt);
    await grantSignupVaultCredit(u.id, record.createdAt);
  }
  console.log(`✓ ${users.length} demo users + admin + bot, each credited ₾5`);

  // ── Two weeks of settled 1v1 matches (full escrow → settle ledger flow) ──
  const existingMatches = await prisma.match.count();
  if (existingMatches === 0) {
    let settled = 0;
    for (let i = 0; i < 36; i++) {
      const a = pick(users);
      let b = pick(users);
      while (b.id === a.id) b = pick(users);
      const stake = pick(STAKES_TETRI);
      // Keep seed-world stakes affordable so nobody busts below zero
      if (stake > 1000 && rand() < 0.6) continue;
      const rakeBps = rakeBpsForStake(stake);
      const seed = newSeed();
      const when = new Date(Date.now() - randInt(0, 14) * 86_400_000 - randInt(0, 86_400_000));

      const scoreA = randInt(150, 950);
      const scoreB = randInt(150, 950);
      if (scoreA === scoreB) continue; // skip draws in seed data
      const winner = scoreA > scoreB ? a : b;

      try {
        await prisma.$transaction(async (db) => {
          const match = await db.match.create({
            data: {
              gameId: blockBlast.id,
              stakeTetri: stake,
              rakeBps,
              potTetri: stake * 2,
              seed,
              seedHash: sha256(seed),
              status: "SETTLED",
              isDemo: true,
              winnerUserId: winner.id,
              createdAt: when,
              startedAt: when,
              endedAt: new Date(when.getTime() + 60_000),
              settledAt: new Date(when.getTime() + 61_000),
              players: {
                create: [
                  { userId: a.id, serverScore: scoreA, inputCount: randInt(40, 90) },
                  { userId: b.id, serverScore: scoreB, inputCount: randInt(40, 90) },
                ],
              },
            },
          });
          await lockStakeIn(db, match.id, a.id, stake, when);
          await lockStakeIn(db, match.id, b.id, stake, when);
          await settleMatchIn(db, match.id, winner.id, stake * 2, rakeBps, new Date(when.getTime() + 61_000));
        });
        settled++;
      } catch {
        // a player ran out of demo credits at this stake — skip, keep world consistent
      }
    }
    console.log(`✓ ${settled} settled matches with full escrow/rake ledger flow`);

    // ── Blitz history ──
    const config = await prisma.blitzConfig.findFirstOrThrow({
      where: { gameId: blockBlast.id, active: true },
    });
    const curve = config.curve as unknown as { score: number; multBps: number }[];
    let blitzCount = 0;
    for (let i = 0; i < 40; i++) {
      const u = pick(users);
      const entry = pick([100, 200, 500] as const);
      const seed = newSeed();
      const score = Math.max(0, Math.round(randInt(200, 1500) * (0.7 + rand() * 0.6)));
      const { multBps, payoutTetri } = blitzPayoutTetri(entry, curve, score, config.maxMultBps);
      const when = new Date(Date.now() - randInt(0, 14) * 86_400_000 - randInt(0, 86_400_000));

      try {
        await prisma.$transaction(async (db) => {
          const run = await db.blitzRun.create({
            data: {
              userId: u.id,
              gameId: blockBlast.id,
              configId: config.id,
              entryTetri: entry,
              seed,
              seedHash: sha256(seed),
              status: "SETTLED",
              serverScore: score,
              multBps,
              payoutTetri,
              inputCount: randInt(30, 80),
              createdAt: when,
              settledAt: new Date(when.getTime() + 70_000),
            },
          });
          await postTransactionIn(db, {
            kind: "BLITZ_ENTRY",
            refType: "blitz",
            refId: run.id,
            idempotencyKey: `blitz-entry:${run.id}`,
            entries: [
              { accountKey: AccountKeys.userCash(u.id), amountTetri: -entry },
              { accountKey: AccountKeys.treasury(), amountTetri: entry },
            ],
            createdAt: when,
          });
          if (payoutTetri > 0) {
            await postTransactionIn(db, {
              kind: "BLITZ_PAYOUT",
              refType: "blitz",
              refId: run.id,
              idempotencyKey: `blitz-payout:${run.id}`,
              entries: [
                { accountKey: AccountKeys.treasury(), amountTetri: -payoutTetri },
                { accountKey: AccountKeys.userCash(u.id), amountTetri: payoutTetri },
              ],
              createdAt: new Date(when.getTime() + 70_000),
            });
          }
        });
        blitzCount++;
      } catch {
        // insufficient demo balance — skip
      }
    }
    console.log(`✓ ${blitzCount} settled Blitz runs`);
  } else {
    console.log("• Match history already present — skipping history generation");
  }

  // ── Ratings for players who appeared in matches ──
  const played = await prisma.matchPlayer.groupBy({ by: ["userId"], _count: true });
  for (const p of played) {
    const wins = await prisma.match.count({ where: { winnerUserId: p.userId } });
    await prisma.ratingState.upsert({
      where: { userId_gameId: { userId: p.userId, gameId: blockBlast.id } },
      update: { matchesPlayed: p._count, wins },
      create: {
        userId: p.userId,
        gameId: blockBlast.id,
        rating: 1500 + randInt(-140, 140),
        rd: 200,
        matchesPlayed: p._count,
        wins,
      },
    });
  }

  // ── Tournaments (tonight's championship + next hourly mini) ──
  const tonight = new Date();
  tonight.setHours(21, 0, 0, 0);
  if (tonight.getTime() < Date.now()) tonight.setDate(tonight.getDate() + 1);
  const nextHour = new Date();
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(nextHour.getHours() + 1);

  if ((await prisma.tournament.count()) === 0) {
    await prisma.tournament.createMany({
      data: [
        {
          name: "Daily Championship",
          gameId: blockBlast.id,
          entryTetri: lariToTetri(5),
          prizeStructure: [
            { rank: 1, shareBps: 5000 },
            { rank: 2, shareBps: 3000 },
            { rank: 3, shareBps: 2000 },
          ],
          guaranteeTetri: lariToTetri(100),
          startsAt: tonight,
          durationS: 900,
          capacity: 64,
          isRecurring: true,
        },
        {
          name: "Hourly Mini",
          gameId: blockBlast.id,
          entryTetri: lariToTetri(1),
          prizeStructure: [
            { rank: 1, shareBps: 6000 },
            { rank: 2, shareBps: 4000 },
          ],
          startsAt: nextHour,
          durationS: 600,
          capacity: 16,
          isRecurring: true,
        },
      ],
    });
  }

  // ── Welcome announcement (Georgian + English — font rendering check) ──
  if ((await prisma.announcement.count()) === 0) {
    await prisma.announcement.create({
      data: {
        title: "Welcome to GameArena · კეთილი იყოს თქვენი მობრძანება",
        body: "Demo season is live — every new player gets ₾5 in demo credits. Skill decides everything: identical seeds, server-checked scores.",
      },
    });
  }

  console.log("✓ Seed complete");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
