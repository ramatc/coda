import { Module } from "@nestjs/common";
import { prisma } from "@coda/db";
import { HealthController } from "./health.controller.js";

/**
 * Injection token for the shared Prisma client.
 *
 * `@coda/db` is wired here as a provider-ready dependency so downstream health
 * features (readiness/DB checks) can inject it later. The current liveness
 * endpoint does NOT query the database, keeping the check green without a live
 * connection. Constructing the client is lazy — no connection is opened until a
 * query runs.
 */
export const PRISMA = Symbol("PRISMA");

@Module({
  controllers: [HealthController],
  providers: [{ provide: PRISMA, useValue: prisma }],
  exports: [PRISMA],
})
export class HealthModule {}
