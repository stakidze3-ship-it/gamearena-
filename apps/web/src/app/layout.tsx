import type { Metadata, Viewport } from "next";
import { Inter, Noto_Sans_Georgian, Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
import { TelemetryInit } from "@/components/telemetry-init";

const inter = Inter({
  subsets: ["latin", "latin-ext"],
  variable: "--font-inter",
  display: "swap",
});

const notoGeorgian = Noto_Sans_Georgian({
  subsets: ["georgian"],
  variable: "--font-noto-georgian",
  display: "swap",
});

/* Display face — headlines and Arena Numerals (scores, stakes, countdowns). */
const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  display: "swap",
});

/* Data literals — seeds, hashes, replay HUD. */
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "GameArena — skill wins, provably fair",
    template: "%s · GameArena",
  },
  description:
    "1v1 casual games for real stakes. Identical seeds, server-verified scores, provably fair by construction.",
};

export const viewport: Viewport = {
  themeColor: "#0A0B0F",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${notoGeorgian.variable} ${archivo.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-dvh font-sans text-base">
        <TelemetryInit />
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
