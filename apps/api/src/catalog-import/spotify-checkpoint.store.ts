import { randomUUID } from "node:crypto";
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
 * Atomic "release iff still the owner" Lua script (judgment-day issue #2) run
 * via `EVAL`: a plain `GET` followed by a separate `DEL` would have a TOCTOU
 * gap between the two commands where a different run could acquire the lock
 * in between, so the compare-and-delete must happen as a single Redis
 * operation. `KEYS[1]` is the lock key, `ARGV[1]` is the caller's token.
 */
const RELEASE_LOCK_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

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
   *
   * Returns a unique ownership token on success (or `null` if the lock is
   * already held) so the caller can prove ownership when releasing it
   * (judgment-day issue #2) — an unconditional `DEL` in `releaseRunningLock`
   * would otherwise let a run whose TTL already expired (and was replaced by a
   * newer run's lock) delete that NEWER run's lock instead of its own.
   */
  tryAcquireRunningLock?(): Promise<string | null>;
  /** Releases the marker acquired by `tryAcquireRunningLock`, iff `token` still owns it. */
  releaseRunningLock?(token: string): Promise<void>;
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
   *
   * The lock's VALUE is a unique per-acquisition token (judgment-day issue
   * #2), not a constant — so a caller who eventually calls
   * {@link releaseRunningLock} can prove it still owns the CURRENT lock. This
   * matters because the TTL is a safety net, not a guarantee: if run A's lock
   * expires while it's still legitimately running, and run B then acquires a
   * new lock, an unconditional `DEL` from A's eventual (redundant) release
   * would delete B's lock — letting a third run C start concurrently with B
   * and defeat the mutex entirely.
   */
  async tryAcquireRunningLock(): Promise<string | null> {
    const token = randomUUID();
    const result = await this.client().set(
      CHECKPOINT_RUNNING_LOCK_KEY,
      token,
      "PX",
      CHECKPOINT_RUNNING_LOCK_TTL_MS,
      "NX",
    );
    return result === "OK" ? token : null;
  }

  /**
   * Releases the marker acquired by {@link tryAcquireRunningLock}, but ONLY if
   * `token` still matches the lock's current value — otherwise this is a
   * would-be release of a lock this caller no longer (or never did) own, and
   * is a no-op. The get-and-conditional-delete must be a single atomic Redis
   * operation (a Lua script via `EVAL`): a plain `GET` followed by a separate
   * `DEL` would itself have a TOCTOU gap where a third party could acquire the
   * lock between the two commands.
   */
  async releaseRunningLock(token: string): Promise<void> {
    await this.client().eval(
      RELEASE_LOCK_IF_OWNER_SCRIPT,
      1,
      CHECKPOINT_RUNNING_LOCK_KEY,
      token,
    );
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
