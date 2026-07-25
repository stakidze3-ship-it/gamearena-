import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { finalizeTournament } from "@/lib/tournaments";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdmin();
  await finalizeTournament(id);
  return NextResponse.json({ ok: true });
}
