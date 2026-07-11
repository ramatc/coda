import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchSyncService } from "../src/search/search-sync.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";
import type { MeiliService } from "../src/search/meili.service.js";
import type {
  AlbumSearchDocument,
  ArtistSearchDocument,
} from "../src/search/search-document.js";

/**
 * `SearchSyncService` is the queue-agnostic Meilisearch write-through core. These
 * tests run it against a fake Prisma (a small in-memory catalog) and a fake
 * Meilisearch that actually STORES indexed documents and can search them by
 * title — so task 7.6 ("an imported album is retrievable by title after the sync
 * step runs") is proven end-to-end at unit scale, exactly like PR6's enrich test
 * proved enrichment against fakes.
 */

interface DbAlbum {
  id: string;
  spotifyId: string | null;
  mbid: string | null;
  title: string;
  releaseDate: Date | null;
  coverUrl: string | null;
  popularityScore: number;
  primaryArtist: {
    id: string;
    spotifyId: string | null;
    mbid: string | null;
    name: string;
    imageUrl: string | null;
  };
  genres: { genre: { slug: string; name: string } }[];
}

/** In-memory Meilisearch double: stores docs and searches album titles. */
class FakeMeili {
  albums = new Map<string, AlbumSearchDocument>();
  artists = new Map<string, ArtistSearchDocument>();
  configured = false;
  cleared = false;

  configureIndexes = vi.fn(async () => {
    this.configured = true;
  });
  clearIndexes = vi.fn(async () => {
    this.cleared = true;
    this.albums.clear();
    this.artists.clear();
  });
  indexAlbums = vi.fn(async (docs: AlbumSearchDocument[]) => {
    for (const doc of docs) this.albums.set(doc.id, doc);
  });
  indexArtists = vi.fn(async (docs: ArtistSearchDocument[]) => {
    for (const doc of docs) this.artists.set(doc.id, doc);
  });
  /** Case-insensitive substring match on title — enough to prove retrievability. */
  searchAlbumsByTitle(q: string): AlbumSearchDocument[] {
    const needle = q.toLowerCase();
    return [...this.albums.values()].filter((a) =>
      a.title.toLowerCase().includes(needle),
    );
  }
}

function fakePrisma(albums: DbAlbum[]): PrismaService {
  const client = {
    album: {
      findUnique: vi.fn(async ({ where }: { where: { spotifyId: string } }) => {
        return albums.find((a) => a.spotifyId === where.spotifyId) ?? null;
      }),
      findMany: vi.fn(
        async ({ cursor }: { cursor?: { id: string } } = {}) => {
          // Single-batch fake: return everything once, then nothing on the
          // cursor-follow call so the pager terminates.
          return cursor ? [] : albums;
        },
      ),
    },
    artist: {
      findMany: vi.fn(async ({ cursor }: { cursor?: { id: string } } = {}) => {
        if (cursor) return [];
        const seen = new Map<string, DbAlbum["primaryArtist"]>();
        for (const a of albums) seen.set(a.primaryArtist.id, a.primaryArtist);
        return [...seen.values()];
      }),
    },
  };
  return { client } as unknown as PrismaService;
}

function dbAlbum(overrides: Partial<DbAlbum> = {}): DbAlbum {
  return {
    id: "album-1",
    spotifyId: "sp-1",
    mbid: null,
    title: "OK Computer",
    releaseDate: new Date("1997-05-21"),
    coverUrl: null,
    popularityScore: 90,
    primaryArtist: {
      id: "artist-1",
      spotifyId: "sp-artist-1",
      mbid: null,
      name: "Radiohead",
      imageUrl: null,
    },
    genres: [{ genre: { slug: "alternative-rock", name: "Alternative Rock" } }],
    ...overrides,
  };
}

describe("SearchSyncService", () => {
  let meili: FakeMeili;

  beforeEach(() => {
    meili = new FakeMeili();
  });

  it("syncs an album and makes it retrievable by title (task 7.6)", async () => {
    const album = dbAlbum();
    const service = new SearchSyncService(
      fakePrisma([album]),
      meili as unknown as MeiliService,
    );

    // Before sync: nothing indexed, title search finds nothing.
    expect(meili.searchAlbumsByTitle("OK Computer")).toHaveLength(0);

    const result = await service.syncAlbum("sp-1");

    expect(result).toEqual({ status: "synced" });
    // After sync: the freshly-imported album is retrievable by its title.
    const hits = meili.searchAlbumsByTitle("computer");
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("album-1");
    expect(hits[0].primaryArtistName).toBe("Radiohead");
    expect(hits[0].genreNames).toEqual(["Alternative Rock"]);
    expect(hits[0].genreSlugs).toEqual(["alternative-rock"]);
    expect(hits[0].releaseYear).toBe(1997);
  });

  it("indexes the album's primary artist alongside the album", async () => {
    const service = new SearchSyncService(
      fakePrisma([dbAlbum()]),
      meili as unknown as MeiliService,
    );

    await service.syncAlbum("sp-1");

    expect(meili.artists.get("artist-1")).toMatchObject({
      id: "artist-1",
      name: "Radiohead",
    });
  });

  it("returns album-missing (not an error) and indexes nothing when the album is gone", async () => {
    const service = new SearchSyncService(
      fakePrisma([]),
      meili as unknown as MeiliService,
    );

    const result = await service.syncAlbum("does-not-exist");

    expect(result).toEqual({ status: "album-missing" });
    expect(meili.indexAlbums).not.toHaveBeenCalled();
    expect(meili.indexArtists).not.toHaveBeenCalled();
  });

  it("reindexAll configures + clears the index, then re-projects every album and artist", async () => {
    const albums = [
      dbAlbum(),
      dbAlbum({
        id: "album-2",
        spotifyId: "sp-2",
        title: "Kid A",
        // Same primary artist → deduped to a single artist document.
      }),
    ];
    const service = new SearchSyncService(
      fakePrisma(albums),
      meili as unknown as MeiliService,
    );

    const result = await service.reindexAll();

    expect(meili.configured).toBe(true);
    expect(meili.cleared).toBe(true);
    expect(result).toEqual({ albums: 2, artists: 1 });
    expect(meili.searchAlbumsByTitle("Kid A")).toHaveLength(1);
  });
});
