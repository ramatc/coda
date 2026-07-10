import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@coda/db";
import { MusicBrainzEnrichService } from "../src/catalog-import/musicbrainz-enrich.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";
import type { MusicBrainzClient } from "../src/catalog-import/musicbrainz.client.js";
import type { MusicBrainzEnrichment } from "../src/catalog-import/musicbrainz.types.js";

interface AlbumRow {
  id: string;
  spotifyId: string;
  title: string;
  mbid: string | null;
  primaryArtistId: string;
}
interface ArtistRow {
  id: string;
  name: string;
  mbid: string | null;
}

/**
 * In-memory Prisma stand-in honouring the exact reads/writes
 * {@link MusicBrainzEnrichService.enrichAlbum} performs — album lookup by unique
 * `spotifyId`, then the enrichment transaction (album/artist mbid update, genre
 * upsert by unique `slug`, album-genre upsert by composite key). Enforces the
 * `Album.mbid`/`Artist.mbid` UNIQUE constraint so an mbid collision surfaces as a
 * real P2002 — matching the PR5 fake-Prisma convention (assert against real
 * error shapes, never fabricated ones). Counters prove no duplicate genre links.
 */
function createFakeEnrichPrisma() {
  const albums = new Map<string, AlbumRow>();
  const artists = new Map<string, ArtistRow>();
  const genresBySlug = new Map<string, { id: string; name: string }>();
  const albumGenres = new Map<string, { weight: number }>();
  let genreSeq = 0;
  let genreCreates = 0;
  let albumGenreCreates = 0;

  function assertMbidFree(
    table: Map<string, { id: string; mbid: string | null }>,
    id: string,
    mbid: string,
  ): void {
    for (const row of table.values()) {
      if (row.mbid === mbid && row.id !== id) {
        throw new Prisma.PrismaClientKnownRequestError("mbid already claimed", {
          code: "P2002",
          clientVersion: "test",
        });
      }
    }
  }

  const client = {
    async $transaction<T>(fn: (tx: typeof client) => Promise<T>): Promise<T> {
      return fn(client);
    },
    album: {
      async findUnique(args: {
        where: { spotifyId: string };
      }): Promise<{
        id: string;
        title: string;
        primaryArtist: { id: string; name: string };
      } | null> {
        const row = albums.get(args.where.spotifyId);
        if (!row) return null;
        const artist = [...artists.values()].find(
          (a) => a.id === row.primaryArtistId,
        )!;
        return {
          id: row.id,
          title: row.title,
          primaryArtist: { id: artist.id, name: artist.name },
        };
      },
      async update(args: {
        where: { id: string };
        data: { mbid: string };
      }): Promise<void> {
        const row = [...albums.values()].find((a) => a.id === args.where.id)!;
        assertMbidFree(albums, row.id, args.data.mbid);
        row.mbid = args.data.mbid;
      },
    },
    artist: {
      async update(args: {
        where: { id: string };
        data: { mbid: string };
      }): Promise<void> {
        const row = artists.get(args.where.id)!;
        assertMbidFree(artists, row.id, args.data.mbid);
        row.mbid = args.data.mbid;
      },
    },
    genre: {
      async upsert(args: {
        where: { slug: string };
        create: { slug: string; name: string };
      }): Promise<{ id: string }> {
        const existing = genresBySlug.get(args.where.slug);
        if (existing) return { id: existing.id };
        genreCreates += 1;
        const row = { id: `genre_${++genreSeq}`, name: args.create.name };
        genresBySlug.set(args.where.slug, row);
        return { id: row.id };
      },
    },
    albumGenre: {
      async upsert(args: {
        where: { albumId_genreId: { albumId: string; genreId: string } };
        create: { albumId: string; genreId: string; weight: number };
        update: { weight: number };
      }): Promise<void> {
        const key = `${args.where.albumId_genreId.albumId}:${args.where.albumId_genreId.genreId}`;
        const existing = albumGenres.get(key);
        if (existing) {
          existing.weight = args.update.weight;
          return;
        }
        albumGenreCreates += 1;
        albumGenres.set(key, { weight: args.create.weight });
      },
    },
  };

  // Seed a small catalog (as PR5's Spotify leg would have): albums + artists,
  // all lacking an mbid until enrichment fills it in.
  function seedAlbum(spotifyId: string, title: string, artistName: string): void {
    const artistId = `artist_${spotifyId}`;
    artists.set(artistId, { id: artistId, name: artistName, mbid: null });
    albums.set(spotifyId, {
      id: `album_${spotifyId}`,
      spotifyId,
      title,
      mbid: null,
      primaryArtistId: artistId,
    });
  }

  return {
    client,
    seedAlbum,
    albums,
    artists,
    albumGenres,
    genresBySlug,
    get counts() {
      return { genreCreates, albumGenreCreates };
    },
  };
}

