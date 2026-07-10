import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import {
  ALBUM_JOB_NAME,
  CATALOG_ALBUM_QUEUE,
  CATALOG_PAGE_QUEUE,
  PAGE_JOB_NAME,
  albumJobId,
  pageJobId,
} from "../src/catalog-import/catalog-import.constants.js";
import type { SpotifyCheckpointStore } from "../src/catalog-import/spotify-checkpoint.store.js";
import type { NormalizedAlbum } from "../src/catalog-import/spotify.types.js";

// No live Redis/BullMQ in the sandbox: stub the connection factory and the
// `Queue` class itself, matching the mocking style already used for `ioredis`
// in spotify-checkpoint.store.spec.ts.
vi.mock("../src/catalog-import/catalog-redis.js", () => ({
  createBullConnection: () => ({ quit: vi.fn().mockResolvedValue("OK") }),
  createBullProducerConnection: () => ({ quit: vi.fn().mockResolvedValue("OK") }),
}));

interface FakeAddedJob {
  name: string;
  data: unknown;
  opts: { jobId?: string; attempts?: number; backoff?: unknown; removeOnFail?: unknown };
}

/**
 * Mirrors just enough of a real BullMQ `Job` to prove the stale-`failed`-job
 * revival (judgment-day issue #1, Round 3): a `state` that a test can force to
 * `"failed"` (simulating a job that exhausted all its retry attempts), and a
 * `retry()` that moves it back to `"waiting"` — the same transition BullMQ's
 * real `job.retry()` performs.
 */
class FakeJob {
  state: "waiting" | "failed" = "waiting";
  retryCount = 0;

  constructor(
    public readonly id: string,
    private readonly queue: FakeQueue,
  ) {}

  async getState(): Promise<string> {
    return this.state;
  }

  async retry(): Promise<void> {
    this.state = "waiting";
    this.retryCount += 1;
    this.queue.retriedJobIds.push(this.id);
  }
}

class FakeQueue {
  added: FakeAddedJob[] = [];
  retriedJobIds: string[] = [];
  private readonly jobsById = new Map<string, FakeJob>();

  constructor(private readonly name: string) {
    registry.set(name, this);
  }

  async add(
    name: string,
    data: unknown,
    opts: FakeAddedJob["opts"] = {},
  ): Promise<{ id?: string }> {
    // Mirrors BullMQ's deterministic-jobId dedup: re-adding an already-seen
    // jobId is a no-op that doesn't push a second entry, REGARDLESS of that
    // existing job's state (judgment-day issue #1, Round 3) — `EXISTS
    // jobIdKey` is true for a job in any state, including `failed`.
    if (opts.jobId && this.jobsById.has(opts.jobId)) {
      return { id: opts.jobId };
    }
    if (opts.jobId) {
      this.jobsById.set(opts.jobId, new FakeJob(opts.jobId, this));
    }
    this.added.push({ name, data, opts });
    return { id: opts.jobId };
  }

  async addBulk(
    jobs: Array<{ name: string; data: unknown; opts?: FakeAddedJob["opts"] }>,
  ): Promise<Array<{ id?: string }>> {
    const results: Array<{ id?: string }> = [];
    for (const job of jobs) {
      results.push(await this.add(job.name, job.data, job.opts));
    }
    return results;
  }

  async getJob(jobId: string): Promise<FakeJob | undefined> {
    return this.jobsById.get(jobId);
  }

  async close(): Promise<void> {}
}

const registry = new Map<string, FakeQueue>();

vi.mock("bullmq", () => {
  return { Queue: FakeQueue, __queueRegistry: registry };
});

const { CatalogQueue } = await import("../src/catalog-import/catalog-queue.js");
const bullmq = (await import("bullmq")) as unknown as {
  __queueRegistry: Map<string, FakeQueue>;
};

function fakeConfig(): ConfigService {
  return { get: () => undefined } as unknown as ConfigService;
}

