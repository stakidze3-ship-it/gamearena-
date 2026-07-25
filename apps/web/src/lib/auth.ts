import { cache } from "react";
import { redirect } from "next/navigation";
import { prisma } from "@gamearena/db";
import { getSession } from "./session";

/** Full user record for the current session, memoized per request. */
export const getCurrentUser = cache(async () => {
  const session = await getSession();
  if (!session) return null;
  const user = await prisma.user.findUnique({ where: { id: session.sub } });
  if (!user || user.suspendedAt) return null;
  return user;
});

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "ADMIN") redirect("/lobby");
  return user;
}