function enrichment(
  mbid: string,
  overrides: Partial<MusicBrainzEnrichment> = {},
): MusicBrainzEnrichment {
  return {
    mbid,
    artist: { mbid: `art-${mbid}`, name: "Radiohead" },
    genres: [{ slug: "alternative-rock", name: "Alternative Rock", weight: 10 }],
    ...overrides,
  };
}

describe("MusicBrainzEnrichService", () => {
  let fake: ReturnType<typeof createFakeEnrichPrisma>;
  let mb: { lookupAlbum: ReturnType<typeof vi.fn> };
  let service: MusicBrainzEnrichService;

  beforeEach(() => {
    fake = createFakeEnrichPrisma();
    mb = { lookupAlbum: vi.fn() };
    service = new MusicBrainzEnrichService(
      { client: fake.client } as unknown as PrismaService,
      mb as unknown as MusicBrainzClient,
    );
  });

  // Task 6.5 (sandbox-scoped): the full ~100k staging run can't execute here
  // (no live MusicBrainz/Postgres/Redis), so this proves the enrichment logic is
  // correct at small scale — a handful of seeded albums enriched end to end.
  it("enriches a small batch of seeded albums with mbid + genres by mbid", async () => {
    fake.seedAlbum("sp1", "OK Computer", "Radiohead");
    fake.seedAlbum("sp2", "In Rainbows", "Radiohead");
    fake.seedAlbum("sp3", "Kid A", "Radiohead");
    mb.lookupAlbum
      .mockResolvedValueOnce(enrichment("rg-1"))
      .mockResolvedValueOnce(
        enrichment("rg-2", {
          genres: [
            { slug: "alternative-rock", name: "Alternative Rock", weight: 8 },
            { slug: "art-rock", name: "Art Rock", weight: 4 },
          ],
        }),
      )
      .mockResolvedValueOnce(enrichment("rg-3"));

    const results = await Promise.all([
      service.enrichAlbum("sp1"),
      service.enrichAlbum("sp2"),
      service.enrichAlbum("sp3"),
    ]);

    expect(results.map((r) => r.status)).toEqual([
      "enriched",
      "enriched",
      "enriched",
    ]);
    expect(fake.albums.get("sp1")?.mbid).toBe("rg-1");
    expect(fake.albums.get("sp2")?.mbid).toBe("rg-2");
    expect(fake.albums.get("sp3")?.mbid).toBe("rg-3");
    // Artist mbid set from the credited MusicBrainz artist.
    expect(fake.artists.get("artist_sp1")?.mbid).toBe("art-rg-1");
    // "alternative-rock" appears across three albums but is a SINGLE Genre row
    // (upsert by slug), while "art-rock" adds one more → 2 distinct genres.
    expect(fake.counts.genreCreates).toBe(2);
    // 1 + 2 + 1 = 4 album-genre links, all distinct.
    expect(fake.counts.albumGenreCreates).toBe(4);
  });

  it("is idempotent: re-enriching the same album re-writes the same mbid and adds no duplicate genre links", async () => {
    fake.seedAlbum("sp1", "OK Computer", "Radiohead");
    mb.lookupAlbum.mockResolvedValue(enrichment("rg-1"));

    await service.enrichAlbum("sp1");
    await service.enrichAlbum("sp1");

    expect(fake.albums.get("sp1")?.mbid).toBe("rg-1");
    expect(fake.counts.genreCreates).toBe(1);
    expect(fake.counts.albumGenreCreates).toBe(1);
  });

  it("returns no-match and writes nothing when MusicBrainz has no candidate", async () => {
    fake.seedAlbum("sp1", "Obscure", "Nobody");
    mb.lookupAlbum.mockResolvedValue(null);

    const result = await service.enrichAlbum("sp1");

    expect(result).toEqual({ status: "no-match" });
    expect(fake.albums.get("sp1")?.mbid).toBeNull();
    expect(fake.counts.albumGenreCreates).toBe(0);
  });

  it("returns album-missing without calling MusicBrainz when the album no longer exists", async () => {
    const result = await service.enrichAlbum("ghost");

    expect(result).toEqual({ status: "album-missing" });
    expect(mb.lookupAlbum).not.toHaveBeenCalled();
  });

  it("propagates a P2002 when the resolved mbid is already claimed by another album (caller isolates it)", async () => {
    fake.seedAlbum("sp1", "Edition A", "Radiohead");
    fake.seedAlbum("sp2", "Edition B", "Radiohead");
    // Both editions resolve to the SAME release-group mbid — the second update
    // must hit the unique constraint rather than silently overwriting.
    mb.lookupAlbum.mockResolvedValue(enrichment("rg-shared"));

    await service.enrichAlbum("sp1");
    await expect(service.enrichAlbum("sp2")).rejects.toMatchObject({
      code: "P2002",
    });
  });
});
