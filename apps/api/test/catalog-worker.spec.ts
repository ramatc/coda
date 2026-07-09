import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@coda/db";
import {
  CATALOG_ALBUM_QUEUE,
  CATALOG_PAGE_QUEUE,
} from "../src/catalog-import/catalog-import.constants.js";
import { ConfigService } from "@nestjs/config";
import { CatalogImportService } from "../src/catalog-import/catalog-import.service.js";
import { CatalogQueue } from "../src/catalog-import/catalog-queue.js";
import { SpotifyClient } from "../src/catalog-import/spotify.client.js";
import { SpotifyCheckpointStore } from "../src/catalog-import/spotify-checkpoint.store.js";
import type { NormalizedAlbum } from "../src/catalog-import/spotify.types.js";

/**
 * `catalog-worker.ts` is a standalone bootstrap script (no exported testable
 * units) that constructs its two BullMQ `Worker`s inline. Rather than
 * refactoring it just to make it testable, this spec mocks `bullmq`'s
 * `Worker` to CAPTURE the processor functions passed to `new Worker(...)`,
 * then invokes them directly against fakes — proving the fan-out/checkpoint/
 * error-isolation behavior without a real Redis/BullMQ connection or a real
 * Nest app (no live infra in the sandbox).
 */

interface FakeJob<T> {
  data: T;
  id?: string;
}

const createBullConnectionMock = vi.fn(() => ({
  quit: vi.fn().mockResolvedValue("OK"),
}));

vi.mock("../src/catalog-import/catalog-redis.js", () => ({
  createBullConnection: (...args: unknown[]) => createBullConnectionMock(...args),
}));

const workerInstances: Array<{
  queueName: string;
  processor: (job: FakeJob<unknown>) => Promise<unknown>;
}> = [];

vi.mock("bullmq", () => {
  class FakeWorker {
    constructor(
      queueName: string,
      processor: (job: FakeJob<unknown>) => Promise<unknown>,
    ) {
      workerInstances.push({ queueName, processor });
    }
    on(): this {
      return this;
    }
    async close(): Promise<void> {}
  }
  return { Worker: FakeWorker };
});

const createApplicationContextMock = vi.fn();
vi.mock("@nestjs/core", () => ({
  NestFactory: { createApplicationContext: createApplicationContextMock },
}));

vi.mock("../src/app.module.js", () => ({ AppModule: class {} }));

function album(spotifyId: string): NormalizedAlbum {
  return {
    spotifyId,
    title: `Album ${spotifyId}`,
    releaseDate: null,
    coverUrl: null,
    trackCount: null,
    popularityScore: 0,
    primaryArtist: { spotifyId: `artist-${spotifyId}`, name: "x", imageUrl: null },
  };
}

