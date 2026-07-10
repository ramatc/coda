import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import { CHECKPOINT_KEY, DEFAULT_REDIS_URL, REDIS_URL_ENV } from "./catalog-import.constants.js";

/**
 * Minimal cursor store the resumable importer depends on. Abstracted behind an
 * interface so the import loop can be exercised against an in-memory fake in
 * tests (no live Redis in the sandbox), exactly the way the Prisma-backed
 * services are tested against a fake Prisma client.
 */
export interface CatalogCheckpointStore {
  /** Last completed page offset, or `null` if no import has checkpointed yet. */
  get(): Promise<number | null>;
  /** Records `offset` as the resume point for the next page. */
  set(offset: number): Promise<void>;
  /** Clears the checkpoint (called once an import runs to completion). */
  clear(): Promise<void>;
}

/**
 * Redis-backed {@link CatalogCheckpointStore} storing the last completed page
 * offset under a single key (Decision #5). Persisting the cursor in Redis — not
 * in process memory — is what lets an import killed mid-run resume from where it
 * stopped rather than restarting from zero.
 *
 * The ioredis connection is created LAZILY on first use (mirroring the
 * lazy-Prisma / lazy-S3 pattern in PR1/PR3), so the API process boots green
 * without a reachable Redis and the e2e suite — which boots the full AppModule —
 * never opens a socket. `lazyConnect` further defers the actual TCP connect to
 * the first command.
 */
@Injectable()
export class SpotifyCheckpointStore
  implements CatalogCheckpointStore, OnModuleDestroy
{
  private readonly logger = new Logger(SpotifyCheckpointStore.name);
  private redis: Redis | undefined;

  constructor(private readonly config: ConfigService) {}

  async get(): Promise<number | null> {
    const raw = await this.client().get(CHECKPOINT_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  async set(offset: number): Promise<void> {
    await this.client().set(CHECKPOINT_KEY, String(offset));
  }

  async clear(): Promise<void> {
    await this.client().del(CHECKPOINT_KEY);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  private client(): Redis {
    if (!this.redis) {
      const url = this.config.get<string>(REDIS_URL_ENV) ?? DEFAULT_REDIS_URL;
      // `maxRetriesPerRequest: null` is a BullMQ-Worker-only requirement (see
      // `createBullConnection`): this client only ever issues plain get/set/del
      // commands, so it must NOT inherit that setting — combined with ioredis's
      // default indefinite reconnect strategy, `null` here would make every
      // command hang forever during a Redis outage (including the admin HTTP
      // endpoint, which calls `get()` synchronously in the request path).
      // A bounded value fails a request fast instead (judgment-day issue #5).
      this.redis = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 5,
      });
      this.redis.on("error", (err) => {
        this.logger.error(`Redis checkpoint connection error: ${err.message}`);
      });
    }
    return this.redis;
  }
}
