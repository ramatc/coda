import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import {
  SEARCH_SYNC_JOB_NAME,
  SEARCH_SYNC_QUEUE,
  searchAlbumSyncJobId,
} from "../src/search/search.constants.js";

// No live Redis/BullMQ in the sandbox: stub the connection factory and the
// `Queue` class, matching catalog-queue.spec.ts.
vi.mock("../src/catalog-import/catalog-redis.js", () => ({
  createBullProducerConnection: () => ({ quit: vi.fn().mockResolvedValue("OK") }),
}));

interface FakeAddedJob {
  name: string;
  data: unknown;
  opts: {
    jobId?: string;
    attempts?: number;
    backoff?: unknown;
    removeOnFail?: unknown;
    removeOnComplete?: unknown;
  };
}

/** Minimal fake of the BullMQ `Job` handle returned by `Queue.getJob`. */
class FakeJobHandle {
  constructor(
    private readonly queue: FakeQueue,
    public readonly job: FakeAddedJob,
    private readonly jobId: string,
  ) {}

  async isFailed(): Promise<boolean> {
    return this.queue.failedJobIds.has(this.jobId);
  }

  async isCompleted(): Promise<boolean> {
    return this.queue.completedJobIds.has(this.jobId);
  }

  async remove(): Promise<void> {
    if (this.queue.lockedJobIds.has(this.jobId)) {
      // Mirrors BullMQ's classes/job.js: a job picked up by a worker between
      // the state check and `remove()` can't be removed anymore.
      throw new Error(
        `Job ${this.jobId} could not be removed because it is locked by another worker`,
      );
    }
    const removeError = this.queue.removeErrors.get(this.jobId);
    if (removeError) {
      throw removeError;
    }
    this.queue.added = this.queue.added.filter((j) => j !== this.job);
  }
}

class FakeQueue {
  added: FakeAddedJob[] = [];
  /** jobIds this test wants `getJob` to report as being in the failed state. */
  failedJobIds = new Set<string>();
  /** jobIds this test wants `getJob` to report as being in the completed state. */
  completedJobIds = new Set<string>();
  /** jobIds whose `remove()` should reject as locked by another worker. */
  lockedJobIds = new Set<string>();
  /** jobIds whose `remove()` should reject with an arbitrary, non-lock error. */
  removeErrors = new Map<string, Error>();

  constructor(private readonly name: string) {
    registry.set(name, this);
  }

  async add(
    name: string,
    data: unknown,
    opts: FakeAddedJob["opts"] = {},
  ): Promise<{ id?: string }> {
    if (opts.jobId && this.added.some((job) => job.opts.jobId === opts.jobId)) {
      return { id: opts.jobId };
    }
    this.added.push({ name, data, opts });
    return { id: opts.jobId };
  }

  async getJob(jobId: string): Promise<FakeJobHandle | undefined> {
    const job = this.added.find((j) => j.opts.jobId === jobId);
    if (!job) {
      return undefined;
    }
    return new FakeJobHandle(this, job, jobId);
  }

  async close(): Promise<void> {}
}

const registry = new Map<string, FakeQueue>();

vi.mock("bullmq", () => ({ Queue: FakeQueue }));

const { SearchQueue } = await import("../src/search/search-queue.js");

function fakeConfig(): ConfigService {
  return { get: () => undefined } as unknown as ConfigService;
}

