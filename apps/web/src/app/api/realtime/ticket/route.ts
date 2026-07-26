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

  // The localhost default is a development convenience. Serving it in
  // production would point every player's browser at their own machine, and the
  // resulting failure looks identical to the service being down — so fail
  // loudly instead, where an operator can see it.
  const configured = process.env.NEXT_PUBLIC_REALTIME_URL;
  const wsUrl =
    configured ?? (process.env.NODE_ENV === "production" ? null : "ws://localhost:4001");
  if (!wsUrl) {
    console.error(
      "[realtime] NEXT_PUBLIC_REALTIME_URL is not set — realtime play cannot work in production"
    );
    return NextResponse.json(
      { error: "Realtime play is temporarily unavailable" },
      { status: 503 }
    );
  }

  const token = await createRealtimeTicket({ sub: user.id, un: user.username, rl: user.role });
  return NextResponse.json({ token, wsUrl });
}
