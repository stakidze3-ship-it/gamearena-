/**
 * Production seed — reference data only.
 *
 * Migrations create the schema; they do not create rows. Without this, a fresh
 * deployment has no games (so the Play screen renders nothing to play) and no
 * tournament (the scheduler's ensureOpenEvent returns early when there is no
 * enabled block-blast game), which is exactly the state a first deploy lands in.
 *
 * Everything here is an upsert, so it is safe to run on every deploy: existing
 * rows are left alone and only missing ones are created. It deliberately
 * creates NO users, NO matches and NO announcements — unlike the development
 * seed, which fabricates a demo world and must never touch production.
 */
import { DEFAULT_BLITZ_CURVE, lariToTetri } from "@gamearena/shared";
import { AWAITING_PLAYERS_AT, KNOCKOUT_CONFIG, KNOCKOUT_ROUNDS } from "@gamearena/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "./client";

const GAMES = [
  {
    key: "block-blast",
    name: "Block Blast",
    tagline: "Place pieces, clear lines, score in 60 seconds",
    durationS: 60,
    enabled: true,
  },
  {
    key: "bricks-breaker",
    name: "Bricks Breaker",
    tagline: "Aim, launch, break — 90 seconds on the clock",
    durationS: 90,
    enabled: false, // no engine yet — shown as "coming soon"
  },
];

const VAULT_TIERS = [
  { key: "bronze-20", name: "Bronze Vault", priceLari: 20 },
  { key: "silver-50", name: "Silver Vault", priceLari: 50 },
  { key: "gold-100", name: "Gold Vault", priceLari: 100 },
  { key: "platinum-250", name: "Platinum Vault", priceLari: 250 },
  { key: "diamond-500", name: "Diamond Vault", priceLari: 500 },
  { key: "royal-1000", name: "Royal Vault", priceLari: 1000 },
];

/** Prize table with EV = 95% of price (a 5% house edge). */
function prizeTable(price: number) {
  return [
    { prizeTetri: 0, weightBps: 3000, label: "0×" },
    { prizeTetri: Math.round(price * 0.5), weightBps: 3000, label: "0.5×" },
    { prizeTetri: price, weightBps: 2500, label: "1×" },
    { prizeTetri: price * 2, weightBps: 1000, label: "2×" },
    { prizeTetri: price * 4, weightBps: 350, label: "4×" },
    { prizeTetri: price * 10, weightBps: 130, label: "10×" },
    { prizeTetri: price * 40, weightBps: 20, label: "40×" },
  ];
}

const FLAGS: [string, boolean][] = [
  ["PAYMENTS_ENABLED", false],
  ["DEMO_MODE", true],
  ["BOTS_ENABLED", true],
  ["TOURNAMENTS_ENABLED", true],
];

export async function seedProduction(): Promise<void> {
  // ── Games ──
  for (const g of GAMES) {
    await prisma.game.upsert({
      where: { key: g.key },
      // Keep name/tagline/duration current, but never re-enable a game an
      // operator has deliberately switched off.
      update: { name: g.name, tagline: g.tagline, durationS: g.durationS },
      create: g,
    });
  }

  // ── Blitz payout curves (v1, active) ──
  for (const g of GAMES) {
    const game = await prisma.game.findUniqueOrThrow({ where: { key: g.key } });
    await prisma.blitzConfig.upsert({
      where: { gameId_version: { gameId: game.id, version: 1 } },
      update: {},
      create: {
        gameId: game.id,
        version: 1,
        breakEvenScore: 800,
        zeroScore: 400,
        curve: DEFAULT_BLITZ_CURVE as unknown as Prisma.InputJsonValue,
        maxMultBps: 25_000,
        active: true,
      },
    });
  }

  // ── Vault tiers ──
  for (const t of VAULT_TIERS) {
    const price = lariToTetri(t.priceLari);
    await prisma.vaultTier.upsert({
      where: { key: t.key },
      update: {},
      create: {
        key: t.key,
        name: t.name,
        priceTetri: price,
        prizeTable: prizeTable(price) as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // ── Feature flags ──
  for (const [key, enabled] of FLAGS) {
    await prisma.featureFlag.upsert({ where: { key }, update: {}, create: { key, enabled } });
  }

  // ── The open knockout event ──
  // Normally the realtime scheduler opens this. Seeding it means the
  // Tournaments page is populated on a Vercel-only deployment too; the
  // scheduler's ensureOpenEvent is a no-op while a SCHEDULED event exists, so
  // the two never fight.
  const blockBlast = await prisma.game.findFirst({
    where: { key: "block-blast", enabled: true },
  });
  if (blockBlast) {
    // isTest: false matters. A bot-filled event is flagged as a test and hidden
    // from players — but it is still SCHEDULED, so without this filter it
    // counted as "an event is already open" and suppressed the real one on
    // every deploy. Production ended up with three tournaments and an empty
    // Tournaments page, and no redeploy could heal it.
    const open = await prisma.tournament.findFirst({
      where: { format: "KNOCKOUT", isTest: false, status: { in: ["SCHEDULED", "RUNNING"] } },
      select: { id: true },
    });
    if (!open) {
      await prisma.tournament.create({
        data: {
          name: KNOCKOUT_CONFIG.name,
          gameId: blockBlast.id,
          entryTetri: KNOCKOUT_CONFIG.entryTetri,
          guaranteeTetri: KNOCKOUT_CONFIG.guaranteeTetri,
          prizeStructure: KNOCKOUT_CONFIG.prizeStructure as unknown as Prisma.InputJsonValue,
          capacity: KNOCKOUT_CONFIG.capacity,
          // Fill-triggered: the field filling is what starts it, not the clock.
          startsAt: AWAITING_PLAYERS_AT,
          durationS: KNOCKOUT_CONFIG.roundDurationS * KNOCKOUT_ROUNDS,
          format: "KNOCKOUT",
          roundDurationS: KNOCKOUT_CONFIG.roundDurationS,
          readyWindowS: KNOCKOUT_CONFIG.readyWindowS,
          status: "SCHEDULED",
          isRecurring: true,
        },
      });
    }
  }
}

// Allow `tsx packages/db/src/seed-production.ts` as a deploy step.
const isDirectRun = process.argv[1]?.includes("seed-production");
if (isDirectRun) {
  seedProduction()
    .then(async () => {
      const [games, tournaments, tiers] = await Promise.all([
        prisma.game.count(),
        prisma.tournament.count(),
        prisma.vaultTier.count(),
      ]);
      console.log(
        `[seed] reference data ready — ${games} games, ${tournaments} tournaments, ${tiers} vault tiers`
      );
      await prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error("[seed] production seed failed", err);
      await prisma.$disconnect();
      process.exit(1);
    });
}
