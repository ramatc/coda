import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client/index.js";
import { resolveSingleton, type ClientContainer } from "./singleton.js";

const globalForPrisma = globalThis as unknown as ClientContainer<PrismaClient>;

/**
 * Shared PrismaClient instance for the whole monorepo. Global-cached in
 * non-production so hot reloads reuse one connection pool.
 *
 * Prisma 7 requires a driver adapter instead of a schema `url`; the Postgres
 * adapter reads the connection string from `DATABASE_URL`.
 */
export const prisma: PrismaClient = resolveSingleton(globalForPrisma, () => {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });

  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
  });
});
