import { beforeEach, describe, expect, it } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { OnboardingService } from "../src/onboarding/onboarding.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

/**
 * In-memory Prisma stand-in honouring the exact query shapes OnboardingService
 * uses, so preference capture + the completion gate are proven deterministically
 * without a live Postgres — matching the PR1-3 no-docker sandbox convention.
 *
 * The genre catalog is upserted by slug (self-provided taxonomy), while artists
 * and albums must reference pre-seeded catalog rows. Composite-PK preference
 * tables are keyed `${userId}:${refId}` to mirror the real `@@id([userId, …])`.
 */
interface Ref {
  id: string;
  name?: string;
  title?: string;
  imageUrl?: string | null;
  coverUrl?: string | null;
  primaryArtistName?: string;
}

interface GenreRow {
  id: string;
  slug: string;
  name: string;
}

function createFakePrisma(): {
  service: PrismaService;
  users: Map<string, string>; // clerkUserId -> local id
  artists: Map<string, Ref>;
  albums: Map<string, Ref>;
  genres: Map<string, GenreRow>; // slug -> row
  genrePrefs: Map<string, { userId: string; genreId: string }>;
  artistFavs: Map<string, { userId: string; artistId: string; rank: number }>;
  albumFavs: Map<string, { userId: string; albumId: string; rank: number }>;
} {
  const users = new Map<string, string>();
  const artists = new Map<string, Ref>();
  const albums = new Map<string, Ref>();
  const genres = new Map<string, GenreRow>();
  const genrePrefs = new Map<string, { userId: string; genreId: string }>();
  const artistFavs = new Map<
    string,
    { userId: string; artistId: string; rank: number }
  >();
  const albumFavs = new Map<
    string,
    { userId: string; albumId: string; rank: number }
  >();
  let genreSeq = 0;

  const client = {
    async $transaction<T>(fn: (tx: typeof client) => Promise<T>): Promise<T> {
      // Snapshot-and-restore models Postgres rollback: a throw mid-callback
      // undoes any writes already applied, so a validation failure leaves NO
      // partial preferences behind.
      const snapshots = [genrePrefs, artistFavs, albumFavs, genres].map(
        (map) => new Map([...map].map(([k, v]) => [k, { ...v }])),
      );
      try {
        return await fn(client);
      } catch (err) {
        [genrePrefs, artistFavs, albumFavs, genres].forEach((map, index) => {
          map.clear();
          for (const [k, v] of snapshots[index]) {
            (map as Map<string, unknown>).set(k, v);
          }
        });
        throw err;
      }
    },
    user: {
      async findUnique(args: {
        where: { clerkUserId: string };
      }): Promise<{ id: string } | null> {
        const id = users.get(args.where.clerkUserId);
        return id ? { id } : null;
      },
    },
    genre: {
      async upsert(args: {
        where: { slug: string };
        create: { slug: string; name: string };
      }): Promise<{ id: string }> {
        const existing = genres.get(args.where.slug);
        if (existing) {
          return { id: existing.id };
        }
        const row: GenreRow = {
          id: `genre_${++genreSeq}`,
          slug: args.create.slug,
          name: args.create.name,
        };
        genres.set(row.slug, row);
        return { id: row.id };
      },
    },
    artist: {
      async findMany(args: {
        where: { id?: { in: string[] }; name?: { contains: string } };
      }): Promise<Ref[]> {
        if (args.where.id) {
          return args.where.id.in
            .filter((id) => artists.has(id))
            .map((id) => ({ id, name: artists.get(id)?.name }));
        }
        const needle = args.where.name?.contains.toLowerCase() ?? "";
        return [...artists.values()].filter((a) =>
          (a.name ?? "").toLowerCase().includes(needle),
        );
      },
    },
    album: {
      async findMany(args: {
        where: { id?: { in: string[] }; title?: { contains: string } };
      }): Promise<Ref[]> {
        if (args.where.id) {
          return args.where.id.in
            .filter((id) => albums.has(id))
            .map((id) => ({ id }));
        }
        const needle = args.where.title?.contains.toLowerCase() ?? "";
        return [...albums.values()]
          .filter((a) => (a.title ?? "").toLowerCase().includes(needle))
          .map((a) => ({
            ...a,
            primaryArtist: { name: a.primaryArtistName ?? "Unknown" },
          }));
      },
    },
    userGenrePreference: {
      async count(args: { where: { userId: string } }): Promise<number> {
        return [...genrePrefs.values()].filter(
          (r) => r.userId === args.where.userId,
        ).length;
      },
      async deleteMany(args: {
        where: { userId: string };
      }): Promise<{ count: number }> {
        let count = 0;
        for (const [k, v] of genrePrefs) {
          if (v.userId === args.where.userId) {
            genrePrefs.delete(k);
            count += 1;
          }
        }
        return { count };
      },
      async createMany(args: {
        data: { userId: string; genreId: string }[];
      }): Promise<{ count: number }> {
        for (const row of args.data) {
          genrePrefs.set(`${row.userId}:${row.genreId}`, row);
        }
        return { count: args.data.length };
      },
    },
    userArtistFavorite: {
      async count(args: { where: { userId: string } }): Promise<number> {
        return [...artistFavs.values()].filter(
          (r) => r.userId === args.where.userId,
        ).length;
      },
      async deleteMany(args: {
        where: { userId: string };
      }): Promise<{ count: number }> {
        let count = 0;
        for (const [k, v] of artistFavs) {
          if (v.userId === args.where.userId) {
            artistFavs.delete(k);
            count += 1;
          }
        }
        return { count };
      },
      async createMany(args: {
        data: { userId: string; artistId: string; rank: number }[];
      }): Promise<{ count: number }> {
        for (const row of args.data) {
          artistFavs.set(`${row.userId}:${row.artistId}`, row);
        }
        return { count: args.data.length };
      },
    },
    userAlbumFavorite: {
      async count(args: { where: { userId: string } }): Promise<number> {
        return [...albumFavs.values()].filter(
          (r) => r.userId === args.where.userId,
        ).length;
      },
      async deleteMany(args: {
        where: { userId: string };
      }): Promise<{ count: number }> {
        let count = 0;
        for (const [k, v] of albumFavs) {
          if (v.userId === args.where.userId) {
            albumFavs.delete(k);
            count += 1;
          }
        }
        return { count };
      },
      async createMany(args: {
        data: { userId: string; albumId: string; rank: number }[];
      }): Promise<{ count: number }> {
        for (const row of args.data) {
          albumFavs.set(`${row.userId}:${row.albumId}`, row);
        }
        return { count: args.data.length };
      },
    },
  };

  return {
    service: { client } as unknown as PrismaService,
    users,
    artists,
    albums,
    genres,
    genrePrefs,
    artistFavs,
    albumFavs,
  };
}

