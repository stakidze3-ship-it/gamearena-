import { headers } from "next/headers";

/**
 * Absolute origin for links that leave the app — invite links pasted into
 * WhatsApp, OpenGraph URLs. Prefers the configured public URL and falls back to
 * the forwarded host so it is correct behind a proxy and in local dev.
 */
export async function siteOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/$/, "");

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** The public, shareable link for a tournament. */
export async function tournamentInviteUrl(tournamentId: string): Promise<string> {
  return `${await siteOrigin()}/t/${tournamentId}`;
}
