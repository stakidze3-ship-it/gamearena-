import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createRealtimeTicket } from "@/lib/session";

/**
 * Issues a short-lived WS auth ticket + the realtime URL. The session cookie
 * is httpOnly and scoped to the web origin, so it can't ride the WebSocket
 * handshake to the realtime service on another port — the client passes this
 * ticket as ?token= instead, and the service verifies it with JWT_SECRET.
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const token = await createRealtimeTicket({ sub: user.id, un: user.username, rl: user.role });
  return NextResponse.json({
    token,
    wsUrl: process.env.NEXT_PUBLIC_REALTIME_URL ?? "ws://localhost:4001",
  });
}
