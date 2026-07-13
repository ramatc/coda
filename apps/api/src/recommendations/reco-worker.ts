import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { Worker, Queue } from "bullmq";
import { AppModule } from "../app.module.js";
import { RecoGenerationService } from "./reco-generation.service.js";
import { createBullConnection } from "../catalog-import/catalog-redis.js";
import {
  RECO_GENERATION_JOB_OPTIONS,
  RECO_GENERATION_QUEUE,
  RECO_NIGHTLY_CRON,
  RECO_NIGHTLY_JOB_NAME,
  REDIS_URL_ENV,
} from "./recommendations.constants.js";
import type { RecoGenerationJobData } from "./reco.queue.js";

/**
 * Standalone consumer process for recommendation generation (design Decision #7 +
 * #4's out-of-API-process worker topology). Run with
 * `pnpm --filter @coda/api worker:reco`.
 *
 * Responsibilities:
 *  - Consumes the `reco-generation` queue: each job carries a `userId`, and the
 *    worker runs the heuristic {@link RecoGenerationService.generateForUser} to
 *    (re)compute that user's `ACTIVE` recommendations. Jobs are produced by the
 *    onboarding-completion trigger and the debounced tracking trigger (see
 *    `RecoQueue`).
 *  - Registers a NIGHTLY repeatable job that regenerates recommendations for
 *    every onboarded user (a catalog refresh keeps popularity-weighted
 *    recommendations current even for users with no recent activity).
 *
 * Fase 1 MVP scope note: a job that exhausts its BullMQ retries is left in the
 * failed set for an operator to inspect/retry — no automatic revival, no
 * distributed lock (single-operator model; PR5/PR6 lesson). Generation is an
 * idempotent upsert, so a duplicated or retried run simply re-computes.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger("RecoWorker");
  const app = await NestFactory.createApplicationContext(AppModule);
  const config = app.get(ConfigService);
  const generation = app.get(RecoGenerationService);

  // The Worker needs its OWN blocking connection; the nightly scheduler uses a
  // separate producer connection (same rationale as the catalog workers — a
  // Worker's blocking reads must not stall the scheduler's commands).
  const workerConnection = createBullConnection(config.get<string>(REDIS_URL_ENV));
  const schedulerConnection = createBullConnection(
    config.get<string>(REDIS_URL_ENV),
  );

  const worker = new Worker<RecoGenerationJobData>(
    RECO_GENERATION_QUEUE,
    async (job) => {
      if (job.name === RECO_NIGHTLY_JOB_NAME) {
        await regenerateAllOnboarded(app, generation, logger);
        return;
      }
      const result = await generation.generateForUser(job.data.userId);
      logger.log(
        `Generated ${result.generated} recommendation(s) for user ` +
          `${job.data.userId} (pruned ${result.pruned}).`,
      );
    },
    { connection: workerConnection },
  );

  worker.on("failed", (job, err) => {
    logger.error(`Reco job ${job?.id} failed: ${err.message}`);
  });

  // Register the nightly repeatable refresh. Idempotent: BullMQ dedupes a
  // repeatable by its name + cron, so re-running the worker does not stack
  // duplicate schedules.
  const scheduler = new Queue<RecoGenerationJobData>(RECO_GENERATION_QUEUE, {
    connection: schedulerConnection,
  });
  await scheduler.add(
    RECO_NIGHTLY_JOB_NAME,
    { userId: "" },
    {
      ...RECO_GENERATION_JOB_OPTIONS,
      repeat: { pattern: RECO_NIGHTLY_CRON },
      jobId: RECO_NIGHTLY_JOB_NAME,
    },
  );

  logger.log(
    "Recommendation worker running (reco-generation + nightly refresh). Ctrl-C to stop.",
  );

  const shutdown = async (): Promise<void> => {
    logger.log("Shutting down recommendation worker...");
    await worker.close();
    await scheduler.close();
    await workerConnection.quit();
    await schedulerConnection.quit();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

/**
 * Nightly full refresh: regenerates recommendations for every onboarded user (one
 * with at least one genre preference). Bounded and sequential — Fase 1's user
 * count is small, so a simple loop is sufficient (no fan-out fleet needed; add
 * one only if the user base grows enough to matter).
 */
async function regenerateAllOnboarded(
  app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>>,
  generation: RecoGenerationService,
  logger: Logger,
): Promise<void> {
  // Resolve Prisma lazily here (only the nightly path needs it) to keep the
  // per-user job path dependency-free.
  const { PrismaService } = await import("../prisma/prisma.service.js");
  const prisma = app.get(PrismaService);
  const users = await prisma.client.userGenrePreference.findMany({
    distinct: ["userId"],
    select: { userId: true },
  });
  logger.log(`Nightly refresh: regenerating for ${users.length} onboarded user(s).`);
  for (const { userId } of users) {
    try {
      await generation.generateForUser(userId);
    } catch (err) {
      logger.error(
        `Nightly refresh failed for user ${userId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

void bootstrap();