describe("SearchQueue", () => {
  let queue: InstanceType<typeof SearchQueue>;

  beforeEach(() => {
    registry.clear();
    queue = new SearchQueue(fakeConfig());
  });

  it("enqueues a search-sync job with the deterministic job id and a retry/backoff/cleanup policy", async () => {
    await queue.enqueueAlbumSync("sp-1");

    const syncQueue = registry.get(SEARCH_SYNC_QUEUE)!;
    expect(syncQueue.added).toHaveLength(1);
    const job = syncQueue.added[0];
    expect(job.name).toBe(SEARCH_SYNC_JOB_NAME);
    expect(job.data).toEqual({ spotifyId: "sp-1" });
    expect(job.opts.jobId).toBe(searchAlbumSyncJobId("sp-1"));
    expect(job.opts.attempts).toBeGreaterThan(1);
    expect(job.opts.backoff).toBeDefined();
    expect(job.opts.removeOnFail).toBeDefined();
  });

  it("dedupes re-enqueuing sync for the same album (deterministic jobId no-op)", async () => {
    await queue.enqueueAlbumSync("sp-1");
    await queue.enqueueAlbumSync("sp-1");

    const syncQueue = registry.get(SEARCH_SYNC_QUEUE)!;
    expect(syncQueue.added).toHaveLength(1);
  });

  // judgment-day fix: BullMQ's `Queue.add()` silently no-ops if a job with the
  // same deterministic id already exists in ANY state, including `failed`.
  // Without removing a failed job first, an album whose sync exhausted its
  // retries could never be re-synced again via `enqueueAlbumSync`.
  it("removes a pre-existing FAILED job before re-adding, so a retries-exhausted album can be re-synced", async () => {
    await queue.enqueueAlbumSync("sp-1");

    const syncQueue = registry.get(SEARCH_SYNC_QUEUE)!;
    syncQueue.failedJobIds.add(searchAlbumSyncJobId("sp-1"));

    await queue.enqueueAlbumSync("sp-1");

    // The stale failed job was removed and a fresh one was added in its place
    // — still exactly one entry, but it's a genuinely NEW job, not a no-op.
    expect(syncQueue.added).toHaveLength(1);
    expect(syncQueue.added[0].opts.jobId).toBe(searchAlbumSyncJobId("sp-1"));
  });

  // judgment-day fix (round 3): the common case is actually `completed`, not
  // `failed` — the search-sync job for an album almost always finishes
  // before the rate-limited MusicBrainz enrichment calls this method again.
  it("removes a pre-existing COMPLETED job before re-adding, so a re-sync after enrichment actually happens", async () => {
    await queue.enqueueAlbumSync("sp-1");

    const syncQueue = registry.get(SEARCH_SYNC_QUEUE)!;
    syncQueue.completedJobIds.add(searchAlbumSyncJobId("sp-1"));

    await queue.enqueueAlbumSync("sp-1");

    // The stale completed job was removed and a fresh one was added in its
    // place — still exactly one entry, but it's a genuinely NEW job.
    expect(syncQueue.added).toHaveLength(1);
    expect(syncQueue.added[0].opts.jobId).toBe(searchAlbumSyncJobId("sp-1"));
  });

  it("does not remove the queue's existing job when it is still in flight (active/waiting/delayed)", async () => {
    await queue.enqueueAlbumSync("sp-1");
    const syncQueue = registry.get(SEARCH_SYNC_QUEUE)!;
    const originalJob = syncQueue.added[0];
    const removeSpy = vi.spyOn(FakeJobHandle.prototype, "remove");

    // Neither failed nor completed => still in flight; `remove()` must not
    // be called. `add()` is still invoked but no-ops against the existing
    // jobId at the fake level, same as real BullMQ.
    await queue.enqueueAlbumSync("sp-1");

    expect(removeSpy).not.toHaveBeenCalled();
    expect(syncQueue.added).toHaveLength(1);
    expect(syncQueue.added[0]).toBe(originalJob);

    removeSpy.mockRestore();
  });

  // judgment-day fix (round 3, TOCTOU): the existing job can transition to
  // `active` between the state check and `remove()` if a worker picks it up
  // concurrently. BullMQ then throws "locked by another worker" from
  // `remove()` — that must be swallowed, not propagated, since the in-flight
  // job will produce a fresh document on its own.
  it("swallows a 'locked by another worker' error from remove() instead of throwing", async () => {
    await queue.enqueueAlbumSync("sp-1");

    const syncQueue = registry.get(SEARCH_SYNC_QUEUE)!;
    const jobId = searchAlbumSyncJobId("sp-1");
    syncQueue.completedJobIds.add(jobId);
    syncQueue.lockedJobIds.add(jobId);
    const originalJob = syncQueue.added[0];

    await expect(queue.enqueueAlbumSync("sp-1")).resolves.toBeUndefined();

    // add() was not called after the failed remove() — the stale job is
    // still there, untouched.
    expect(syncQueue.added).toHaveLength(1);
    expect(syncQueue.added[0]).toBe(originalJob);
  });

  // judgment-day fix (round 4): only the specific "locked by another worker"
  // message is a benign race that should be swallowed. Any other `remove()`
  // failure (e.g. a genuine Redis/infra error) must still propagate to the
  // caller instead of being silently logged away.
  it("rethrows a non-lock error from remove() instead of swallowing it", async () => {
    await queue.enqueueAlbumSync("sp-1");

    const syncQueue = registry.get(SEARCH_SYNC_QUEUE)!;
    const jobId = searchAlbumSyncJobId("sp-1");
    syncQueue.completedJobIds.add(jobId);
    syncQueue.removeErrors.set(jobId, new Error("ECONNRESET"));
    const originalJob = syncQueue.added[0];

    await expect(queue.enqueueAlbumSync("sp-1")).rejects.toThrow("ECONNRESET");

    // add() was not called after the failed remove() — the stale job is
    // still there, untouched.
    expect(syncQueue.added).toHaveLength(1);
    expect(syncQueue.added[0]).toBe(originalJob);
  });
});
