import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { createBullProducerConnection } from "../catalog-import/catalog-redis.js";
import { REDIS_URL_ENV } from "../catalog-import/catalog-import.constants.js";
import {
  SEARCH_SYNC_JOB_NAME,
  SEARCH_SYNC_JOB_OPTIONS,
  SEARCH_SYNC_QUEUE,
  searchAlbumSyncJobId,
} from "./search.constants.js";

/** Data carried by a per-album search-sync job. */
export interface SearchSyncJobData {
  /** Stable Spotify id of the album to (re)index (looked up by the worker). */
  spotifyId: string;
}

/**
 * BullMQ producer for the search projection's write-through queue (PR7, design
 * Decision #6). The catalog album worker (and the in-process CLI pager) enqueue
 * one job per successfully-upserted album; the `search-sync` Worker consumes them
 * and writes the album/artist documents into Meilisearch.
 *
 * Same lazy-infra posture as {@link CatalogQueue}: the queue and its Redis
 * connection are created on first enqueue, so constructing this provider is
 * side-effect-free and the full-AppModule e2e suite never opens a socket. Reuses
 * the catalog module's bounded-retry producer connection factory (the search
 * enqueue is reachable synchronously from the catalog worker/CLI path).
 *
 * Fase 1 MVP scope note: no distributed lock and no custom job-revival — a
 * search-sync job that exhausts its BullMQ retries is left in the failed set for
 * an operator to retry (or simply re-run `reindex:search`, which rebuilds the
 * whole projection). Sufficient for a single-operator MVP (PR5/PR6 lesson).
 */
@Injectable()
export class SearchQueue implements OnModuleDestroy {
  private connection: Redis | undefined;
  private queue: Queue<SearchSyncJobData> | undefined;

  constructor(private readonly config: ConfigService) {}

  /**
   * Enqueues a search-sync job for a just-upserted album. The deterministic
   * `search-album:{spotifyId}` job id dedupes re-enqueues (resume / overlapping
   * pages / a re-sync after enrichment while an earlier sync is still pending).
   */
  async enqueueAlbumSync(spotifyId: string): Promise<void> {
    await this.getQueue().add(
      SEARCH_SYNC_JOB_NAME,
      { spotifyId },
      { ...SEARCH_SYNC_JOB_OPTIONS, jobId: searchAlbumSyncJobId(spotifyId) },
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

  private getQueue(): Queue<SearchSyncJobData> {
    const queue =
      this.queue ??
      (this.queue = new Queue<SearchSyncJobData>(SEARCH_SYNC_QUEUE, {
        connection: this.getConnection(),
      }));
    return queue;
  }
}
