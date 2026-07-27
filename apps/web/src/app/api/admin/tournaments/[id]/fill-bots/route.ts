import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fillTournamentWithBots, prisma } from "@gamearena/db";
import { KNOCKOUT_CONFIG, formatTetri } from "@gamearena/shared";
import { requireAdmin } from "@/lib/auth";
import { adminOpsErrorResponse, readJsonBody } from "@/lib/admin-ops-http";

/**
 * Admin-only: seat every empty chair with a bot so a whole knockout can be run
 * end to end on demand.
 *
 * Reachability, not just visibility: requireAdmin() runs before anything else,
 * and it redirects rather than returning — a non-admin cannot reach the bot
 * fill by guessing the URL, and the UI that offers it lives under /admin, which
 * is gated by its own layout. Hiding a button is not a permission model.
 *
 * The bots join through joinTournament exactly as humans do, so capacity, the
 * escrow and the fill trigger stay consistent. Filling the last seat starts the
 * ordinary countdown; the bracket is drawn by the same poll-driven path that
 * serves real events. Nothing here shortcuts the tournament lifecycle.
 *
 * Filling a LIVE event is possible, and is not casual. Bots pay a real entry
 * fee into a real escrow, compete against paying humans and can win real
 * prizes, so an unacknowledged attempt is refused with a machine-readable
 * LIVE_OVERRIDE_REQUIRED and the figures the console needs to describe those
 * consequences exactly — the event's name, its entry fee, and how many seats
 * are about to be taken. A confirmation dialog forced to guess at those numbers
 * is a dialog that eventually lies to the person clicking it.
 */
export const dynamic = "force-dynamic";

const schema = z.object({
  /**
   * Required to seat bots in a player-visible event. The console sends it only
   * once the operator has confirmed what it means.
   */
  acknowledgeLive: z.boolean().optional(),
  /** Seat at most this many, rather than filling every empty chair. */
  limit: z.number().int().min(1).max(1024).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;

  const parsed = schema.safeParse(await readJsonBody(req));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid bot fill" },
      { status: 400 }
    );
  }
  const { acknowledgeLive, limit } = parsed.data;

  const t = await prisma.tournament.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      status: true,
      format: true,
      capacity: true,
      entryTetri: true,
      guaranteeTetri: true,
      isTest: true,
      _count: { select: { entries: true } },
    },
  });
  if (!t) return NextResponse.json({ error: "Tournament not found" }, { status: 404 });
  if (t.format !== "KNOCKOUT") {
    return NextResponse.json({ error: "Bot fill is for knockout brackets" }, { status: 400 });
  }
  if (t.status !== "SCHEDULED") {
    return NextResponse.json(
      { error: `Cannot fill a tournament that is ${t.status}` },
      { status: 409 }
    );
  }

  const seatsLeft = Math.max(0, t.capacity - t._count.entries);
  const seatsToFill = Math.min(seatsLeft, limit ?? seatsLeft);

  // The override is demanded here as well as inside the operation, because this
  // is the layer that can answer "how many seats, at what price, in which
  // event". The operations layer can only throw a sentence; the console needs
  // figures. A full field is deliberately exempt — there is nothing to seat, so
  // making an operator confirm a no-op only trains them to click through the
  // dialog that does matter.
  if (!t.isTest && !acknowledgeLive && seatsToFill > 0) {
    return NextResponse.json(
      {
        error:
          "This is a live, player-visible tournament. Seating bots here puts them in a real bracket competing for a real prize pool — confirm the override to proceed.",
        code: "LIVE_OVERRIDE_REQUIRED",
        tournament: {
          id: t.id,
          name: t.name,
          entryTetri: t.entryTetri,
          capacity: t.capacity,
          entryCount: t._count.entries,
          seatsToFill,
          // What a full field pays out, which is what the event advertises.
          poolTetri: Math.max(t.entryTetri * t.capacity, t.guaranteeTetri),
        },
      },
      { status: 409 }
    );
  }

  try {
    const result = await fillTournamentWithBots(id, {
      countdownS: KNOCKOUT_CONFIG.countdownS,
      acknowledgeLive,
      limit,
    });

    const mintedTetri = result.seated * t.entryTetri;
    const message = result.alreadyFull
      ? `${t.name} is already full — no bots seated.`
      : `Seated ${result.seated} bot(s) in ${t.name} · ${result.entryCount}/${result.capacity} seats` +
        (mintedTetri > 0 ? ` · ${formatTetri(mintedTetri)} of entry fees minted from treasury` : "") +
        (result.mode === "live-override" ? " · LIVE event, stamped as bot-filled" : "");

    return NextResponse.json({ ok: true, ...result, message });
  } catch (err) {
    // The operations layer runs the same live-override check, so a tournament
    // that stopped being a test between the read above and this call still
    // reaches the console as a refusal it knows how to handle, not a 500.
    return adminOpsErrorResponse(err, {
      code:
        err instanceof Error && /live, player-visible tournament/i.test(err.message)
          ? "LIVE_OVERRIDE_REQUIRED"
          : undefined,
      fallback: "Bot fill failed",
    });
  }
}