function createFakeCheckpoint() {
  const state = { offset: null as number | null, lockToken: null as string | null };
  let tokenSeq = 0;
  const store: SpotifyCheckpointStore = {
    async get() {
      return state.offset;
    },
    async set(offset: number) {
      state.offset = offset;
    },
    async clear() {
      state.offset = null;
    },
    // Ownership-token contract (judgment-day issue #2): returns a unique
    // token on success, `null` if already held; `releaseRunningLock` only
    // clears the lock if the given token still matches.
    async tryAcquireRunningLock() {
      if (state.lockToken !== null) {
        return null;
      }
      state.lockToken = `fake-token-${++tokenSeq}`;
      return state.lockToken;
    },
    async releaseRunningLock(token: string) {
      if (state.lockToken === token) {
        state.lockToken = null;
        return true;
      }
      return false;
    },
  } as unknown as SpotifyCheckpointStore;
  return { store, state };
}

function album(spotifyId: string): NormalizedAlbum {
  return {
    spotifyId,
    title: `Album ${spotifyId}`,
    releaseDate: null,
    coverUrl: null,
    trackCount: null,
    popularityScore: 0,
    primaryArtist: {
      spotifyId: `artist-${spotifyId}`,
      name: "Some Artist",
      imageUrl: null,
    },
  };
}

