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

class FakeQueue {
  added: FakeAddedJob[] = [];

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
});
