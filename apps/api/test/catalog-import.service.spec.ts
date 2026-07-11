import { beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { Prisma } from "@coda/db";
import { CatalogImportService } from "../src/catalog-import/catalog-import.service.js";
import {
  albumJobId,
  pageJobId,
} from "../src/catalog-import/catalog-import.constants.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";
import type { SpotifyClient } from "../src/catalog-import/spotify.client.js";
import type { SpotifyCheckpointStore } from "../src/catalog-import/spotify-checkpoint.store.js";
import type { CatalogQueue } from "../src/catalog-import/catalog-queue.js";
import type {
  NormalizedAlbum,
  NormalizedAlbumPage,
} from "../src/catalog-import/spotify.types.js";

/**
 * In-memory Prisma stand-in honouring the exact `upsert` shapes
 * {@link CatalogImportService.upsertAlbum} uses, keyed on the unique `spotifyId`
 * — so idempotency (re-run ⇒ update, not insert) is proven deterministically
 * without a live Postgres, matching the PR1-4 fake-Prisma convention. Separate
 * create/update counters let a test PROVE no duplicate rows were inserted, not
 * just that the final map size looks right.
 */
function createFakeCatalogPrisma() {
  const artists = new Map<string, { id: string; name: string }>();
  const albums = new Map<string, { id: string; primaryArtistId: string }>();
  let artistSeq = 0;
  let albumSeq = 0;
  let artistCreates = 0;
  let artistUpdates = 0;
  let albumCreates = 0;
  let albumUpdates = 0;

  const client = {
    async $transaction<T>(fn: (tx: typeof client) => Promise<T>): Promise<T> {
      return fn(client);
    },
    artist: {
      async upsert(args: {
        where: { spotifyId: string };
        create: { spotifyId: string; name: string };
        update: { name: string };
      }): Promise<{ id: string }> {
        const existing = artists.get(args.where.spotifyId);
        if (existing) {
          artistUpdates += 1;
          existing.name = args.update.name;
          return { id: existing.id };
        }
        artistCreates += 1;
        const row = { id: `artist_${++artistSeq}`, name: args.create.name };
        artists.set(args.where.spotifyId, row);
        return { id: row.id };
      },
    },
    album: {
      async upsert(args: {
        where: { spotifyId: string };
        create: { primaryArtist: { connect: { id: string } } };
      }): Promise<{ id: string }> {
        const existing = albums.get(args.where.spotifyId);
        if (existing) {
          albumUpdates += 1;
          return { id: existing.id };
        }
        albumCreates += 1;
        const row = {
          id: `album_${++albumSeq}`,
          primaryArtistId: args.create.primaryArtist.connect.id,
        };
        albums.set(args.where.spotifyId, row);
        return { id: row.id };
      },
    },
  };

  return {
    service: { client } as unknown as PrismaService,
    artists,
    albums,
    counts: () => ({ artistCreates, artistUpdates, albumCreates, albumUpdates }),
  };
}

/** Paginated fake Spotify source; can simulate a one-shot crash at an offset. */
function createFakeSpotify(
  catalog: NormalizedAlbum[],
  pageSize: number,
  opts: { throwOnceAtOffset?: number } = {},
) {
  let thrown = false;
  const client = {
    async getAlbumPage(
      offset: number,
      _limit: number,
    ): Promise<NormalizedAlbumPage> {
      if (opts.throwOnceAtOffset === offset && !thrown) {
        thrown = true;
        throw new Error("simulated Spotify/network crash");
      }
      const albums = catalog.slice(offset, offset + pageSize);
      const end = offset + pageSize;
      const nextOffset = end >= catalog.length ? null : end;
      return { albums, nextOffset };
    },
  };
  return client as unknown as SpotifyClient;
}

/** In-memory checkpoint store implementing the resume-cursor contract. */
function createFakeCheckpoint() {
  const state = { value: null as number | null };
  const store: SpotifyCheckpointStore = {
    async get() {
      return state.value;
    },
    async set(offset: number) {
      state.value = offset;
    },
    async clear() {
      state.value = null;
    },
  } as unknown as SpotifyCheckpointStore;
  return { store, state };
}

/** Fake `CatalogQueue` stand-in exposing only what `importPage` calls. */
function createFakeQueue() {
  const enqueueEnrichment = vi.fn().mockResolvedValue(undefined);
  return {
    queue: { enqueueEnrichment } as unknown as CatalogQueue,
    enqueueEnrichment,
  };
}

function album(spotifyId: string, artistSpotifyId: string): NormalizedAlbum {
  return {
    spotifyId,
    title: `Album ${spotifyId}`,
    releaseDate: "2020-01-01",
    coverUrl: null,
    trackCount: 10,
    popularityScore: 50,
    primaryArtist: {
      spotifyId: artistSpotifyId,
      name: `Artist ${artistSpotifyId}`,
      imageUrl: null,
    },
  };
}

describe("CatalogImportService", () => {
  // 5 albums; alb-0 and alb-1 share artist a-1 → 4 distinct artists total.
  const catalog: NormalizedAlbum[] = [
    album("alb-0", "a-1"),
    album("alb-1", "a-1"),
    album("alb-2", "a-2"),
    album("alb-3", "a-3"),
    album("alb-4", "a-4"),
  ];

  let fakePrisma: ReturnType<typeof createFakeCatalogPrisma>;

  beforeEach(() => {
    fakePrisma = createFakeCatalogPrisma();
  });

  it("upserts an album idempotently by spotifyId (second call updates, never inserts a duplicate)", async () => {
    const service = new CatalogImportService(
      fakePrisma.service,
      createFakeSpotify(catalog, 2),
      createFakeCheckpoint().store,
    );

    await service.upsertAlbum(catalog[0]);
    await service.upsertAlbum(catalog[0]);

    expect(fakePrisma.albums.size).toBe(1);
    expect(fakePrisma.artists.size).toBe(1);
    expect(fakePrisma.counts().albumCreates).toBe(1);
    expect(fakePrisma.counts().albumUpdates).toBe(1);
  });

  it("resumes an interrupted import from its checkpoint with no duplicate Album/Artist rows", async () => {
    const checkpoint = createFakeCheckpoint();

    // First run crashes when it reaches page offset 2 (after page 0 is done and
    // the checkpoint has advanced to offset 2).
    const crashingService = new CatalogImportService(
      fakePrisma.service,
      createFakeSpotify(catalog, 2, { throwOnceAtOffset: 2 }),
      checkpoint.store,
    );
    await expect(crashingService.runImport()).rejects.toThrow(
      /simulated Spotify/,
    );

    // Page 0 (2 albums) persisted; cursor parked at offset 2 for the resume.
    expect(checkpoint.state.value).toBe(2);
    expect(fakePrisma.albums.size).toBe(2);

    // Resume: a fresh (non-crashing) client, SAME fake DB + checkpoint. It must
    // pick up at offset 2, finish pages 2 and 4, and clear the cursor.
    const resumedService = new CatalogImportService(
      fakePrisma.service,
      createFakeSpotify(catalog, 2),
      checkpoint.store,
    );
    const result = await resumedService.runImport();

    expect(result.processed).toBe(3); // only the remaining 3 albums re-fetched
    expect(checkpoint.state.value).toBeNull(); // cleared on clean completion
    // Whole catalog present exactly once — no duplicates despite the crash.
    expect(fakePrisma.albums.size).toBe(5);
    expect(fakePrisma.artists.size).toBe(4);
    // Every row was INSERTED exactly once across both runs (no double-insert).
    expect(fakePrisma.counts().albumCreates).toBe(5);
    expect(fakePrisma.counts().albumUpdates).toBe(0);
    expect(fakePrisma.counts().artistCreates).toBe(4);
  });

  it("a full re-seed over an already-imported catalog inserts nothing new (idempotent upsert)", async () => {
    const service = new CatalogImportService(
      fakePrisma.service,
      createFakeSpotify(catalog, 2),
      createFakeCheckpoint().store,
    );

    await service.runImport({ startOffset: 0 });
    expect(fakePrisma.counts().albumCreates).toBe(5);

    // Re-run from scratch: same spotifyIds ⇒ all upserts take the update path.
    await service.runImport({ startOffset: 0 });
    expect(fakePrisma.albums.size).toBe(5);
    expect(fakePrisma.artists.size).toBe(4);
    expect(fakePrisma.counts().albumCreates).toBe(5); // unchanged — no new rows
    expect(fakePrisma.counts().albumUpdates).toBe(5); // second pass updated each
  });

  it("importPage skips a P2002 unique-constraint conflict on a single album instead of aborting the whole page (judgment-day issue #7)", async () => {
    const [okAlbum, conflictingAlbum] = catalog;
    const client = {
      async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(client);
      },
      artist: {
        async upsert() {
          return { id: "artist-1" };
        },
      },
      album: {
        async upsert(args: { where: { spotifyId: string } }) {
          if (args.where.spotifyId === conflictingAlbum.spotifyId) {
            throw new Prisma.PrismaClientKnownRequestError("duplicate", {
              code: "P2002",
              clientVersion: "test",
            });
          }
          return { id: `album-${args.where.spotifyId}` };
        },
      },
    };
    const prisma = { client } as unknown as PrismaService;
    const spotify: SpotifyClient = {
      async getAlbumPage(): Promise<NormalizedAlbumPage> {
        return { albums: [okAlbum, conflictingAlbum], nextOffset: null };
      },
    } as unknown as SpotifyClient;

    const service = new CatalogImportService(
      prisma,
      spotify,
      createFakeCheckpoint().store,
    );

    const result = await service.importPage(0, 2);

    expect(result).toEqual({
      processed: 2,
      nextOffset: null,
      enqueueAttempts: 0,
      enqueueFailures: 0,
    });
  });

  it("importPage skips a P2003 foreign-key violation on a single album instead of aborting the whole page (judgment-day issue #7)", async () => {
    const [okAlbum, orphanAlbum] = catalog;
    const client = {
      async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(client);
      },
      artist: {
        async upsert() {
          return { id: "artist-1" };
        },
      },
      album: {
        async upsert(args: { where: { spotifyId: string } }) {
          if (args.where.spotifyId === orphanAlbum.spotifyId) {
            throw new Prisma.PrismaClientKnownRequestError("fk violation", {
              code: "P2003",
              clientVersion: "test",
            });
          }
          return { id: `album-${args.where.spotifyId}` };
        },
      },
    };
    const prisma = { client } as unknown as PrismaService;
    const spotify: SpotifyClient = {
      async getAlbumPage(): Promise<NormalizedAlbumPage> {
        return { albums: [okAlbum, orphanAlbum], nextOffset: null };
      },
    } as unknown as SpotifyClient;

    const service = new CatalogImportService(
      prisma,
      spotify,
      createFakeCheckpoint().store,
    );

    const result = await service.importPage(0, 2);

    expect(result).toEqual({
      processed: 2,
      nextOffset: null,
      enqueueAttempts: 0,
      enqueueFailures: 0,
    });
  });

  it("chains MusicBrainz enrichment after each successfully-upserted album on the CLI/in-process path (judgment-day issue #1)", async () => {
    const fakeQueue = createFakeQueue();
    const service = new CatalogImportService(
      fakePrisma.service,
      createFakeSpotify(catalog, 2),
      createFakeCheckpoint().store,
      fakeQueue.queue,
    );

    const result = await service.importPage(0, 2);

    expect(result).toEqual({
      processed: 2,
      nextOffset: 2,
      enqueueAttempts: 2,
      enqueueFailures: 0,
    });
    expect(fakeQueue.enqueueEnrichment).toHaveBeenCalledTimes(2);
    expect(fakeQueue.enqueueEnrichment).toHaveBeenNthCalledWith(1, "alb-0");
    expect(fakeQueue.enqueueEnrichment).toHaveBeenNthCalledWith(2, "alb-1");
  });

  it("does not chain enrichment for an album that was skipped due to a conflict (judgment-day issue #1)", async () => {
    const [okAlbum, conflictingAlbum] = catalog;
    const fakeQueue = createFakeQueue();
    const client = {
      async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(client);
      },
      artist: {
        async upsert() {
          return { id: "artist-1" };
        },
      },
      album: {
        async upsert(args: { where: { spotifyId: string } }) {
          if (args.where.spotifyId === conflictingAlbum.spotifyId) {
            throw new Prisma.PrismaClientKnownRequestError("duplicate", {
              code: "P2002",
              clientVersion: "test",
            });
          }
          return { id: `album-${args.where.spotifyId}` };
        },
      },
    };
    const prisma = { client } as unknown as PrismaService;
    const spotify: SpotifyClient = {
      async getAlbumPage(): Promise<NormalizedAlbumPage> {
        return { albums: [okAlbum, conflictingAlbum], nextOffset: null };
      },
    } as unknown as SpotifyClient;

    const service = new CatalogImportService(
      prisma,
      spotify,
      createFakeCheckpoint().store,
      fakeQueue.queue,
    );

    await service.importPage(0, 2);

    expect(fakeQueue.enqueueEnrichment).toHaveBeenCalledTimes(1);
    expect(fakeQueue.enqueueEnrichment).toHaveBeenCalledWith(okAlbum.spotifyId);
  });

  it("does not count an album skipped at the upsert stage toward enqueueAttempts when a queue is injected (judgment-day issue #1, round 5)", async () => {
    const [okAlbum, conflictingAlbum, otherOkAlbum] = catalog;
    const fakeQueue = createFakeQueue();
    const client = {
      async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(client);
      },
      artist: {
        async upsert() {
          return { id: "artist-1" };
        },
      },
      album: {
        async upsert(args: { where: { spotifyId: string } }) {
          if (args.where.spotifyId === conflictingAlbum.spotifyId) {
            throw new Prisma.PrismaClientKnownRequestError("duplicate", {
              code: "P2002",
              clientVersion: "test",
            });
          }
          return { id: `album-${args.where.spotifyId}` };
        },
      },
    };
    const prisma = { client } as unknown as PrismaService;
    const spotify: SpotifyClient = {
      async getAlbumPage(): Promise<NormalizedAlbumPage> {
        return {
          albums: [okAlbum, conflictingAlbum, otherOkAlbum],
          nextOffset: null,
        };
      },
    } as unknown as SpotifyClient;

    const service = new CatalogImportService(
      prisma,
      spotify,
      createFakeCheckpoint().store,
      fakeQueue.queue,
    );

    const result = await service.importPage(0, 3);

    // 3 albums processed, but only the 2 that survived the upsert stage
    // reach the enqueue attempt — the skipped conflict must not inflate
    // enqueueAttempts (nor count as an enqueueFailure).
    expect(result).toEqual({
      processed: 3,
      nextOffset: null,
      enqueueAttempts: 2,
      enqueueFailures: 0,
    });
    expect(fakeQueue.enqueueEnrichment).toHaveBeenCalledTimes(2);
    expect(fakeQueue.enqueueEnrichment).toHaveBeenNthCalledWith(
      1,
      okAlbum.spotifyId,
    );
    expect(fakeQueue.enqueueEnrichment).toHaveBeenNthCalledWith(
      2,
      otherOkAlbum.spotifyId,
    );
  });

  it("does not abort the run when enqueueEnrichment fails for an album — logs and continues (judgment-day issue #1, round 2)", async () => {
    const fakeQueue = createFakeQueue();
    fakeQueue.enqueueEnrichment
      .mockRejectedValueOnce(new Error("simulated Redis/BullMQ producer failure"))
      .mockResolvedValue(undefined);
    const service = new CatalogImportService(
      fakePrisma.service,
      createFakeSpotify(catalog, 2),
      createFakeCheckpoint().store,
      fakeQueue.queue,
    );

    // Page 0 (alb-0, alb-1): enqueue fails for alb-0 but the page must still
    // report both albums processed and proceed to enqueue alb-1.
    const result = await service.importPage(0, 2);

    expect(result).toEqual({
      processed: 2,
      nextOffset: 2,
      enqueueAttempts: 2,
      enqueueFailures: 1,
    });
    expect(fakeQueue.enqueueEnrichment).toHaveBeenCalledTimes(2);
    expect(fakeQueue.enqueueEnrichment).toHaveBeenNthCalledWith(1, "alb-0");
    expect(fakeQueue.enqueueEnrichment).toHaveBeenNthCalledWith(2, "alb-1");
    // Both albums still persisted despite the queue failure on the first.
    expect(fakePrisma.albums.size).toBe(2);
  });

  it("logs the run summary at WARN when the run had any enrichment enqueue failures (simplified from the escalation heuristic — Fase 1 MVP scope)", async () => {
    const warnSpy = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    const logSpy = vi
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);
    const fakeQueue = createFakeQueue();
    fakeQueue.enqueueEnrichment
      .mockRejectedValueOnce(new Error("simulated one-off Redis blip"))
      .mockResolvedValue(undefined);
    const service = new CatalogImportService(
      fakePrisma.service,
      createFakeSpotify(catalog, 2),
      createFakeCheckpoint().store,
      fakeQueue.queue,
    );

    const result = await service.runImport();

    expect(result.processed).toBe(5);
    expect(result.enqueueFailures).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 enrichment enqueue failures"),
    );
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("enrichment enqueue failures"),
    );

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("logs the run summary at the normal log level when there are zero enrichment enqueue failures", async () => {
    const warnSpy = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    const logSpy = vi
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);
    const fakeQueue = createFakeQueue();
    const service = new CatalogImportService(
      fakePrisma.service,
      createFakeSpotify(catalog, 2),
      createFakeCheckpoint().store,
      fakeQueue.queue,
    );

    const result = await service.runImport();

    expect(result.enqueueFailures).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("0 enrichment enqueue failures"),
    );
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("skips enrichment chaining entirely when no queue is injected (backward compatible)", async () => {
    const service = new CatalogImportService(
      fakePrisma.service,
      createFakeSpotify(catalog, 2),
      createFakeCheckpoint().store,
    );

    await expect(service.importPage(0, 2)).resolves.toEqual({
      processed: 2,
      nextOffset: 2,
      enqueueAttempts: 0,
      enqueueFailures: 0,
    });
  });

  it("derives deterministic, dedup-safe job ids for pages and albums", () => {
    // The queue-level natural-dedup guarantee (Decision #5) rides on these being
    // a pure function of the offset / spotifyId.
    expect(pageJobId(100)).toBe("spotify-page:100");
    expect(albumJobId("alb-0")).toBe("album:alb-0");
    expect(albumJobId("alb-0")).toBe(albumJobId(catalog[0].spotifyId));
  });
});