describe("catalog-worker bootstrap", () => {
  const fakeSpotify = { getAlbumPage: vi.fn() };
  const fakeService = { upsertAlbum: vi.fn().mockResolvedValue(undefined) };
  const fakeQueue = {
    enqueueAlbums: vi.fn().mockResolvedValue(undefined),
    enqueuePage: vi.fn().mockResolvedValue(undefined),
  };
  const fakeCheckpoint = {
    clear: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    releaseRunningLock: vi.fn().mockResolvedValue(undefined),
  };

  let pageProcessor: (job: FakeJob<{ offset: number; limit: number }>) => Promise<unknown>;
  let albumProcessor: (job: FakeJob<{ album: NormalizedAlbum }>) => Promise<unknown>;
  let connectionCallsDuringBootstrap = 0;

  beforeAll(async () => {
    const providers = new Map<unknown, unknown>();
    providers.set(ConfigService, { get: () => undefined });
    providers.set(SpotifyClient, fakeSpotify);
    providers.set(CatalogImportService, fakeService);
    providers.set(CatalogQueue, fakeQueue);
    providers.set(SpotifyCheckpointStore, fakeCheckpoint);

    const fakeApp = {
      get: (token: unknown) => providers.get(token),
      close: vi.fn().mockResolvedValue(undefined),
    };
    createApplicationContextMock.mockResolvedValue(fakeApp);

    await import("../src/catalog-import/catalog-worker.js");
    // The module's top-level `void bootstrap()` doesn't block import
    // completion; flush the microtask/macrotask queue so bootstrap runs past
    // its single `await NestFactory.createApplicationContext(...)` and
    // registers both Workers before we grab their processors.
    await new Promise((resolve) => setImmediate(resolve));

    connectionCallsDuringBootstrap = createBullConnectionMock.mock.calls.length;
    pageProcessor = workerInstances.find((w) => w.queueName === CATALOG_PAGE_QUEUE)!
      .processor as typeof pageProcessor;
    albumProcessor = workerInstances.find((w) => w.queueName === CATALOG_ALBUM_QUEUE)!
      .processor as typeof albumProcessor;
  });

  beforeEach(() => {
    // Clear call history only (default resolved-value implementations set
    // above are preserved) so assertions on `.toHaveBeenCalledWith` etc. don't
    // see calls from a previous test.
    vi.clearAllMocks();
    fakeService.upsertAlbum.mockResolvedValue(undefined);
    fakeQueue.enqueueAlbums.mockResolvedValue(undefined);
    fakeQueue.enqueuePage.mockResolvedValue(undefined);
    fakeCheckpoint.clear.mockResolvedValue(undefined);
    fakeCheckpoint.set.mockResolvedValue(undefined);
    fakeCheckpoint.releaseRunningLock.mockResolvedValue(undefined);
  });

  it("creates a dedicated Redis connection per Worker instead of sharing one", () => {
    expect(connectionCallsDuringBootstrap).toBe(2);
  });

  it("fans out a page's albums via the bulk enqueue, then enqueues the next page BEFORE advancing the checkpoint", async () => {
    const callOrder: string[] = [];
    fakeQueue.enqueueAlbums.mockImplementation(async () => {
      callOrder.push("enqueueAlbums");
    });
    fakeQueue.enqueuePage.mockImplementation(async () => {
      callOrder.push("enqueuePage");
    });
    fakeCheckpoint.set.mockImplementation(async () => {
      callOrder.push("checkpoint.set");
    });
    const albums = [album("a1"), album("a2")];
    fakeSpotify.getAlbumPage.mockResolvedValue({ albums, nextOffset: 50 });

    const result = await pageProcessor({ data: { offset: 0, limit: 50 } });

    expect(fakeQueue.enqueueAlbums).toHaveBeenCalledWith(albums);
    expect(fakeQueue.enqueuePage).toHaveBeenCalledWith(50, 50);
    expect(callOrder).toEqual(["enqueueAlbums", "enqueuePage", "checkpoint.set"]);
    expect(result).toEqual({ processed: 2, nextOffset: 50 });
  });

  it("clears the checkpoint and releases the running lock on the final page (no next-page enqueue)", async () => {
    fakeSpotify.getAlbumPage.mockResolvedValue({ albums: [], nextOffset: null });

    await pageProcessor({ data: { offset: 950, limit: 50 } });

    expect(fakeCheckpoint.clear).toHaveBeenCalled();
    expect(fakeCheckpoint.releaseRunningLock).toHaveBeenCalled();
    expect(fakeQueue.enqueuePage).not.toHaveBeenCalled();
  });

  it("album worker skips a malformed record (Prisma validation error) instead of failing the job", async () => {
    fakeService.upsertAlbum.mockRejectedValue(
      new Prisma.PrismaClientValidationError("bad shape", { clientVersion: "test" }),
    );

    await expect(
      albumProcessor({ data: { album: album("bad") } }),
    ).resolves.toBeUndefined();
  });

  it("album worker rethrows a systemic error instead of swallowing it", async () => {
    fakeService.upsertAlbum.mockRejectedValue(new Error("connection lost"));

    await expect(
      albumProcessor({ data: { album: album("x") } }),
    ).rejects.toThrow(/connection lost/);
  });
});
