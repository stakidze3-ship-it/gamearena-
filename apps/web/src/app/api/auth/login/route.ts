import { NextRequest, NextResponse } from "next/server";
import { prisma, verifyPassword } from "@gamearena/db";
import { loginSchema } from "@/lib/validation";
import { createSessionToken, setSessionCookie } from "@/lib/session";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { identifier, password } = parsed.data;

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
  return NextResponse.json({ ok: true, username: user.username });
}
