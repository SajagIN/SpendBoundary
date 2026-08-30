import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["@prisma/client"],
  // Pin the trace root: a lockfile in a parent directory otherwise makes
  // Next.js guess the workspace root and warn on every dev start.
  outputFileTracingRoot: path.join(__dirname),
  allowedDevOrigins: [
    "*.trycloudflare.com",
    "localhost:3000",
    "127.0.0.1:3000",
  ],
};

export default nextConfig;
