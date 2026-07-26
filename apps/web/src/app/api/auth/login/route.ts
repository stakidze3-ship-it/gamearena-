import { NextRequest, NextResponse } from "next/server";
import { RATE_LIMITS, consumeRateLimit, prisma, resetRateLimit, verifyPassword } from "@gamearena/db";
import { clientIp } from "@/lib/client-ip";
import { loginSchema } from "@/lib/validation";
import { createSessionToken, setSessionCookie } from "@/lib/session";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { identifier, password } = parsed.data;

  // Throttle before touching the database.
  //
  // Per (account) and per (IP) separately: a household or office behind one
  // address must not lock each other out, while an attacker grinding a single
  // account is stopped early — and the looser per-IP ceiling catches spraying
  // across many accounts from one place.
  const ip = clientIp(req);
  const subject = identifier.toLowerCase();
  const [byAccount, byIp] = await Promise.all([
    consumeRateLimit(RATE_LIMITS.loginPerAccount, `${ip}|${subject}`),
    consumeRateLimit(RATE_LIMITS.loginPerIp, ip),
  ]);
  const limited = !byAccount.allowed ? byAccount : !byIp.allowed ? byIp : null;
  if (limited) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(limited.retryAfterSeconds) } }
    );
  }

  const user = await prisma.user.findFirst({
    where: {
      OR: [
        { email: identifier.toLowerCase() },
        { usernameLower: identifier.toLowerCase() },
      ],
    },
  });

  // Uniform error — never reveal which field failed.
  const fail = () =>
    NextResponse.json({ error: "Wrong email/username or password" }, { status: 401 });

  if (!user || user.isBot) return fail();
  if (!(await verifyPassword(password, user.passwordHash))) return fail();
  if (user.suspendedAt) {
    return NextResponse.json({ error: "Account suspended. Contact support." }, { status: 403 });
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });

  const token = await createSessionToken({ sub: user.id, un: user.username, rl: user.role });
  await setSessionCookie(token);
  // Only failures should accumulate: someone who mistypes twice and then gets
  // it right must not carry those attempts for the rest of the window.
  await resetRateLimit(RATE_LIMITS.loginPerAccount.bucket, `${ip}|${subject}`);
  return NextResponse.json({ ok: true, username: user.username });
}
