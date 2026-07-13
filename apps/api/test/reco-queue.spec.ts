import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "@nestjs/config";
import {
  RECO_DEBOUNCE_MS,
  RECO_GENERATION_JOB_NAME,
  RECO_GENERATION_QUEUE,
  recoGenerationJobId,
} from "../src/recommendations/recommendations.constants.js";

// No live Redis/BullMQ in the sandbox: stub the connection factory and the
// `Queue` class, matching search-queue.spec.ts.
vi.mock("../src/catalog-import/catalog-redis.js", () => ({
  createBullProducerConnection: () => ({ quit: vi.fn().mockResolvedValue("OK") }),
}));

interface FakeAddedJob {
  name: string;
  data: unknown;
  opts: {
    jobId?: string;
    delay?: number;
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

const { RecoQueue } = await import("../src/recommendations/reco.queue.js");

function fakeConfig(): ConfigService {
  return { get: () => undefined } as unknown as ConfigService;
}

describe("RecoQueue", () => {
  let queue: InstanceType<typeof RecoQueue>;

  beforeEach(() => {
    registry.clear();
    queue = new RecoQueue(fakeConfig());
  });

  describe("enqueueGeneration (immediate, onboarding trigger)", () => {
    it("enqueues an immediate generation job with the deterministic job id and a retry/cleanup policy", async () => {
      await queue.enqueueGeneration("user-1");

      const recoQueue = registry.get(RECO_GENERATION_QUEUE)!;
      expect(recoQueue.added).toHaveLength(1);
      const job = recoQueue.added[0];
      expect(job.name).toBe(RECO_GENERATION_JOB_NAME);
      expect(job.data).toEqual({ userId: "user-1" });
      expect(job.opts.jobId).toBe(recoGenerationJobId("user-1"));
      expect(job.opts.attempts).toBeGreaterThan(1);
      expect(job.opts.backoff).toBeDefined();
      expect(job.opts.delay).toBeUndefined();
    });

    it("dedupes re-enqueuing generation for the same user (deterministic jobId no-op)", async () => {
      await queue.enqueueGeneration("user-1");
      await queue.enqueueGeneration("user-1");

      const recoQueue = registry.get(RECO_GENERATION_QUEUE)!;
      expect(recoQueue.added).toHaveLength(1);
    });

    // judgment-day fix (round 2): BullMQ's `Queue.add()` silently no-ops if a
    // job with the same deterministic id already exists in ANY state,
    // including `failed`. Without removing a failed job first, a user whose
    // generation exhausted its retries could never be regenerated again.
    it("removes a pre-existing FAILED job before re-adding, so a retries-exhausted user can regenerate", async () => {
      await queue.enqueueGeneration("user-1");

      const recoQueue = registry.get(RECO_GENERATION_QUEUE)!;
      recoQueue.failedJobIds.add(recoGenerationJobId("user-1"));

      await queue.enqueueGeneration("user-1");

      // The stale failed job was removed and a fresh one was added in its
      // place — still exactly one entry, but it's a genuinely NEW job.
      expect(recoQueue.added).toHaveLength(1);
      expect(recoQueue.added[0].opts.jobId).toBe(recoGenerationJobId("user-1"));
    });

    it("removes a pre-existing COMPLETED job before re-adding", async () => {
      await queue.enqueueGeneration("user-1");

      const recoQueue = registry.get(RECO_GENERATION_QUEUE)!;
      recoQueue.completedJobIds.add(recoGenerationJobId("user-1"));

      await queue.enqueueGeneration("user-1");

      expect(recoQueue.added).toHaveLength(1);
      expect(recoQueue.added[0].opts.jobId).toBe(recoGenerationJobId("user-1"));
    });

    it("does not remove the queue's existing job when it is still in flight (active/waiting/delayed)", async () => {
      await queue.enqueueGeneration("user-1");
      const recoQueue = registry.get(RECO_GENERATION_QUEUE)!;
      const originalJob = recoQueue.added[0];
      const removeSpy = vi.spyOn(FakeJobHandle.prototype, "remove");

      // Neither failed nor completed => still in flight; `remove()` must not
      // be called.
      await queue.enqueueGeneration("user-1");

      expect(removeSpy).not.toHaveBeenCalled();
      expect(recoQueue.added).toHaveLength(1);
      expect(recoQueue.added[0]).toBe(originalJob);

      removeSpy.mockRestore();
    });

    it("swallows a 'locked by another worker' error from remove() instead of throwing", async () => {
      await queue.enqueueGeneration("user-1");

      const recoQueue = registry.get(RECO_GENERATION_QUEUE)!;
      const jobId = recoGenerationJobId("user-1");
      recoQueue.completedJobIds.add(jobId);
      recoQueue.lockedJobIds.add(jobId);
      const originalJob = recoQueue.added[0];

      await expect(queue.enqueueGeneration("user-1")).resolves.toBeUndefined();

      expect(recoQueue.added).toHaveLength(1);
      expect(recoQueue.added[0]).toBe(originalJob);
    });

    it("rethrows a non-lock error from remove() instead of swallowing it", async () => {
      await queue.enqueueGeneration("user-1");

      const recoQueue = registry.get(RECO_GENERATION_QUEUE)!;
      const jobId = recoGenerationJobId("user-1");
      recoQueue.completedJobIds.add(jobId);
      recoQueue.removeErrors.set(jobId, new Error("ECONNRESET"));
      const originalJob = recoQueue.added[0];

      await expect(queue.enqueueGeneration("user-1")).rejects.toThrow(
        "ECONNRESET",
      );

      expect(recoQueue.added).toHaveLength(1);
      expect(recoQueue.added[0]).toBe(originalJob);
    });
  });

  describe("enqueueDebouncedGeneration (delayed, tracking trigger)", () => {
    it("enqueues a delayed generation job with the deterministic job id", async () => {
      await queue.enqueueDebouncedGeneration("user-1");

      const recoQueue = registry.get(RECO_GENERATION_QUEUE)!;
      expect(recoQueue.added).toHaveLength(1);
      const job = recoQueue.added[0];
      expect(job.opts.jobId).toBe(recoGenerationJobId("user-1"));
      expect(job.opts.delay).toBe(RECO_DEBOUNCE_MS);
    });

    it("dedupes a burst of debounced enqueues for the same user (the queue-level debounce)", async () => {
      await queue.enqueueDebouncedGeneration("user-1");
      await queue.enqueueDebouncedGeneration("user-1");

      const recoQueue = registry.get(RECO_GENERATION_QUEUE)!;
      expect(recoQueue.added).toHaveLength(1);
    });

    // judgment-day fix (round 2): same dedup bug as the immediate path — a
    // failed debounced job must not silently swallow the next tracking event.
    it("removes a pre-existing FAILED job before re-adding a debounced generation", async () => {
      await queue.enqueueDebouncedGeneration("user-1");

      const recoQueue = registry.get(RECO_GENERATION_QUEUE)!;
      recoQueue.failedJobIds.add(recoGenerationJobId("user-1"));

      await queue.enqueueDebouncedGeneration("user-1");

      expect(recoQueue.added).toHaveLength(1);
      expect(recoQueue.added[0].opts.jobId).toBe(recoGenerationJobId("user-1"));
      expect(recoQueue.added[0].opts.delay).toBe(RECO_DEBOUNCE_MS);
    });

    it("removes a pre-existing COMPLETED job before re-adding a debounced generation", async () => {
      await queue.enqueueDebouncedGeneration("user-1");

      const recoQueue = registry.get(RECO_GENERATION_QUEUE)!;
      recoQueue.completedJobIds.add(recoGenerationJobId("user-1"));

      await queue.enqueueDebouncedGeneration("user-1");

      expect(recoQueue.added).toHaveLength(1);
      expect(recoQueue.added[0].opts.jobId).toBe(recoGenerationJobId("user-1"));
    });

    it("does not remove an in-flight debounced job", async () => {
      await queue.enqueueDebouncedGeneration("user-1");
      const recoQueue = registry.get(RECO_GENERATION_QUEUE)!;
      const originalJob = recoQueue.added[0];
      const removeSpy = vi.spyOn(FakeJobHandle.prototype, "remove");

      await queue.enqueueDebouncedGeneration("user-1");

      expect(removeSpy).not.toHaveBeenCalled();
      expect(recoQueue.added[0]).toBe(originalJob);

      removeSpy.mockRestore();
    });

    it("swallows a 'locked by another worker' error for the debounced path", async () => {
      await queue.enqueueDebouncedGeneration("user-1");

      const recoQueue = registry.get(RECO_GENERATION_QUEUE)!;
      const jobId = recoGenerationJobId("user-1");
      recoQueue.completedJobIds.add(jobId);
      recoQueue.lockedJobIds.add(jobId);
      const originalJob = recoQueue.added[0];

      await expect(
        queue.enqueueDebouncedGeneration("user-1"),
      ).resolves.toBeUndefined();

      expect(recoQueue.added).toHaveLength(1);
      expect(recoQueue.added[0]).toBe(originalJob);
    });

    it("rethrows a non-lock error for the debounced path instead of swallowing it", async () => {
      await queue.enqueueDebouncedGeneration("user-1");

      const recoQueue = registry.get(RECO_GENERATION_QUEUE)!;
      const jobId = recoGenerationJobId("user-1");
      recoQueue.completedJobIds.add(jobId);
      recoQueue.removeErrors.set(jobId, new Error("ECONNRESET"));
      const originalJob = recoQueue.added[0];

      await expect(
        queue.enqueueDebouncedGeneration("user-1"),
      ).rejects.toThrow("ECONNRESET");

      expect(recoQueue.added).toHaveLength(1);
      expect(recoQueue.added[0]).toBe(originalJob);
    });
  });
});
