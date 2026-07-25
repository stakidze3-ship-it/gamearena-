import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import path from "node:path";

// Single source of truth for env: the monorepo root .env
loadEnv({ path: path.resolve(__dirname, "../../.env") });

const nextConfig: NextConfig = {
  transpilePackages: ["@gamearena/db", "@gamearena/games", "@gamearena/shared"],
  devIndicators: false,
};

export default nextConfig;
