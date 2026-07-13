import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { createBullProducerConnection } from "../catalog-import/catalog-redis.js";
import {
  RECO_DEBOUNCE_MS,
  RECO_GENERATION_JOB_NAME,
  RECO_GENERATION_JOB_OPTIONS,
  RECO_GENERATION_QUEUE,
  REDIS_URL_ENV,
  recoGenerationJobId,
} from "./recommendations.constants.js";

/** Data carried by a per-user recommendation-generation job. */
export interface RecoGenerationJobData {
  /** Local `User.id` whose recommendations to (re)generate. */
  userId: string;
}

/**
 * BullMQ producer for the `reco-generation` queue (PR11, design Decision #7).
 * The API process only ever PRODUCES generation jobs — from the onboarding
 * completion trigger and the debounced tracking trigger; the `reco-generation`
 * Worker (which also owns the nightly repeatable refresh) runs in the standalone
 * `reco-worker.ts` process, so nothing here consumes.
 *
 * Same lazy-infra posture as {@link import("../search/search-queue.js").SearchQueue}:
 * the queue and its Redis connection are created on first enqueue, so
 * constructing this provider is side-effect-free and the full-AppModule e2e suite
 * never opens a socket. Reuses the catalog module's bounded-retry producer
 * connection factory (the enqueue is reachable synchronously from the onboarding
 * and tracking HTTP request paths, so it must fail fast rather than hang if Redis
 * is down).
 *
 * Fase 1 MVP scope note: no distributed lock and no bespoke job-revival — a
 * generation job that exhausts its retries is removed and re-added fresh (see
 * {@link enqueue}) the next time the onboarding-completion trigger, the
 * tracking trigger, the nightly refresh, or the synchronous cold-read fallback
 * in {@link import("./recommendations.service.js").RecommendationsService}
 * enqueues that user again — so regeneration always actually happens instead
 * of silently no-op'ing against a stale failed job. Sufficient for a
 * single-operator MVP (PR5/PR6 lesson).
 */
@Injectable()
export class RecoQueue implements OnModuleDestroy {
  private readonly logger = new Logger(RecoQueue.name);
  private connection: Redis | undefined;
  private queue: Queue<RecoGenerationJobData> | undefined;

  constructor(private readonly config: ConfigService) {}

  /**
   * Enqueues an IMMEDIATE generation for a user (the onboarding-completion
   * trigger — the cold-start user must get recommendations promptly after
   * finishing onboarding). The deterministic `reco-gen:{userId}` job id coalesces
   * with any pending debounced job for the same user.
   */
  async enqueueGeneration(userId: string): Promise<void> {
    await this.enqueue(userId);
  }

  /**
   * Enqueues a DEBOUNCED generation for a user (the tracking trigger). The job is
   * delayed by {@link RECO_DEBOUNCE_MS}; because it carries the deterministic
   * per-user job id, a burst of tracking writes within the window coalesces into
   * a single delayed job (BullMQ no-ops an `add` whose id is already
   * waiting/delayed) — the queue-level dedup IS the debounce, so no counter or
   * timer state is kept here.
   */
  async enqueueDebouncedGeneration(userId: string): Promise<void> {
    await this.enqueue(userId, RECO_DEBOUNCE_MS);
  }

  /**
   * Shared enqueue path for both entry points above — they only differ in
   * whether the job is delayed. The deterministic `reco-gen:{userId}` job id
   * dedupes re-enqueues, but BullMQ's `Queue.add()` silently no-ops if a job
   * with this id already exists in Redis in ANY state — including `failed`.
   * Once a user's generation job exhausts its retries and lands in the failed
   * set, every subsequent enqueue for that user would otherwise no-op forever
   * (judgment-day fix, mirroring {@link
   * import("../search/search-queue.js").SearchQueue.enqueueAlbumSync}): a
   * pre-existing FAILED *or* COMPLETED job with this id is removed first,
   * letting `add()` create a genuinely fresh job instead of no-op'ing. Jobs
   * still in flight (`active`/`waiting`/`delayed`) are left alone.
   *
   * The existing job can transition to `active` (picked up by the
   * `reco-generation` worker) between the state check and `remove()`, which
   * makes BullMQ throw "locked by another worker". That race is harmless — a
   * job that just started running will produce a fresh result on its own — so
   * it's logged and swallowed instead of failing the caller. Any other
   * `remove()` error (e.g. a genuine Redis/infra failure) is rethrown so it
   * still reaches the caller instead of being silently swallowed.
   */
  private async enqueue(userId: string, delay?: number): Promise<void> {
    const jobId = recoGenerationJobId(userId);
    const queue = this.getQueue();
    const existing = await queue.getJob(jobId);
    if (existing && ((await existing.isFailed()) || (await existing.isCompleted()))) {
      try {
        await existing.remove();
      } catch (error) {
        if (error instanceof Error && error.message.includes("locked by another worker")) {
          this.logger.warn(
            `Skipping re-enqueue for ${jobId}: existing job was picked up by a worker concurrently. ${error.message}`,
          );
          return;
        }
        throw error;
      }
    }
    await queue.add(
      RECO_GENERATION_JOB_NAME,
      { userId },
      {
        ...RECO_GENERATION_JOB_OPTIONS,
        jobId,
        ...(delay !== undefined ? { delay } : {}),
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    if (this.connection) {
      await this.connection.quit();
    }
  }

  private getConnection(): Redis {
    if (!this.connection) {
      this.connection = createBullProducerConnection(
        this.config.get<string>(REDIS_URL_ENV),
      );
    }
    return this.connection;
  }

  private getQueue(): Queue<RecoGenerationJobData> {
    const queue =
      this.queue ??
      (this.queue = new Queue<RecoGenerationJobData>(RECO_GENERATION_QUEUE, {
        connection: this.getConnection(),
      }));
    return queue;
  }
}
