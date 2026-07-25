import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { LandingContent } from "@/components/landing-content";

export default async function LandingPage() {
  const session = await getSession();
  if (session) redirect("/lobby");
  return <LandingContent />;
}
