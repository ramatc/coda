import {
  ConflictException,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { createBullProducerConnection } from "./catalog-redis.js";
import { SpotifyCheckpointStore } from "./spotify-checkpoint.store.js";
import {
  ALBUM_JOB_NAME,
  CATALOG_ALBUM_QUEUE,
  CATALOG_JOB_OPTIONS,
  CATALOG_PAGE_QUEUE,
  PAGE_JOB_NAME,
  REDIS_URL_ENV,
  albumJobId,
  pageJobId,
} from "./catalog-import.constants.js";
import type { NormalizedAlbum } from "./spotify.types.js";

/** Data carried by a page job (which Spotify page to fetch). */
export interface PageJobData {
  offset: number;
  limit: number;
  /**
   * Running-lock ownership token (judgment-day issue #2), threaded through
   * every page job of a run so whichever job ends the run — a clean finish or
   * a permanent failure (see `catalog-worker.ts`'s `pageWorker.on("failed", ...)`)
   * — releases the SAME lock this run's `enqueueSeed()` acquired, rather than
   * an unconditional `DEL` that could delete a different run's lock.
   */
  lockToken?: string;
}

/** Data carried by a per-album job (the album to upsert / later enrich). */
export interface AlbumJobData {
  album: NormalizedAlbum;
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
 */
@Injectable()
export class CatalogQueue implements OnModuleDestroy {
  private readonly logger = new Logger(CatalogQueue.name);
  private connection: Redis | undefined;
  private pageQueue: Queue<PageJobData> | undefined;
  private albumQueue: Queue<AlbumJobData> | undefined;

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
   *
   * Also acquires the shared running-lock marker (judgment-day issue #6) so a
   * second trigger can't race the in-process `seed:catalog` pager (or another
   * seed request) over the same checkpoint; see
   * {@link SpotifyCheckpointStore.tryAcquireRunningLock} for the guard's scope
   * and limitations.
   *
   * The lock is deliberately NOT released on success — it stays held until
   * the actual import completes (via the worker's clean-finish/permanent-
   * failure paths, or `CatalogImportService.runImport`'s `finally`). It is
   * only released here if the enqueue-seed step itself throws (e.g. a
   * transient Redis/BullMQ blip) — before the real import has even started —
   * so a partial failure at this step can't leak the lock for the full TTL
   * and block every subsequent trigger (judgment-day issue #1).
   */
  async enqueueSeed(limit: number): Promise<{ offset: number }> {
    const token = await this.checkpointStore.tryAcquireRunningLock();
    if (!token) {
      throw new ConflictException(
        "Catalog import is already in progress — refusing to start a concurrent run.",
      );
    }
    try {
      const offset = (await this.checkpointStore.get()) ?? 0;
      await this.enqueuePage(offset, limit, token);
      this.logger.log(`Enqueued Spotify seed starting at offset ${offset}`);
      return { offset };
    } catch (err) {
      await this.checkpointStore.releaseRunningLock(token);
      throw err;
    }
  }

  /**
   * Enqueues a page job with a deterministic id (dedupes a re-derived page),
   * with retry/backoff and bounded cleanup so a transient failure doesn't
   * permanently drop the page (judgment-day issue #1). `lockToken`, when
   * given, rides along in the job data so the page worker can release the
   * SAME running-lock this run acquired once the run ends.
   */
  async enqueuePage(
    offset: number,
    limit: number,
    lockToken?: string,
  ): Promise<void> {
    await this.getPageQueue().add(
      PAGE_JOB_NAME,
      { offset, limit, lockToken },
      { ...CATALOG_JOB_OPTIONS, jobId: pageJobId(offset) },
    );
  }

  /**
   * Enqueues a per-album job with the deterministic `album:{spotifyId}` id, so
   * BullMQ dedupes the same album at the queue level (natural dedup, Decision
   * #5), with the same retry/backoff/cleanup policy as page jobs
   * (judgment-day issue #1).
   */
  async enqueueAlbum(album: NormalizedAlbum): Promise<void> {
    await this.getAlbumQueue().add(
      ALBUM_JOB_NAME,
      { album },
      { ...CATALOG_JOB_OPTIONS, jobId: albumJobId(album.spotifyId) },
    );
  }

  /**
   * Enqueues many per-album jobs in a single BullMQ round-trip (`addBulk`)
   * instead of one `add()` per album (judgment-day issue #4) — the page
   * worker's per-page fan-out is up to `SPOTIFY_PAGE_LIMIT` albums, which would
   * otherwise be that many sequential Redis round-trips.
   */
  async enqueueAlbums(albums: NormalizedAlbum[]): Promise<void> {
    if (albums.length === 0) {
      return;
    }
    await this.getAlbumQueue().addBulk(
      albums.map((album) => ({
        name: ALBUM_JOB_NAME,
        data: { album },
        opts: { ...CATALOG_JOB_OPTIONS, jobId: albumJobId(album.spotifyId) },
      })),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.pageQueue?.close();
    await this.albumQueue?.close();
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
}
