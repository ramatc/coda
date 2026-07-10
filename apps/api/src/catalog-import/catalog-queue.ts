import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { createBullProducerConnection } from "./catalog-redis.js";
import { SpotifyCheckpointStore } from "./spotify-checkpoint.store.js";
import {
  ALBUM_JOB_NAME,
  CATALOG_ALBUM_QUEUE,
  CATALOG_ENRICH_QUEUE,
  CATALOG_JOB_OPTIONS,
  CATALOG_PAGE_QUEUE,
  ENRICH_JOB_NAME,
  PAGE_JOB_NAME,
  REDIS_URL_ENV,
  albumJobId,
  enrichJobId,
  pageJobId,
} from "./catalog-import.constants.js";
import type { NormalizedAlbum } from "./spotify.types.js";

/** Data carried by a page job (which Spotify page to fetch). */
export interface PageJobData {
  offset: number;
  limit: number;
}

/** Data carried by a per-album job (the album to upsert / later enrich). */
export interface AlbumJobData {
  album: NormalizedAlbum;
}

/** Data carried by a per-album MusicBrainz enrichment job (PR6). */
export interface EnrichJobData {
  /** Stable Spotify id of the seeded album to enrich (looked up by the worker). */
  spotifyId: string;
}

/**
 * BullMQ producer for the bulk seed. The API process only ever PRODUCES jobs
 * (the workers run in a separate `worker:catalog` process — Decision #4), so
 * nothing here consumes.
 *
 * Both BullMQ queues and their shared Redis connection are created LAZILY on
 * first enqueue: constructing this provider is side-effect-free, so the API
 * boots without Redis and the e2e suite (which boots the full AppModule) never
 * opens a socket. Connections are closed on module destroy if they were opened.
 *
 * Fase 1 MVP scope note: there is no distributed lock guarding against
 * concurrent runs and no automatic revival of permanently-failed jobs — this
 * assumes a single operator triggers an import at a time, and treats a
 * BullMQ job that exhausts its retries as something an operator inspects/
 * retries manually (e.g. via Bull Board or `queue.getJob(id).retry()`).
 */
@Injectable()
export class CatalogQueue implements OnModuleDestroy {
  private readonly logger = new Logger(CatalogQueue.name);
  private connection: Redis | undefined;
  private pageQueue: Queue<PageJobData> | undefined;
  private albumQueue: Queue<AlbumJobData> | undefined;
  private enrichQueue: Queue<EnrichJobData> | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly checkpointStore: SpotifyCheckpointStore,
  ) {}

  /**
   * Kicks off (or resumes) a bulk import by enqueuing the first page job. The
   * starting offset comes from the Redis checkpoint, so triggering an import
   * after an interruption picks up where it left off rather than restarting from
   * zero. The deterministic page job id keeps a concurrent double-trigger from
   * enqueuing the same page twice.
   */
  async enqueueSeed(limit: number): Promise<{ offset: number }> {
    const offset = (await this.checkpointStore.get()) ?? 0;
    await this.enqueuePage(offset, limit);
    this.logger.log(`Enqueued Spotify seed starting at offset ${offset}`);
    return { offset };
  }

  /**
   * Enqueues a page job with a deterministic id (dedupes a re-derived page),
   * with retry/backoff and bounded cleanup so a transient failure doesn't
   * permanently drop the page (judgment-day issue #1).
   */
  async enqueuePage(offset: number, limit: number): Promise<void> {
    const jobId = pageJobId(offset);
    await this.getPageQueue().add(
      PAGE_JOB_NAME,
      { offset, limit },
      { ...CATALOG_JOB_OPTIONS, jobId },
    );
  }

  /**
   * Enqueues many per-album jobs in a single BullMQ round-trip (`addBulk`)
   * instead of one `add()` per album (judgment-day issue #4) — the page
   * worker's per-page fan-out is up to `SPOTIFY_PAGE_LIMIT` albums, which would
   * otherwise be that many sequential Redis round-trips. This is the ONLY
   * production album-enqueue path (the page worker calls this, never a
   * singular per-album `add()`).
   */
  async enqueueAlbums(albums: NormalizedAlbum[]): Promise<void> {
    if (albums.length === 0) {
      return;
    }
    const albumQueue = this.getAlbumQueue();
    await albumQueue.addBulk(
      albums.map((album) => ({
        name: ALBUM_JOB_NAME,
        data: { album },
        opts: { ...CATALOG_JOB_OPTIONS, jobId: albumJobId(album.spotifyId) },
      })),
    );
  }

  /**
   * Enqueues a MusicBrainz enrichment job for a just-upserted album (PR6). Called
   * by the album worker AFTER a successful upsert, so only albums that actually
   * persisted get chained into the rate-limited enrichment leg. The deterministic
   * `mbenrich:{spotifyId}` job id dedupes re-enqueues (resume / overlapping pages).
   */
  async enqueueEnrichment(spotifyId: string): Promise<void> {
    await this.getEnrichQueue().add(
      ENRICH_JOB_NAME,
      { spotifyId },
      { ...CATALOG_JOB_OPTIONS, jobId: enrichJobId(spotifyId) },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pageQueue?.close();
    await this.albumQueue?.close();
    await this.enrichQueue?.close();
    if (this.connection) {
      await this.connection.quit();
    }
  }

  private getConnection(): Redis {
    if (!this.connection) {
      // Bounded-retry producer connection (judgment-day issue #6) — NOT the
      // Worker-only `createBullConnection` default, since this connection is
      // reachable synchronously from the admin HTTP request path.
      this.connection = createBullProducerConnection(
        this.config.get<string>(REDIS_URL_ENV),
      );
    }
    return this.connection;
  }

  private getPageQueue(): Queue<PageJobData> {
    const queue =
      this.pageQueue ??
      (this.pageQueue = new Queue<PageJobData>(CATALOG_PAGE_QUEUE, {
        connection: this.getConnection(),
      }));
    return queue;
  }

  private getAlbumQueue(): Queue<AlbumJobData> {
    const queue =
      this.albumQueue ??
      (this.albumQueue = new Queue<AlbumJobData>(CATALOG_ALBUM_QUEUE, {
        connection: this.getConnection(),
      }));
    return queue;
  }

  private getEnrichQueue(): Queue<EnrichJobData> {
    const queue =
      this.enrichQueue ??
      (this.enrichQueue = new Queue<EnrichJobData>(CATALOG_ENRICH_QUEUE, {
        connection: this.getConnection(),
      }));
    return queue;
  }
}
