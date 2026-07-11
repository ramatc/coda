import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { Worker } from "bullmq";
import { Prisma } from "@coda/db";
import { AppModule } from "../app.module.js";
import { CatalogImportService } from "./catalog-import.service.js";
import {
  CatalogQueue,
  type AlbumJobData,
  type EnrichJobData,
  type PageJobData,
} from "./catalog-queue.js";
import { SpotifyClient } from "./spotify.client.js";
import { SpotifyCheckpointStore } from "./spotify-checkpoint.store.js";
import { MusicBrainzEnrichService } from "./musicbrainz-enrich.service.js";
import { createBullConnection } from "./catalog-redis.js";
import { SearchQueue, type SearchSyncJobData } from "../search/search-queue.js";
import { SearchSyncService } from "../search/search-sync.service.js";
import { MeiliService } from "../search/meili.service.js";
import { SEARCH_SYNC_QUEUE } from "../search/search.constants.js";
import {
  extractUniqueConstraintField,
  isForeignKeyViolation,
  isUniqueConstraintViolation,
} from "../prisma/prisma-error.util.js";
import {
  CATALOG_ALBUM_QUEUE,
  CATALOG_ENRICH_QUEUE,
  CATALOG_PAGE_QUEUE,
  MUSICBRAINZ_RATE_LIMIT,
  REDIS_URL_ENV,
  SPOTIFY_PAGE_LIMIT,
} from "./catalog-import.constants.js";

