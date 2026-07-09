import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { Job } from "bullmq";
import { Worker } from "bullmq";
import { Prisma } from "@coda/db";
import { AppModule } from "../app.module.js";
import { CatalogImportService } from "./catalog-import.service.js";
import { CatalogQueue, type AlbumJobData, type PageJobData } from "./catalog-queue.js";
import { SpotifyClient } from "./spotify.client.js";
import { SpotifyCheckpointStore } from "./spotify-checkpoint.store.js";
import { createBullConnection } from "./catalog-redis.js";
import {
  extractUniqueConstraintField,
  isUniqueConstraintViolation,
} from "../prisma/prisma-error.util.js";
import {
  CATALOG_ALBUM_QUEUE,
  CATALOG_PAGE_QUEUE,
  REDIS_URL_ENV,
  SPOTIFY_PAGE_LIMIT,
} from "./catalog-import.constants.js";

/** Prisma error code for a foreign-key constraint violation. */
const FOREIGN_KEY_VIOLATION = "P2003";

/**
 * Standalone consumer process for the Spotify bulk seed (Decision #4: workers
 * run OUT of the HTTP API process). Run with `pnpm --filter @coda/api worker:catalog`.
 *
 * Topology (design "seed → page jobs → per-album"):
 *  - Page worker: fetches one Spotify page, fans out one deterministic
 *    `album:{spotifyId}` job per album (queue-level dedup), advances the Redis
 *    checkpoint, then enqueues the next page. Killing the process leaves the
 *    checkpoint at the last completed page, so a restart resumes there.
 *  - Album worker: performs the idempotent Artist+Album upsert. PR6 chains the
 *    MusicBrainz enrichment onto this same per-album unit.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger("CatalogWorker");
  const app = await NestFactory.createApplicationContext(AppModule);
  const config = app.get(ConfigService);
  const spotify = app.get(SpotifyClient);
  const service = app.get(CatalogImportService);
  const queue = app.get(CatalogQueue);
  const checkpoint = app.get(SpotifyCheckpointStore);
  // Each Worker gets its OWN connection (judgment-day issue #11): BullMQ's
  // Workers use blocking Redis commands, so sharing one connection between the
  // page and album Workers would let one Worker's blocking read stall the
  // other's commands on the same socket.
  const pageConnection = createBullConnection(config.get<string>(REDIS_URL_ENV));
  const albumConnection = createBullConnection(config.get<string>(REDIS_URL_ENV));

  const pageWorker = new Worker<PageJobData>(
    CATALOG_PAGE_QUEUE,
    async (job) => {
      // `??`, not `||` (judgment-day issue #11): `||` would silently treat an
      // explicit `limit: 0` as unset and fall back to the default instead.
      const limit = job.data.limit ?? SPOTIFY_PAGE_LIMIT;
      const page = await spotify.getAlbumPage(job.data.offset, limit);
      // Bulk fan-out (judgment-day issue #4) instead of one `add()` per album.
      await queue.enqueueAlbums(page.albums);
      if (page.nextOffset === null) {
        await checkpoint.clear();
        if (job.data.lockToken) {
          await checkpoint.releaseRunningLock(job.data.lockToken);
        }
      } else {
        // Enqueue the NEXT page BEFORE advancing the checkpoint (judgment-day
        // issue #8): a crash between the two used to leave the checkpoint
        // advanced with no job enqueued for that page, silently stalling the
        // import. Enqueuing first means a crash before the checkpoint update
        // just re-enqueues the next page — safe, since the page job id is
        // deterministic (natural dedup). The lock token rides along so
        // whichever page ends the run (here, or the `failed` handler below)
        // releases the SAME lock this run's `enqueueSeed()` acquired
        // (judgment-day issue #2).
        await queue.enqueuePage(page.nextOffset, limit, job.data.lockToken);
        await checkpoint.set(page.nextOffset);
      }
      return { processed: page.albums.length, nextOffset: page.nextOffset };
    },
    { connection: pageConnection },
  );

  const albumWorker = new Worker<AlbumJobData>(
    CATALOG_ALBUM_QUEUE,
    async (job) => {
      // Per-album error isolation (judgment-day issue #7): a single malformed
      // record (Prisma validation error), a P2002 unique-constraint conflict,
      // or a P2003 foreign-key violation is logged and skipped instead of
      // failing the whole job; any other error (e.g. a lost DB connection)
      // still propagates so BullMQ's retry/backoff applies to it.
      try {
        await service.upsertAlbum(job.data.album);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientValidationError) {
          logger.warn(
            `Skipping malformed album ${job.data.album.spotifyId}: ${err.message}`,
          );
          return;
        }
        if (isUniqueConstraintViolation(err)) {
          const field = extractUniqueConstraintField(err);
          logger.warn(
            `Skipping album ${job.data.album.spotifyId} due to a unique ` +
              `constraint conflict${field ? ` on "${field}"` : ""}: ${err.message}`,
          );
          return;
        }
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === FOREIGN_KEY_VIOLATION
        ) {
          logger.warn(
            `Skipping album ${job.data.album.spotifyId} due to a foreign key violation: ${err.message}`,
          );
          return;
        }
        throw err;
      }
    },
    { connection: albumConnection },
  );

  pageWorker.on("failed", (job, err) => {
    logger.error(`Page job ${job?.id} failed: ${err.message}`);
    // Permanent-failure lock release (judgment-day issue #5): if the page job
    // has exhausted all configured retry attempts (sustained outage, revoked
    // credentials), the running lock would otherwise stay held for the full
    // TTL, blocking recovery via the CLI or admin endpoint during that window.
    void releaseLockOnPermanentFailure(job);
  });
  albumWorker.on("failed", (job, err) => {
    logger.error(`Album job ${job?.id} failed: ${err.message}`);
  });

  async function releaseLockOnPermanentFailure(
    job: Job<PageJobData> | undefined,
  ): Promise<void> {
    if (!job || !job.data.lockToken) {
      return;
    }
    const attemptsMade = job.attemptsMade ?? 0;
    const maxAttempts = job.opts?.attempts ?? 1;
    if (attemptsMade < maxAttempts) {
      // Retries remain — a later attempt may still finish the run normally.
      return;
    }
    try {
      await checkpoint.releaseRunningLock(job.data.lockToken);
      logger.warn(
        `Page job ${job.id} exhausted all ${maxAttempts} attempts — released the running lock so a new run can start.`,
      );
    } catch (releaseErr) {
      logger.error(
        `Failed to release the running lock after page job ${job.id}'s permanent failure: ${
          releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
        }`,
      );
    }
  }

  logger.log("Catalog seed workers running (page + album). Ctrl-C to stop.");

  const shutdown = async (): Promise<void> => {
    logger.log("Shutting down catalog workers...");
    await pageWorker.close();
    await albumWorker.close();
    await pageConnection.quit();
    await albumConnection.quit();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void bootstrap();
