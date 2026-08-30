import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    // Integration tests run against a throwaway SQLite file so the dev
    // database (prisma/dev.db) is never touched by the suite.
    env: { DATABASE_URL: "file:./test.db" },
    hookTimeout: 120_000,
    testTimeout: 30_000,
    sequence: { concurrent: false },
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
