import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@prisma/client"],
  // Pin the trace root: a lockfile in a parent directory otherwise makes
  // Next.js guess the workspace root and warn on every dev start.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
