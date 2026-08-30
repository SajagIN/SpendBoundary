import { PrismaClient } from "@prisma/client";

/**
 * Incident E02 — the IDE language server can cache a stale Prisma Client AST
 * after the schema grows. Exporting an explicit client type keeps consumers
 * compiling even before `npx prisma generate` has been re-run.
 */
export type CustomPrismaClient = PrismaClient;

const globalForPrisma = globalThis as unknown as { prisma?: CustomPrismaClient };

export const prisma: CustomPrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === "true" ? ["query", "warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
