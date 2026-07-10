import { beforeEach, describe, expect, it, vi } from "vitest";
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
    // Mirrors BullMQ's deterministic-jobId dedup: re-adding an already-seen
    // jobId is a no-op that doesn't push a second entry.
    if (opts.jobId && this.added.some((job) => job.opts.jobId === opts.jobId)) {
      return { id: opts.jobId };
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
  const state = { offset: null as number | null };
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
    await queue.enqueueAlbums([album("alb-1")]);

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

  it("enqueueSeed resumes from the checkpoint offset and enqueues the first page", async () => {
    await checkpoint.store.set(100);

    const result = await queue.enqueueSeed(50);

    expect(result.offset).toBe(100);
    const pageQueue = bullmq.__queueRegistry.get(CATALOG_PAGE_QUEUE)!;
    expect(pageQueue.added[0].data).toEqual({ offset: 100, limit: 50 });
  });
});
