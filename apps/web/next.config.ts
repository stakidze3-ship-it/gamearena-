import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import path from "node:path";

// Single source of truth for env: the monorepo root .env
loadEnv({ path: path.resolve(__dirname, "../../.env") });

const nextConfig: NextConfig = {
  transpilePackages: ["@gamearena/db", "@gamearena/games", "@gamearena/shared"],
  devIndicators: false,
  /**
   * Ship source maps for the client bundle.
   *
   * Without this a production stack trace reads `page-92d2191.js:1:24601` and
   * identifies nothing — which is exactly why a render crash on this platform
   * took several rounds to place. The cost is that the original sources become
   * publicly fetchable; this is a client bundle, so it already ships every line
   * of that code in minified form, and no secret lives in it. Server code and
   * environment variables are unaffected.
   */
  productionBrowserSourceMaps: true,
  env: {
    /**
     * Stamped into every crash report, so a report can be tied to the exact
     * deployment that produced it rather than to whatever main looks like now.
     */
    NEXT_PUBLIC_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
  },
};

export default nextConfig;
