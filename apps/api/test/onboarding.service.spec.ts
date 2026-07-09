import { beforeEach, describe, expect, it } from "vitest";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@coda/db";
import { OnboardingService } from "../src/onboarding/onboarding.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

/** UUID-shaped fixture ids: `artistIds`/`albumIds` are now validated as UUIDs
 * before ever reaching the (fake) Prisma client. */
const ARTIST_1_ID = "11111111-1111-4111-8111-111111111111";
const ARTIST_2_ID = "22222222-2222-4222-8222-222222222222";
const ALBUM_1_ID = "33333333-3333-4333-8333-333333333333";
const ALBUM_2_ID = "44444444-4444-4444-8444-444444444444";
const ARTIST_GHOST_ID = "99999999-9999-4999-8999-999999999999";

/**
 * P2002 built with the REAL `@prisma/adapter-pg` driver-adapter error shape
 * (fields live on `meta.driverAdapterError.cause.constraint.fields`, NOT the
 * classic `meta.target` this client never populates — Decision #14, reused
 * from `profile.service.spec.ts` / `clerk-webhook.service.spec.ts`).
 */
function artistFavoriteConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`userId`,`artistId`)",
    {
      code: "P2002",
      clientVersion: "test",
      meta: {
        driverAdapterError: {
          cause: {
            kind: "UniqueConstraintViolation",
            constraint: { fields: ["userId", "artistId"] },
          },
        },
      },
    },
  );
}

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
  /** Test-only trigger: makes the NEXT `userArtistFavorite.createMany` throw a
   * P2002, simulating a concurrent/overlapping submission racing this one. */
  triggerArtistConflictOnce: () => void;
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
  let forceArtistConflict = false;

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
        if (forceArtistConflict) {
          forceArtistConflict = false;
          throw artistFavoriteConflict();
        }
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
    triggerArtistConflictOnce: () => {
      forceArtistConflict = true;
    },
  };
}

describe("OnboardingService", () => {
  let service: OnboardingService;
  let fake: ReturnType<typeof createFakePrisma>;

  beforeEach(() => {
    fake = createFakePrisma();
    fake.users.set("clerk_1", "local_1");
    fake.artists.set(ARTIST_1_ID, { id: ARTIST_1_ID, name: "Radiohead" });
    fake.artists.set(ARTIST_2_ID, { id: ARTIST_2_ID, name: "Portishead" });
    fake.albums.set(ALBUM_1_ID, { id: ALBUM_1_ID, title: "OK Computer" });
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
      artistIds: [ARTIST_1_ID],
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
    fake.albums.set(ALBUM_2_ID, { id: ALBUM_2_ID, title: "In Rainbows" });

    const status = await service.complete("clerk_1", {
      genreSlugs: ["rock", "jazz", "electronic"],
      artistIds: [ARTIST_1_ID],
      albumIds: [ALBUM_1_ID, ALBUM_2_ID],
    });

    expect(status.albumCount).toBe(2);
  });

  it("blocks completion with fewer than 3 genres and writes nothing", async () => {
    await expect(
      service.complete("clerk_1", {
        genreSlugs: ["rock", "jazz"],
        artistIds: [ARTIST_1_ID],
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
        artistIds: [ARTIST_1_ID],
        albumIds: [
          "10000000-0000-4000-8000-000000000001",
          "10000000-0000-4000-8000-000000000002",
          "10000000-0000-4000-8000-000000000003",
          "10000000-0000-4000-8000-000000000004",
          "10000000-0000-4000-8000-000000000005",
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects more than MAX_ARTISTS favorite artists", async () => {
    const tooManyArtistIds = Array.from(
      { length: 21 },
      (_, i) => `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    await expect(
      service.complete("clerk_1", {
        genreSlugs: ["rock", "jazz", "electronic"],
        artistIds: tooManyArtistIds,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("accepts a raw artistIds array with duplicates that dedupes to at most MAX_ARTISTS unique ids", async () => {
    // 25 raw ids, 10 of them repeats of the first 10 → 15 unique ids, which
    // is within MAX_ARTISTS (20). The catalog only needs to know about the
    // ids that are actually unique/present; unknown ones are seeded here so
    // the request succeeds end-to-end and proves the *cap* check (not the
    // catalog-existence check) is what's under test.
    const uniqueArtistIds = Array.from(
      { length: 15 },
      (_, i) => `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    for (const id of uniqueArtistIds) {
      fake.artists.set(id, { id, name: `Artist ${id}` });
    }
    const duplicatedRawArtistIds = [...uniqueArtistIds, ...uniqueArtistIds.slice(0, 10)];
    expect(duplicatedRawArtistIds.length).toBe(25);

    const status = await service.complete("clerk_1", {
      genreSlugs: ["rock", "jazz", "electronic"],
      artistIds: duplicatedRawArtistIds,
    });

    expect(status.artistCount).toBe(15);
    expect(fake.artistFavs.size).toBe(15);
  });

  it("rejects an unknown genre slug", async () => {
    await expect(
      service.complete("clerk_1", {
        genreSlugs: ["rock", "jazz", "not-a-genre"],
        artistIds: [ARTIST_1_ID],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a favorite artist that is not in the catalog", async () => {
    await expect(
      service.complete("clerk_1", {
        genreSlugs: ["rock", "jazz", "electronic"],
        artistIds: [ARTIST_GHOST_ID],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Nothing persisted — the transaction rolled back the genre upserts too.
    expect(fake.genrePrefs.size).toBe(0);
  });

  it("rejects a malformed (non-UUID) artist id before querying the catalog", async () => {
    await expect(
      service.complete("clerk_1", {
        genreSlugs: ["rock", "jazz", "electronic"],
        artistIds: ["not-a-uuid"],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fake.genrePrefs.size).toBe(0);
  });

  it("rejects a malformed (non-UUID) album id before querying the catalog", async () => {
    await expect(
      service.complete("clerk_1", {
        genreSlugs: ["rock", "jazz", "electronic"],
        artistIds: [ARTIST_1_ID],
        albumIds: ["also-not-a-uuid"],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fake.genrePrefs.size).toBe(0);
  });

  it("returns a clean, retryable conflict on a concurrent P2002 instead of a raw 500", async () => {
    fake.triggerArtistConflictOnce();
    await expect(
      service.complete("clerk_1", {
        genreSlugs: ["rock", "jazz", "electronic"],
        artistIds: [ARTIST_1_ID],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    // The transaction rolled back — nothing partially persisted.
    expect(fake.genrePrefs.size).toBe(0);
    expect(fake.artistFavs.size).toBe(0);
  });

  it("is idempotent: re-submitting replaces prior selections", async () => {
    await service.complete("clerk_1", {
      genreSlugs: ["rock", "jazz", "electronic"],
      artistIds: [ARTIST_1_ID],
    });
    const status = await service.complete("clerk_1", {
      genreSlugs: ["pop", "metal", "folk"],
      artistIds: [ARTIST_1_ID, ARTIST_2_ID],
    });

    expect(status.genreCount).toBe(3);
    expect(status.artistCount).toBe(2);
    expect(fake.genrePrefs.size).toBe(3);
  });

  it("de-duplicates repeated slugs before counting the minimum", async () => {
    await expect(
      service.complete("clerk_1", {
        genreSlugs: ["rock", "rock", "rock"],
        artistIds: [ARTIST_1_ID],
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
