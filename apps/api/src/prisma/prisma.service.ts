import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { prisma } from "@coda/db";
import type { PrismaClient } from "@coda/db";

/**
 * Injectable wrapper around the shared `@coda/db` Prisma singleton.
 *
 * The client is WRAPPED, not extended (Decision #3): the whole monorepo keeps a
 * single connection pool and Fase 0's hot-reload singleton semantics are
 * preserved. Feature modules run queries through `prismaService.client`.
 *
 * No `$connect` on init — Prisma connects lazily on the first query, so the API
 * boots green without a reachable Postgres (matching the liveness-probe
 * philosophy). Only shutdown is managed here.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient = prisma;

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
