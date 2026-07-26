import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "ga_session";
const SESSION_DAYS = 30;

export interface SessionPayload {
  sub: string; // userId
  un: string; // username
  rl: "USER" | "ADMIN";
}

function secretKey(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ un: payload.un, rl: payload.rl })
    .setSubject(payload.sub)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secretKey());
}

/** Short-lived ticket the browser CAN read (returned in JSON) to auth the
 *  WebSocket — the httpOnly session cookie never reaches the realtime origin. */
export async function createRealtimeTicket(payload: SessionPayload): Promise<string> {
  return new SignJWT({ un: payload.un, rl: payload.rl, kind: "rt" })
    .setSubject(payload.sub)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secretKey());
}

/**
 * Verify a SESSION token.
 *
 * Rejects realtime tickets outright. Both are signed with the same secret, but
 * a ticket is deliberately readable by JavaScript — it is returned in JSON so
 * the browser can put it on a WebSocket URL, and it is then sent to a separate
 * service on another host. The session cookie is httpOnly precisely so that a
 * cross-site script cannot steal it; accepting a ticket here handed out an
 * exfiltratable credential worth exactly as much, admin role included. A token
 * is only ever valid for the purpose it was minted for.
 */
export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (!payload.sub) return null;
    if (payload.kind === "rt") return null; // a WebSocket ticket is not a session
    return {
      sub: payload.sub,
      un: (payload.un as string) ?? "",
      rl: (payload.rl as "USER" | "ADMIN") ?? "USER",
    };
  } catch {
    return null;
  }
}

export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}
