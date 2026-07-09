import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import {
  CHECKPOINT_KEY,
  CHECKPOINT_RUNNING_LOCK_KEY,
  CHECKPOINT_RUNNING_LOCK_TTL_MS,
  DEFAULT_REDIS_URL,
  REDIS_URL_ENV,
} from "./catalog-import.constants.js";

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
  /**
   * Optional distributed "run in progress" guard (judgment-day issue #6): a
   * best-effort SET-NX marker, not a renewing lock (see
   * {@link SpotifyCheckpointStore.tryAcquireRunningLock}). Optional so
   * in-memory test fakes — which never exercise two concurrent runs — don't
   * need to implement it.
   */
  tryAcquireRunningLock?(): Promise<boolean>;
  /** Releases the marker acquired by `tryAcquireRunningLock`. */
  releaseRunningLock?(): Promise<void>;
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

  /**
   * Best-effort mutual exclusion between the in-process `seed:catalog` pager
   * and the BullMQ page-worker pipeline (judgment-day issue #6): both read/
   * write {@link CHECKPOINT_KEY} with no other coordination, so running both
   * concurrently can stomp each other's progress. A single Redis `SET NX PX`
   * marker with a TTL was chosen over a full renewing distributed lock: the
   * BullMQ pipeline's "run" spans many independent async job invocations over
   * an unbounded duration, so a proper lock would need heartbeat renewal
   * handed off between jobs — disproportionate complexity for this PR. The
   * TTL is the safety net for a crashed run that never releases the marker.
   */
  async tryAcquireRunningLock(): Promise<boolean> {
    const result = await this.client().set(
      CHECKPOINT_RUNNING_LOCK_KEY,
      "1",
      "PX",
      CHECKPOINT_RUNNING_LOCK_TTL_MS,
      "NX",
    );
    return result === "OK";
  }

  /** Releases the marker acquired by {@link tryAcquireRunningLock}. */
  async releaseRunningLock(): Promise<void> {
    await this.client().del(CHECKPOINT_RUNNING_LOCK_KEY);
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