describe("OnboardingService", () => {
  let service: OnboardingService;
  let fake: ReturnType<typeof createFakePrisma>;

  beforeEach(() => {
    fake = createFakePrisma();
    fake.users.set("clerk_1", "local_1");
    fake.artists.set("artist_1", { id: "artist_1", name: "Radiohead" });
    fake.artists.set("artist_2", { id: "artist_2", name: "Portishead" });
    fake.albums.set("album_1", { id: "album_1", title: "OK Computer" });
    service = new OnboardingService(fake.service);
  });

  it("serves the fixed genre taxonomy", () => {
    const genres = service.listGenres();
    expect(genres.length).toBeGreaterThanOrEqual(3);
    expect(genres.map((g) => g.slug)).toContain("rock");
  });

  it("reports incomplete for a fresh user", async () => {
    const status = await service.getStatus("clerk_1");
    expect(status).toEqual({
      complete: false,
      genreCount: 0,
      artistCount: 0,
      albumCount: 0,
    });
  });

  it("persists sufficient selections and marks onboarding complete", async () => {
    const status = await service.complete("clerk_1", {
      genreSlugs: ["rock", "jazz", "electronic"],
      artistIds: ["artist_1"],
    });

    expect(status.complete).toBe(true);
    expect(status.genreCount).toBe(3);
    expect(status.artistCount).toBe(1);
    // Genres were upserted into the catalog by slug (empty-catalog safe).
    expect(fake.genres.has("rock")).toBe(true);
    expect(fake.genrePrefs.size).toBe(3);
    expect(fake.artistFavs.size).toBe(1);
  });

  it("accepts up to 4 optional albums", async () => {
    fake.albums.set("album_2", { id: "album_2", title: "In Rainbows" });

    const status = await service.complete("clerk_1", {
      genreSlugs: ["rock", "jazz", "electronic"],
      artistIds: ["artist_1"],
      albumIds: ["album_1", "album_2"],
    });

    expect(status.albumCount).toBe(2);
  });

  it("blocks completion with fewer than 3 genres and writes nothing", async () => {
    await expect(
      service.complete("clerk_1", {
        genreSlugs: ["rock", "jazz"],
        artistIds: ["artist_1"],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fake.genrePrefs.size).toBe(0);
    expect(fake.artistFavs.size).toBe(0);
    const status = await service.getStatus("clerk_1");
    expect(status.complete).toBe(false);
  });

  it("blocks completion with no artist", async () => {
    await expect(
      service.complete("clerk_1", {
        genreSlugs: ["rock", "jazz", "electronic"],
        artistIds: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fake.genrePrefs.size).toBe(0);
  });

  it("rejects more than 4 albums", async () => {
    await expect(
      service.complete("clerk_1", {
        genreSlugs: ["rock", "jazz", "electronic"],
        artistIds: ["artist_1"],
        albumIds: ["a1", "a2", "a3", "a4", "a5"],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects an unknown genre slug", async () => {
    await expect(
      service.complete("clerk_1", {
        genreSlugs: ["rock", "jazz", "not-a-genre"],
        artistIds: ["artist_1"],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a favorite artist that is not in the catalog", async () => {
    await expect(
      service.complete("clerk_1", {
        genreSlugs: ["rock", "jazz", "electronic"],
        artistIds: ["artist_ghost"],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Nothing persisted — the transaction rolled back the genre upserts too.
    expect(fake.genrePrefs.size).toBe(0);
  });

  it("is idempotent: re-submitting replaces prior selections", async () => {
    await service.complete("clerk_1", {
      genreSlugs: ["rock", "jazz", "electronic"],
      artistIds: ["artist_1"],
    });
    const status = await service.complete("clerk_1", {
      genreSlugs: ["pop", "metal", "folk"],
      artistIds: ["artist_1", "artist_2"],
    });

    expect(status.genreCount).toBe(3);
    expect(status.artistCount).toBe(2);
    expect(fake.genrePrefs.size).toBe(3);
  });

  it("de-duplicates repeated slugs before counting the minimum", async () => {
    await expect(
      service.complete("clerk_1", {
        genreSlugs: ["rock", "rock", "rock"],
        artistIds: ["artist_1"],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("throws NotFound when the session has no local user", async () => {
    await expect(service.getStatus("clerk_missing")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("returns an empty artist search gracefully (empty catalog / blank query)", async () => {
    expect(await service.searchArtists("   ")).toEqual([]);
    expect(await service.searchAlbums("nothing-here")).toEqual([]);
  });
});