/**
 * Standalone consumer process for the Spotify bulk seed (Decision #4: workers
 * run OUT of the HTTP API process). Run with `pnpm --filter @coda/api worker:catalog`.
 *
 * Topology (design "seed → page jobs → per-album"):
 *  - Page worker: fetches one Spotify page, fans out one deterministic
 *    `album:{spotifyId}` job per album (queue-level dedup), advances the Redis
 *    checkpoint, then enqueues the next page. Killing the process leaves the
 *    checkpoint at the last completed page, so a restart resumes there.
 *  - Album worker: performs the idempotent Artist+Album upsert, then enqueues a
 *    MusicBrainz enrichment job for that album (PR6) — the enrichment is chained
 *    onto this same per-album unit, and only fires for albums that persisted.
 *  - Enrich worker: fetches the album's MusicBrainz mbid + genres and upserts
 *    them. Carries the {@link MUSICBRAINZ_RATE_LIMIT} BullMQ limiter so the whole
 *    fleet honours MusicBrainz's ≤1 req/s policy regardless of worker count.
 *  - Search-sync worker (PR7): projects an upserted album (+ its artist) into
 *    Meilisearch. Chained off the album upsert (NOT gated behind the slow,
 *    rate-limited enrichment leg), so a freshly-imported album is searchable by
 *    title/artist promptly; a re-sync after enrichment then adds its genres.
 *    Co-located here per the design (search-sync is a catalog-import worker).
 *
 * Fase 1 MVP scope note: a job that exhausts BullMQ's own configured retries
 * (`CATALOG_JOB_OPTIONS`) is left in the failed set for an operator to inspect
 * and retry manually (e.g. via Bull Board or `queue.getJob(id).retry()`) —
 * there is no automatic revival.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger("CatalogWorker");
  const app = await NestFactory.createApplicationContext(AppModule);
  const config = app.get(ConfigService);
  const spotify = app.get(SpotifyClient);
  const service = app.get(CatalogImportService);
  const enrichService = app.get(MusicBrainzEnrichService);
  const queue = app.get(CatalogQueue);
  const searchQueue = app.get(SearchQueue);
  const searchSyncService = app.get(SearchSyncService);
  const meili = app.get(MeiliService);
  const checkpoint = app.get(SpotifyCheckpointStore);
  // Each Worker gets its OWN connection (judgment-day issue #11): BullMQ's
  // Workers use blocking Redis commands, so sharing one connection between the
  // page, album, enrich, and search-sync Workers would let one Worker's blocking
  // read stall the others' commands on the same socket.
  const pageConnection = createBullConnection(config.get<string>(REDIS_URL_ENV));
  const albumConnection = createBullConnection(config.get<string>(REDIS_URL_ENV));
  const enrichConnection = createBullConnection(config.get<string>(REDIS_URL_ENV));
  const searchConnection = createBullConnection(config.get<string>(REDIS_URL_ENV));

  // Configure the Meilisearch indexes (searchable/filterable/sortable attributes)
  // once at boot, before any search-sync job runs. Best-effort: if Meili is
  // unreachable this logs and continues so the catalog page/album/enrich workers
  // still run — the search-sync jobs will retry via BullMQ backoff, and the
  // settings get (re)applied by the next `reindex:search`.
  try {
    await meili.configureIndexes();
  } catch (err) {
    logger.warn(
      `Could not configure Meilisearch indexes at boot: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

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
      } else {
        // Enqueue the NEXT page BEFORE advancing the checkpoint (judgment-day
        // issue #8): a crash between the two used to leave the checkpoint
        // advanced with no job enqueued for that page, silently stalling the
        // import. Enqueuing first means a crash before the checkpoint update
        // just re-enqueues the next page — safe, since the page job id is
        // deterministic (natural dedup).
        await queue.enqueuePage(page.nextOffset, limit);
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
        if (isForeignKeyViolation(err)) {
          logger.warn(
            `Skipping album ${job.data.album.spotifyId} due to a foreign key violation: ${err.message}`,
          );
          return;
        }
        throw err;
      }
      // Chain MusicBrainz enrichment onto the per-album unit (PR6): only reached
      // when the upsert above succeeded (a skipped album returns early), so we
      // never enqueue enrichment for an album that didn't persist.
      //
      // Deliberately left UNWRAPPED — unlike the CLI/in-process path's
      // try/catch around the equivalent call in
      // `CatalogImportService.importPage` (judgment-day issue #1, round 3).
      // A throw here fails THIS album job, which gets BullMQ's own
      // retry/backoff (`CATALOG_JOB_OPTIONS`) plus a visible entry in the
      // failed-job set for free — exactly the aggregate-failure signal the
      // CLI path has no infrastructure for and had to build by hand (see
      // `CatalogImportService.runImport`'s `enqueueFailures` tracking).
      // Swallowing this error here instead would silently drop the
      // enrichment enqueue with NO retry at all, which is strictly worse.
      // The retried job re-runs `upsertAlbum` too, but that's a cheap,
      // idempotent upsert (Decision #5) keyed on `spotifyId` — not
      // equivalent to redoing real external work — so the redundant retry
      // cost of retrying the whole album job (instead of just the enqueue)
      // is negligible.
      await queue.enqueueEnrichment(job.data.album.spotifyId);
      // Chain the search-sync onto the same per-album unit (PR7). Enqueued right
      // after upsert — NOT gated behind the rate-limited enrichment — so the
      // album is searchable by title/artist promptly (genres land when the
      // enrichment re-sync runs / on the next `reindex:search`). Left UNWRAPPED
      // for the same reason as the enrichment enqueue above: a throw fails this
      // idempotent album job and gets BullMQ's retry/backoff + failed-set
      // visibility, rather than silently dropping the sync with no retry.
      await searchQueue.enqueueAlbumSync(job.data.album.spotifyId);
    },
    { connection: albumConnection },
  );

  const enrichWorker = new Worker<EnrichJobData>(
    CATALOG_ENRICH_QUEUE,
    async (job) => {
      // Per-item error isolation mirrors the album worker: a P2002 (the resolved
      // mbid already claimed, OR a genre-slug / album-genre composite-key
      // conflict from the same transaction — see the field-gated message below),
      // a P2003, or a malformed record is logged and skipped; anything systemic
      // (lost DB/MusicBrainz connection) propagates for BullMQ's retry/backoff.
      try {
        const result = await enrichService.enrichAlbum(job.data.spotifyId);
        if (result.status !== "enriched") {
          logger.log(
            `Enrichment for album ${job.data.spotifyId}: ${result.status}`,
          );
        } else {
          // Re-sync the album into Meilisearch now that it carries genres
          // (judgment-day fix): the album-upsert worker's search-sync enqueue
          // fires BEFORE this enrichment ever runs, so `genreNames`/`genreSlugs`
          // are still empty at that point — this is the only place that ever
          // refreshes them. Log-and-continue on failure (unlike the album
          // worker's enrichment enqueue, which is deliberately left unwrapped):
          // the enrichment above already succeeded and persisted, so failing/
          // retrying this whole rate-limited MusicBrainz job over a queue-
          // producer hiccup would be disproportionate — the next
          // `reindex:search` (or a later re-enqueue) still picks up the genres.
          try {
            await searchQueue.enqueueAlbumSync(job.data.spotifyId);
          } catch (enqueueErr) {
            logger.warn(
              `Could not enqueue post-enrichment search-sync for album ` +
                `${job.data.spotifyId}: ` +
                `${enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)}`,
            );
          }
        }
      } catch (err) {
        if (err instanceof Prisma.PrismaClientValidationError) {
          logger.warn(
            `Skipping enrichment for album ${job.data.spotifyId} (malformed): ${err.message}`,
          );
          return;
        }
        if (isUniqueConstraintViolation(err)) {
          const field = extractUniqueConstraintField(err);
          if (field === "mbid") {
            // `field === "mbid"` alone is ambiguous WHICH table (judgment-day
            // issue #9): both `Album.mbid` and `Artist.mbid` are columns
            // literally named "mbid", and the driver-adapter P2002 shape this
            // project's Postgres adapter produces for a unique-constraint
            // violation only exposes `constraint.fields` (the column name) —
            // no table/model attribution is available on the error object to
            // disambiguate further (verified against `@prisma/adapter-pg`'s
            // `mapDriverError` for code `23505`). Name both candidates
            // explicitly so an operator knows to check both instead of
            // assuming a single source.
            logger.warn(
              `Skipping enrichment for album ${job.data.spotifyId} due to a unique ` +
                `constraint conflict on "mbid" — mbid already claimed by another ` +
                `Album OR Artist row (ambiguous which; check both): ${err.message}`,
            );
            return;
          }
          // Any other field (judgment-day issue #2, round 2): the same
          // transaction also does `tx.genre.upsert` (unique on `Genre.slug`)
          // and `tx.albumGenre.upsert` (composite unique) — a P2002 on either
          // of those is NOT an mbid conflict, so the mbid-specific narrative
          // above would be misleading/wrong here. Log a generic message naming
          // the actual conflicting field instead.
          logger.warn(
            `Skipping enrichment for album ${job.data.spotifyId} due to a unique ` +
              `constraint conflict${field ? ` on field "${field}"` : ""}: ${err.message}`,
          );
          return;
        }
        if (isForeignKeyViolation(err)) {
          logger.warn(
            `Skipping enrichment for album ${job.data.spotifyId} due to a foreign key violation: ${err.message}`,
          );
          return;
        }
        throw err;
      }
    },
    // The BullMQ limiter caps the enrich queue at 1 job / MusicBrainz interval
    // across the whole worker fleet — the queue-level half of the ≤1 req/s
    // guarantee (the client-side gate in MusicBrainzClient is the other half).
    { connection: enrichConnection, limiter: MUSICBRAINZ_RATE_LIMIT },
  );

  const searchWorker = new Worker<SearchSyncJobData>(
    SEARCH_SYNC_QUEUE,
    async (job) => {
      // Per-item error isolation: an album deleted between upsert and sync is a
      // benign `album-missing` (logged, not retried); a Meilisearch write
      // failure PROPAGATES so BullMQ's retry/backoff re-attempts the sync — the
      // "survives Meili downtime via Redis retry" property from design
      // Decision #6. No bespoke lock/revival/escalation logic (PR5/PR6 lesson).
      const result = await searchSyncService.syncAlbum(job.data.spotifyId);
      if (result.status !== "synced") {
        logger.log(`Search-sync for album ${job.data.spotifyId}: ${result.status}`);
      }
    },
    { connection: searchConnection },
  );

  pageWorker.on("failed", (job, err) => {
    logger.error(`Page job ${job?.id} failed: ${err.message}`);
  });
  albumWorker.on("failed", (job, err) => {
    logger.error(`Album job ${job?.id} failed: ${err.message}`);
  });
  enrichWorker.on("failed", (job, err) => {
    logger.error(`Enrich job ${job?.id} failed: ${err.message}`);
  });
  searchWorker.on("failed", (job, err) => {
    logger.error(`Search-sync job ${job?.id} failed: ${err.message}`);
  });

  logger.log(
    "Catalog seed workers running (page + album + musicbrainz-enrich + search-sync). Ctrl-C to stop.",
  );

  const shutdown = async (): Promise<void> => {
    logger.log("Shutting down catalog workers...");
    await pageWorker.close();
    await albumWorker.close();
    await enrichWorker.close();
    await searchWorker.close();
    await pageConnection.quit();
    await albumConnection.quit();
    await enrichConnection.quit();
    await searchConnection.quit();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void bootstrap();
