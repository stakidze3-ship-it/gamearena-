import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import {
  grantReferralBonus,
  grantSignupCredit,
  grantSignupVaultCredit,
  hashPassword,
  prisma,
} from "@gamearena/db";
import { registerSchema } from "@/lib/validation";
import { createSessionToken, setSessionCookie } from "@/lib/session";

function newReferralCode(): string {
  // 8 chars, unambiguous alphabet
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 400 }
    );
  }
  const { email, username, password, referralCode } = parsed.data;

  // Resolve an optional referral code to the referring user.
  const referrer = referralCode
    ? await prisma.user.findUnique({ where: { referralCode: referralCode.toUpperCase() } })
    : null;

  const conflict = await prisma.user.findFirst({
    where: {
      OR: [
        { email: email.toLowerCase() },
        { usernameLower: username.toLowerCase() },
      ],
    },
    select: { email: true },
  });
  if (conflict) {
    const which = conflict.email === email.toLowerCase() ? "Email" : "Username";
    return NextResponse.json({ error: `${which} is already taken` }, { status: 409 });
  }

  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      username,
      usernameLower: username.toLowerCase(),
      passwordHash: await hashPassword(password),
      referralCode: newReferralCode(),
      referredById: referrer?.id ?? null,
    },
  });

  // ₾100 demo credit + ₾50 vault credits — minted through the ledger, idempotent.
  await grantSignupCredit(user.id);
  await grantSignupVaultCredit(user.id);

  // Reward both sides of a valid referral with vault credits.
  if (referrer && referrer.id !== user.id) {
    await grantReferralBonus(referrer.id, user.id);
  }

  const token = await createSessionToken({ sub: user.id, un: user.username, rl: user.role });
  await setSessionCookie(token);
  return NextResponse.json({ ok: true, username: user.username });
}
