import { beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@coda/db";
import { CatalogImportService } from "../src/catalog-import/catalog-import.service.js";
import {
  albumJobId,
  pageJobId,
} from "../src/catalog-import/catalog-import.constants.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";
import type { SpotifyClient } from "../src/catalog-import/spotify.client.js";
import type { SpotifyCheckpointStore } from "../src/catalog-import/spotify-checkpoint.store.js";
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

/**
 * In-memory checkpoint store that DOES implement the running-lock guard
 * (judgment-day issue #3, Round 3): every `createFakeCheckpoint()` fake above
 * omits `lockSupport`, so `runImport()`'s real lock-acquire/release logic was
 * never exercised by a test — only proven by code reading. This fake tracks
 * every acquire/release call and the token passed, so a test can assert
 * `runImport()` releases the SAME token it acquired, on both the success and
 * the throwing path.
 */
function createFakeCheckpointWithLock() {
  const state = { value: null as number | null, lockToken: null as string | null };
  const calls = {
    acquired: 0,
    released: [] as string[],
  };
  let tokenSeq = 0;
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
    lockSupport: {
      async tryAcquireRunningLock() {
        calls.acquired += 1;
        if (state.lockToken !== null) {
          return null;
        }
        state.lockToken = `fake-token-${++tokenSeq}`;
        return state.lockToken;
      },
      async releaseRunningLock(token: string) {
        calls.released.push(token);
        if (state.lockToken === token) {
          state.lockToken = null;
          return true;
        }
        return false;
      },
    },
  } as unknown as SpotifyCheckpointStore;
  return { store, state, calls };
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

    expect(result).toEqual({ processed: 2, nextOffset: null });
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

    expect(result).toEqual({ processed: 2, nextOffset: null });
  });

  describe("runImport's running-lock thread-through (judgment-day issue #3, Round 3)", () => {
    it("acquires the lock, does the work, and releases it with the SAME token on the success path", async () => {
      const checkpoint = createFakeCheckpointWithLock();
      const service = new CatalogImportService(
        fakePrisma.service,
        createFakeSpotify(catalog, 2),
        checkpoint.store,
      );

      const result = await service.runImport();

      expect(result.processed).toBe(5);
      expect(checkpoint.calls.acquired).toBe(1);
      expect(checkpoint.calls.released).toHaveLength(1);
      // The lock must be fully released — a subsequent acquire succeeds.
      expect(checkpoint.state.lockToken).toBeNull();
    });

    it("releases the lock with the SAME token acquired even when the import body throws partway through", async () => {
      const checkpoint = createFakeCheckpointWithLock();
      const crashingService = new CatalogImportService(
        fakePrisma.service,
        createFakeSpotify(catalog, 2, { throwOnceAtOffset: 2 }),
        checkpoint.store,
      );

      await expect(crashingService.runImport()).rejects.toThrow(
        /simulated Spotify/,
      );

      expect(checkpoint.calls.acquired).toBe(1);
      expect(checkpoint.calls.released).toHaveLength(1);
      // The lock must be released despite the failure, not leaked for the TTL.
      expect(checkpoint.state.lockToken).toBeNull();
    });

    it("refuses to start a concurrent run while the lock is already held", async () => {
      const checkpoint = createFakeCheckpointWithLock();
      const service = new CatalogImportService(
        fakePrisma.service,
        createFakeSpotify(catalog, 2),
        checkpoint.store,
      );
      await checkpoint.store.lockSupport!.tryAcquireRunningLock();

      await expect(service.runImport()).rejects.toThrow(
        /already in progress/,
      );
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
