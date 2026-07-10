import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { Prisma } from "@coda/db";
import {
  CATALOG_ALBUM_QUEUE,
  CATALOG_ENRICH_QUEUE,
  CATALOG_PAGE_QUEUE,
  MUSICBRAINZ_RATE_LIMIT,
} from "../src/catalog-import/catalog-import.constants.js";
import { ConfigService } from "@nestjs/config";
import { CatalogImportService } from "../src/catalog-import/catalog-import.service.js";
import { CatalogQueue } from "../src/catalog-import/catalog-queue.js";
import { SpotifyClient } from "../src/catalog-import/spotify.client.js";
import { SpotifyCheckpointStore } from "../src/catalog-import/spotify-checkpoint.store.js";
import { MusicBrainzEnrichService } from "../src/catalog-import/musicbrainz-enrich.service.js";
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
  options: { limiter?: { max: number; duration: number } } | undefined;
  handlers: Record<string, (...args: unknown[]) => unknown>;
}> = [];

vi.mock("bullmq", () => {
  class FakeWorker {
    handlers: Record<string, (...args: unknown[]) => unknown> = {};

    constructor(
      queueName: string,
      processor: (job: FakeJob<unknown>) => Promise<unknown>,
      options?: { limiter?: { max: number; duration: number } },
    ) {
      workerInstances.push({
        queueName,
        processor,
        options,
        handlers: this.handlers,
      });
    }
    on(event: string, handler: (...args: unknown[]) => unknown): this {
      this.handlers[event] = handler;
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

/**
 * P2002 built with the REAL `@prisma/adapter-pg` driver-adapter error shape
 * (fields live on `meta.driverAdapterError.cause.constraint.fields`, NOT the
 * classic `meta.target` this client never populates — Decision #14, reused
 * from `profile.service.spec.ts` / `clerk-webhook.service.spec.ts`).
 */
function p2002WithFields(
  message: string,
  fields: string[] | undefined,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code: "P2002",
    clientVersion: "test",
    meta: {
      driverAdapterError: {
        cause: {
          kind: "UniqueConstraintViolation",
          constraint: fields !== undefined ? { fields } : undefined,
        },
      },
    },
  });
}

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
  const fakeEnrichService = {
    enrichAlbum: vi.fn().mockResolvedValue({ status: "enriched" }),
  };
  const fakeQueue = {
    enqueueAlbums: vi.fn().mockResolvedValue(undefined),
    enqueuePage: vi.fn().mockResolvedValue(undefined),
    enqueueEnrichment: vi.fn().mockResolvedValue(undefined),
  };
  const fakeCheckpoint = {
    clear: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  };

  let pageProcessor: (job: FakeJob<{ offset: number; limit: number }>) => Promise<unknown>;
  let albumProcessor: (job: FakeJob<{ album: NormalizedAlbum }>) => Promise<unknown>;
  let enrichProcessor: (job: FakeJob<{ spotifyId: string }>) => Promise<unknown>;
  let enrichWorkerOptions:
    | { limiter?: { max: number; duration: number } }
    | undefined;
  let connectionCallsDuringBootstrap = 0;

  beforeAll(async () => {
    const providers = new Map<unknown, unknown>();
    providers.set(ConfigService, { get: () => undefined });
    providers.set(SpotifyClient, fakeSpotify);
    providers.set(CatalogImportService, fakeService);
    providers.set(MusicBrainzEnrichService, fakeEnrichService);
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
    const enrichWorker = workerInstances.find(
      (w) => w.queueName === CATALOG_ENRICH_QUEUE,
    )!;
    enrichProcessor = enrichWorker.processor as typeof enrichProcessor;
    enrichWorkerOptions = enrichWorker.options;
  });

  beforeEach(() => {
    // Clear call history only (default resolved-value implementations set
    // above are preserved) so assertions on `.toHaveBeenCalledWith` etc. don't
    // see calls from a previous test.
    vi.clearAllMocks();
    fakeService.upsertAlbum.mockResolvedValue(undefined);
    fakeEnrichService.enrichAlbum.mockResolvedValue({ status: "enriched" });
    fakeQueue.enqueueAlbums.mockResolvedValue(undefined);
    fakeQueue.enqueuePage.mockResolvedValue(undefined);
    fakeQueue.enqueueEnrichment.mockResolvedValue(undefined);
    fakeCheckpoint.clear.mockResolvedValue(undefined);
    fakeCheckpoint.set.mockResolvedValue(undefined);
  });

  it("creates a dedicated Redis connection per Worker instead of sharing one", () => {
    // page + album + enrich = 3 dedicated connections.
    expect(connectionCallsDuringBootstrap).toBe(3);
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

    const result = await pageProcessor({
      data: { offset: 0, limit: 50 },
    });

    expect(fakeQueue.enqueueAlbums).toHaveBeenCalledWith(albums);
    expect(fakeQueue.enqueuePage).toHaveBeenCalledWith(50, 50);
    expect(callOrder).toEqual(["enqueueAlbums", "enqueuePage", "checkpoint.set"]);
    expect(result).toEqual({ processed: 2, nextOffset: 50 });
  });

  it("uses an explicit `limit: 0` as-is instead of falling back to the default (judgment-day issue #11)", async () => {
    fakeSpotify.getAlbumPage.mockResolvedValue({ albums: [], nextOffset: null });

    await pageProcessor({ data: { offset: 0, limit: 0 } });

    // `??`, not `||`: an explicit 0 must NOT be silently replaced.
    expect(fakeSpotify.getAlbumPage).toHaveBeenCalledWith(0, 0);
  });

  it("clears the checkpoint on the final page (no next-page enqueue)", async () => {
    fakeSpotify.getAlbumPage.mockResolvedValue({ albums: [], nextOffset: null });

    await pageProcessor({ data: { offset: 950, limit: 50 } });

    expect(fakeCheckpoint.clear).toHaveBeenCalled();
    expect(fakeQueue.enqueuePage).not.toHaveBeenCalled();
  });

  it("album worker chains MusicBrainz enrichment after a successful upsert (PR6)", async () => {
    await albumProcessor({ data: { album: album("a1") } });

    expect(fakeService.upsertAlbum).toHaveBeenCalledTimes(1);
    expect(fakeQueue.enqueueEnrichment).toHaveBeenCalledWith("a1");
  });

  it("album worker skips a malformed record (Prisma validation error) instead of failing the job", async () => {
    fakeService.upsertAlbum.mockRejectedValue(
      new Prisma.PrismaClientValidationError("bad shape", { clientVersion: "test" }),
    );

    await expect(
      albumProcessor({ data: { album: album("bad") } }),
    ).resolves.toBeUndefined();
    // A skipped album must NOT be chained into enrichment.
    expect(fakeQueue.enqueueEnrichment).not.toHaveBeenCalled();
  });

  it("album worker skips a P2002 unique-constraint conflict instead of failing the job (judgment-day issue #7)", async () => {
    fakeService.upsertAlbum.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    await expect(
      albumProcessor({ data: { album: album("dup") } }),
    ).resolves.toBeUndefined();
  });

  it("album worker skips a P2003 foreign-key violation instead of failing the job (judgment-day issue #7)", async () => {
    fakeService.upsertAlbum.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("fk violation", {
        code: "P2003",
        clientVersion: "test",
      }),
    );

    await expect(
      albumProcessor({ data: { album: album("orphan") } }),
    ).resolves.toBeUndefined();
  });

  it("album worker propagates an enqueueEnrichment failure UNCAUGHT so BullMQ's own retry/backoff and failed-job set apply — intentional asymmetry vs the CLI path (judgment-day issue #1, round 3)", async () => {
    fakeQueue.enqueueEnrichment.mockRejectedValue(
      new Error("simulated Redis/BullMQ producer failure"),
    );

    await expect(
      albumProcessor({ data: { album: album("a1") } }),
    ).rejects.toThrow(/simulated Redis\/BullMQ producer failure/);

    // The upsert itself succeeded before the enqueue failed.
    expect(fakeService.upsertAlbum).toHaveBeenCalledTimes(1);
  });

  it("album worker rethrows a systemic error instead of swallowing it", async () => {
    fakeService.upsertAlbum.mockRejectedValue(new Error("connection lost"));

    await expect(
      albumProcessor({ data: { album: album("x") } }),
    ).rejects.toThrow(/connection lost/);
  });

  it("configures the enrich Worker with the ≤1 req/s BullMQ limiter (queue-level half of the rate guard)", () => {
    expect(enrichWorkerOptions?.limiter).toEqual(MUSICBRAINZ_RATE_LIMIT);
    expect(MUSICBRAINZ_RATE_LIMIT).toEqual({ max: 1, duration: 1100 });
  });

  it("enrich worker delegates to the enrich service by spotify id", async () => {
    await enrichProcessor({ data: { spotifyId: "sp1" } });

    expect(fakeEnrichService.enrichAlbum).toHaveBeenCalledWith("sp1");
  });

  it("enrich worker skips a P2002 on mbid, logging the mbid-specific Album/Artist message", async () => {
    const warnSpy = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    fakeEnrichService.enrichAlbum.mockRejectedValue(
      p2002WithFields("mbid taken", ["mbid"]),
    );

    await expect(
      enrichProcessor({ data: { spotifyId: "dup" } }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'due to a unique constraint conflict on "mbid" — mbid already claimed by another Album OR Artist row',
      ),
    );

    warnSpy.mockRestore();
  });

  // judgment-day issue #2, round 2: the enrichment transaction also upserts
  // `Genre.slug` and the `AlbumGenre` composite unique key — a P2002 on either
  // must NOT be reported with the mbid-specific narrative.
  it("enrich worker skips a P2002 on a non-mbid field (e.g. genre slug), logging the generic message", async () => {
    const warnSpy = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    fakeEnrichService.enrichAlbum.mockRejectedValue(
      p2002WithFields("slug taken", ["slug"]),
    );

    await expect(
      enrichProcessor({ data: { spotifyId: "genre-collision" } }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('due to a unique constraint conflict on field "slug"'),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("mbid"));

    warnSpy.mockRestore();
  });

  it("enrich worker rethrows a systemic error so BullMQ retry/backoff applies", async () => {
    fakeEnrichService.enrichAlbum.mockRejectedValue(
      new Error("musicbrainz unreachable"),
    );

    await expect(
      enrichProcessor({ data: { spotifyId: "sp1" } }),
    ).rejects.toThrow(/musicbrainz unreachable/);
  });
});