describe("CatalogQueue", () => {
  let checkpoint: ReturnType<typeof createFakeCheckpoint>;
  let queue: InstanceType<typeof CatalogQueue>;

  beforeEach(() => {
    bullmq.__queueRegistry.clear();
    checkpoint = createFakeCheckpoint();
    queue = new CatalogQueue(fakeConfig(), checkpoint.store);
  });

  it("enqueues a page job with the deterministic job id and a retry/backoff/cleanup policy", async () => {
    await queue.enqueuePage(100, 50);

    const pageQueue = bullmq.__queueRegistry.get(CATALOG_PAGE_QUEUE)!;
    expect(pageQueue.added).toHaveLength(1);
    const job = pageQueue.added[0];
    expect(job.name).toBe(PAGE_JOB_NAME);
    expect(job.opts.jobId).toBe(pageJobId(100));
    expect(job.opts.attempts).toBeGreaterThan(1);
    expect(job.opts.backoff).toBeDefined();
    expect(job.opts.removeOnFail).toBeDefined();
  });

  it("dedupes re-enqueuing the same page offset (deterministic jobId no-op)", async () => {
    await queue.enqueuePage(100, 50);
    await queue.enqueuePage(100, 50);

    const pageQueue = bullmq.__queueRegistry.get(CATALOG_PAGE_QUEUE)!;
    expect(pageQueue.added).toHaveLength(1);
  });

  it("enqueues a per-album job with the deterministic album job id and retry/backoff/cleanup policy", async () => {
    await queue.enqueueAlbum(album("alb-1"));

    const albumQueue = bullmq.__queueRegistry.get(CATALOG_ALBUM_QUEUE)!;
    expect(albumQueue.added).toHaveLength(1);
    const job = albumQueue.added[0];
    expect(job.name).toBe(ALBUM_JOB_NAME);
    expect(job.opts.jobId).toBe(albumJobId("alb-1"));
    expect(job.opts.attempts).toBeGreaterThan(1);
    expect(job.opts.backoff).toBeDefined();
  });

  it("enqueueAlbums fans out a page's albums via a single bulk call, deduping repeats", async () => {
    await queue.enqueueAlbums([album("alb-1"), album("alb-1"), album("alb-2")]);

    const albumQueue = bullmq.__queueRegistry.get(CATALOG_ALBUM_QUEUE)!;
    expect(albumQueue.added).toHaveLength(2);
    expect(albumQueue.added.map((j) => j.opts.jobId)).toEqual([
      albumJobId("alb-1"),
      albumJobId("alb-2"),
    ]);
  });

  it("enqueueAlbums is a no-op for an empty page", async () => {
    await queue.enqueueAlbums([]);
    expect(bullmq.__queueRegistry.get(CATALOG_ALBUM_QUEUE)).toBeUndefined();
  });

  it("enqueueSeed resumes from the checkpoint offset and enqueues the first page with the lock token", async () => {
    await checkpoint.store.set(100);

    const result = await queue.enqueueSeed(50);

    expect(result.offset).toBe(100);
    const pageQueue = bullmq.__queueRegistry.get(CATALOG_PAGE_QUEUE)!;
    // The lock token rides along in the page job data (judgment-day issue #2)
    // so the page worker can release the SAME lock once the run ends.
    expect(pageQueue.added[0].data).toEqual({
      offset: 100,
      limit: 50,
      lockToken: expect.any(String),
    });
    // The lock is deliberately still held after a successful enqueue (judgment-
    // day issue #1) — it's released by the import's actual completion, not here.
    expect(checkpoint.state.lockToken).not.toBeNull();
  });

  it("enqueueSeed refuses to start a concurrent run while the running lock is held, mapping to a 409 (judgment-day issue #10)", async () => {
    await queue.enqueueSeed(50);

    await expect(queue.enqueueSeed(50)).rejects.toThrow(/already in progress/);
    await expect(queue.enqueueSeed(50)).rejects.toBeInstanceOf(ConflictException);
    try {
      await queue.enqueueSeed(50);
      throw new Error("expected enqueueSeed to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getStatus()).toBe(409);
    }
  });

  it("releases the running lock if the enqueue-seed step throws before the import starts (judgment-day issue #1)", async () => {
    const failingStore: SpotifyCheckpointStore = {
      ...checkpoint.store,
      async get() {
        throw new Error("transient redis blip");
      },
    } as unknown as SpotifyCheckpointStore;
    const failingQueue = new CatalogQueue(fakeConfig(), failingStore);

    await expect(failingQueue.enqueueSeed(50)).rejects.toThrow(
      /transient redis blip/,
    );

    // The lock must have been released despite the failure — a subsequent
    // acquire (e.g. from a retried trigger) must succeed rather than being
    // blocked for the full TTL by a leaked lock.
    expect(await failingStore.tryAcquireRunningLock()).not.toBeNull();
  });

  it("propagates the ORIGINAL enqueue-seed error even if releasing the lock also fails (judgment-day issue #2, Round 3)", async () => {
    const failingStore: SpotifyCheckpointStore = {
      ...checkpoint.store,
      async get() {
        throw new Error("original root cause: transient redis blip");
      },
      async releaseRunningLock() {
        throw new Error("release also failed: redis still down");
      },
    } as unknown as SpotifyCheckpointStore;
    const failingQueue = new CatalogQueue(fakeConfig(), failingStore);

    // The caller must see the ORIGINAL error, not the release's error.
    await expect(failingQueue.enqueueSeed(50)).rejects.toThrow(
      /original root cause/,
    );
  });

  describe("stale failed-job revival on retrigger (judgment-day issue #1, Round 3)", () => {
    it("enqueuePage retries a job that's already in a failed state instead of silently no-op'ing", async () => {
      await queue.enqueuePage(100, 50);
      const pageQueue = bullmq.__queueRegistry.get(CATALOG_PAGE_QUEUE)!;
      const jobId = pageJobId(100);
      const job = await pageQueue.getJob(jobId);
      // Simulate BullMQ having moved this job to `failed` after it exhausted
      // all configured retry attempts.
      job!.state = "failed";

      // Retriggering (e.g. via a re-run of enqueueSeed) must revive it.
      await queue.enqueuePage(100, 50);

      expect(await job!.getState()).toBe("waiting");
      expect(pageQueue.retriedJobIds).toContain(jobId);
    });

    it("enqueuePage leaves a non-failed job alone (no spurious retry)", async () => {
      await queue.enqueuePage(100, 50);
      const pageQueue = bullmq.__queueRegistry.get(CATALOG_PAGE_QUEUE)!;

      await queue.enqueuePage(100, 50);

      expect(pageQueue.retriedJobIds).toHaveLength(0);
    });

    it("enqueueAlbum retries a job that's already in a failed state instead of silently no-op'ing", async () => {
      await queue.enqueueAlbum(album("alb-1"));
      const albumQueue = bullmq.__queueRegistry.get(CATALOG_ALBUM_QUEUE)!;
      const jobId = albumJobId("alb-1");
      const job = await albumQueue.getJob(jobId);
      job!.state = "failed";

      await queue.enqueueAlbum(album("alb-1"));

      expect(await job!.getState()).toBe("waiting");
      expect(albumQueue.retriedJobIds).toContain(jobId);
    });
  });
});
